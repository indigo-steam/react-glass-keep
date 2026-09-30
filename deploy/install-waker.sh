#!/usr/bin/env bash
# Instala/actualiza el servicio hermes-waker (proceso del host con systemd).
# El waker permite que la app arranque/apague las instancias Hermes por usuario
# sin exponer el socket de Docker (solo start/stop/config de hermes-u<id>).
#
# Uso:  ./install-waker.sh
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CURRENT_USER="${SUDO_USER:-$(id -un)}"
WAKER_ENV="/home/$CURRENT_USER/hermes-waker.env"

if [ "$(id -u)" -eq 0 ]; then
  echo "No lo ejecutes como root: usá tu usuario (con sudo disponible)."
  exit 1
fi

echo "==> Copiando servicio a /opt/hermes-waker"
sudo mkdir -p /opt/hermes-waker
sudo cp "$DIR/hermes-waker/hermes-waker.py" /opt/hermes-waker/
sudo cp "$DIR/hermes-waker/hermes-waker.service" /etc/systemd/system/

if [ ! -f "$WAKER_ENV" ]; then
  echo "==> Generando token del waker"
  umask 077
  printf 'WAKER_TOKEN=%s\n' "$(openssl rand -hex 24)" > "$WAKER_ENV"
  printf 'WAKER_HOST=0.0.0.0\nWAKER_PORT=8099\n' >> "$WAKER_ENV"
else
  echo "==> $WAKER_ENV ya existe (se conserva el token)"
fi

sudo chown "$CURRENT_USER":"$CURRENT_USER" "$WAKER_ENV"
sudo chmod 600 "$WAKER_ENV"
sudo systemctl daemon-reload
sudo systemctl enable --now hermes-waker >/dev/null 2>&1 || true
sudo systemctl restart hermes-waker
sleep 1
echo -n "==> Estado del servicio: "
systemctl is-active hermes-waker

# Si hay firewall (ufw), permitir que la app (red indigo-assistant) hable con el waker
if command -v ufw >/dev/null 2>&1 && sudo ufw status | grep -q "Status: active"; then
  APP_SUBNET="$(docker network inspect indigo-assistant -f '{{range .IPAM.Config}}{{.Subnet}}{{end}}' 2>/dev/null || true)"
  if [ -n "$APP_SUBNET" ]; then
    sudo ufw allow from "$APP_SUBNET" to any port 8099 proto tcp comment "hermes-waker (app)" >/dev/null 2>&1 || true
    echo "==> ufw: permitido el puerto 8099 desde $APP_SUBNET"
  else
    echo "==> Aviso: no encontré la red 'indigo-assistant'; si usás ufw, permití el 8099 desde la subred de la app."
  fi
fi

echo
echo "WAKER_TOKEN (ponelo como HERMES_WAKER_TOKEN en el env-file de la app):"
grep ^WAKER_TOKEN= "$WAKER_ENV" | cut -d= -f2
echo "Listo ✅"
