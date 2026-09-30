#!/usr/bin/env python3
"""Hermes Waker — host-side helper that starts/stops per-user Hermes containers.

The notes app (containerized) calls this service over HTTP with a bearer token
whenever a user sends an assistant message. Containers idle-stopped by the app
are started on demand; nothing else from Docker is exposed.

Endpoints (all require `Authorization: Bearer $WAKER_TOKEN`):
  GET  /instances/<id>         -> {"id":1,"name":"hermes-u1","status":"running"}
  POST /instances/<id>/start   -> docker start hermes-u<id>
  POST /instances/<id>/stop    -> docker stop  hermes-u<id>
  POST /instances/<id>/llm     -> apply LLM credentials/model to hermes-u<id>
                                  body: {"provider","api_key","model","base_url"}

Env:
  WAKER_TOKEN                 (required)
  WAKER_HOST                  (default 0.0.0.0; use the docker bridge/gateway IP)
  WAKER_PORT                  (default 8099)
  HERMES_CONTAINER_PREFIX     (default hermes-u)
  HERMES_DATA_DIR             (default /home/ubuntu/hermes-users)
"""

import json
import os
import re
import subprocess
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

PORT = int(os.environ.get("WAKER_PORT", "8099"))
HOST = os.environ.get("WAKER_HOST", "0.0.0.0")
TOKEN = os.environ.get("WAKER_TOKEN", "")
PREFIX = os.environ.get("HERMES_CONTAINER_PREFIX", "hermes-u")
DATA_DIR = os.environ.get("HERMES_DATA_DIR", "/home/ubuntu/hermes-users")

if not TOKEN:
    raise SystemExit("WAKER_TOKEN is required")

SAFE_KEY = re.compile(r"^[A-Za-z0-9_.\-]{8,200}$")
SAFE_MODEL = re.compile(r"^[A-Za-z0-9_.\-:/]{1,120}$")
SAFE_BASE_URL = re.compile(r"^https?://[A-Za-z0-9.\-]+(:\d{1,5})?(/[A-Za-z0-9._\-/]*)?$")
PROVIDERS = {"openrouter", "custom"}


def docker(args, stdin=None):
    return subprocess.run(
        ["docker", *args],
        capture_output=True,
        text=True,
        input=stdin,
        timeout=120,
    )


def status_of(name):
    result = docker(["inspect", "-f", "{{.State.Status}}", name])
    return result.stdout.strip() if result.returncode == 0 else "missing"


def set_env_var(name, var_name, value):
    script = (
        f'V="{value}"; T=$(mktemp); '
        f'grep -v "^{var_name}=" /opt/data/.env > "$T" || true; '
        f'printf "{var_name}=%s\\n" "$V" >> "$T"; '
        f'cat "$T" > /opt/data/.env; rm -f "$T"'
    )
    return docker(["exec", "-i", name, "sh", "-c", script])


def apply_llm(id_str, payload):
    name = f"{PREFIX}{id_str}"
    provider = str(payload.get("provider") or "")
    api_key = str(payload.get("api_key") or "")
    model = str(payload.get("model") or "")
    base_url = str(payload.get("base_url") or "")

    if provider not in PROVIDERS:
        return 400, {"error": "invalid provider"}
    if not SAFE_KEY.match(api_key):
        return 400, {"error": "invalid api_key"}
    if model and not SAFE_MODEL.match(model):
        return 400, {"error": "invalid model"}
    if provider == "custom":
        if not base_url or not SAFE_BASE_URL.match(base_url):
            return 400, {"error": "invalid base_url"}
    else:
        base_url = "https://openrouter.ai/api/v1"

    if status_of(name) == "missing":
        return 404, {"error": f"{name} not found"}

    env_var = "OPENROUTER_API_KEY" if provider == "openrouter" else "OPENAI_API_KEY"
    env_result = set_env_var(name, env_var, api_key)
    if env_result.returncode != 0:
        return 500, {"error": (env_result.stderr or "env write failed").strip()[:300]}
    if provider == "custom":
        base_result = set_env_var(name, "OPENAI_BASE_URL", base_url)
        if base_result.returncode != 0:
            return 500, {"error": (base_result.stderr or "base_url write failed").strip()[:300]}

    for key, value in (
        ("model.provider", provider),
        ("model.base_url", base_url),
    ):
        res = docker(["exec", name, "hermes", "config", "set", key, value])
        if res.returncode != 0:
            return 500, {"error": (res.stderr or res.stdout or f"config set {key} failed").strip()[:300]}
    if model:
        res = docker(["exec", name, "hermes", "config", "set", "model.default", model])
        if res.returncode != 0:
            return 500, {"error": (res.stderr or res.stdout or "config set model.default failed").strip()[:300]}

    docker(["restart", name])
    return 200, {
        "ok": True,
        "id": id_str,
        "name": name,
        "applied": {"provider": provider, "model": model or None, "base_url": base_url},
    }


class Handler(BaseHTTPRequestHandler):
    def _json(self, code, payload):
        body = json.dumps(payload).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        self._handle()

    def do_POST(self):
        self._handle()

    def _read_json(self):
        try:
            length = int(self.headers.get("Content-Length") or 0)
            if length <= 0 or length > 8192:
                return {}
            return json.loads(self.rfile.read(length).decode("utf-8"))
        except Exception:  # noqa: BLE001
            return {}

    def _handle(self):
        if self.headers.get("Authorization") != f"Bearer {TOKEN}":
            return self._json(401, {"error": "unauthorized"})
        match = re.match(r"^/instances/([0-9]{1,6})(?:/(start|stop|llm))?$", self.path)
        if not match:
            return self._json(404, {"error": "not found"})
        instance_id, action = match.group(1), match.group(2)
        name = f"{PREFIX}{instance_id}"
        try:
            if action == "llm":
                code, payload = apply_llm(instance_id, self._read_json())
                return self._json(code, payload)
            if action == "start":
                result = docker(["start", name])
            elif action == "stop":
                result = docker(["stop", "-t", "20", name])
            else:
                return self._json(
                    200, {"id": instance_id, "name": name, "status": status_of(name)}
                )
            if result.returncode != 0:
                detail = (result.stderr or result.stdout).strip()[:300]
                return self._json(500, {"error": detail or "docker error"})
            return self._json(
                200,
                {"ok": True, "id": instance_id, "name": name, "status": status_of(name)},
            )
        except Exception as err:  # noqa: BLE001 - report any failure as JSON
            return self._json(500, {"error": str(err)})

    def log_message(self, fmt, *args):
        print("[hermes-waker]", fmt % args, flush=True)


if __name__ == "__main__":
    print(f"[hermes-waker] listening on {HOST}:{PORT} (prefix {PREFIX})", flush=True)
    ThreadingHTTPServer((HOST, PORT), Handler).serve_forever()
