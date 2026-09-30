#!/usr/bin/env python3
"""Hermes Waker — host-side helper that starts/stops per-user Hermes containers.

The notes app (containerized) calls this service over HTTP with a bearer token
whenever a user sends an assistant message. Containers idle-stopped by the app
are started on demand; nothing else from Docker is exposed.

Endpoints (all require `Authorization: Bearer $WAKER_TOKEN`):
  GET  /instances/<id>         -> {"id":1,"name":"hermes-u1","status":"running"}
  POST /instances/<id>/start   -> docker start hermes-u<id>
  POST /instances/<id>/stop    -> docker stop  hermes-u<id>

Env:
  WAKER_TOKEN                 (required)
  WAKER_HOST                  (default 0.0.0.0; use the docker bridge/gateway IP)
  WAKER_PORT                  (default 8099)
  HERMES_CONTAINER_PREFIX     (default hermes-u)
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

if not TOKEN:
    raise SystemExit("WAKER_TOKEN is required")


def docker(args):
    return subprocess.run(
        ["docker", *args], capture_output=True, text=True, timeout=90
    )


def status_of(name):
    result = docker(["inspect", "-f", "{{.State.Status}}", name])
    return result.stdout.strip() if result.returncode == 0 else "missing"


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

    def _handle(self):
        if self.headers.get("Authorization") != f"Bearer {TOKEN}":
            return self._json(401, {"error": "unauthorized"})
        match = re.match(r"^/instances/([0-9]{1,6})(?:/(start|stop))?$", self.path)
        if not match:
            return self._json(404, {"error": "not found"})
        instance_id, action = match.group(1), match.group(2)
        name = f"{PREFIX}{instance_id}"
        try:
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
