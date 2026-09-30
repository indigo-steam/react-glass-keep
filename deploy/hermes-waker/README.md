# Hermes Waker

Servicio mínimo del host que arranca/apaga los contenedores Hermes por usuario
(`hermes-u<id>`) a pedido del Assistant API. Evita exponer el socket de Docker
a la app: solo permite `start`/`stop`/`status` sobre `hermes-u<id>`.

## Instalación (VPS)

```bash
sudo mkdir -p /opt/hermes-waker
sudo cp deploy/hermes-waker/hermes-waker.py /opt/hermes-waker/
sudo cp deploy/hermes-waker/hermes-waker.service /etc/systemd/system/

# Token + env (una sola vez)
umask 077
printf 'WAKER_TOKEN=%s\n' "$(openssl rand -hex 24)" > ~/hermes-waker.env
printf 'WAKER_HOST=0.0.0.0\nWAKER_PORT=8099\n' >> ~/hermes-waker.env

sudo systemctl daemon-reload
sudo systemctl enable --now hermes-waker
systemctl status hermes-waker --no-pager | head -5
```

## Uso

```bash
TOKEN=$(grep ^WAKER_TOKEN= ~/hermes-waker.env | cut -d= -f2)
curl -s -H "Authorization: Bearer $TOKEN" http://127.0.0.1:8099/instances/1
curl -s -X POST -H "Authorization: Bearer $TOKEN" http://127.0.0.1:8099/instances/1/stop
curl -s -X POST -H "Authorization: Bearer $TOKEN" http://127.0.0.1:8099/instances/1/start
```

La app lo consume con:

- `HERMES_WAKER_URL=http://host.docker.internal:8099` (requiere `--add-host host.docker.internal:host-gateway` al correr el contenedor de la app)
- `HERMES_WAKER_TOKEN=<token>`
- `HERMES_BASE_TEMPLATE=http://hermes-u{id}:8642` (red Docker compartida `indigo-assistant`)
- `ASSISTANT_IDLE_MINUTES=15` (apagado por inactividad)

## Seguridad

- Bearer token obligatorio; sin token responde 401.
- Solo acepta IDs numéricos y opera sobre `hermes-u<id>` (no puede tocar otros contenedores).
- Escucha en el host; exponer solo en la red Docker gateway (no publicar a internet).
