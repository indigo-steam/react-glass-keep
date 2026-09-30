#!/usr/bin/env bash
# Guarda (cifrada) la API key del API server de Hermes en el vault de la app,
# para que /api/assistant/chat pueda hablar con la instancia del usuario.
# Se ejecuta en el host donde corren los contenedores.
#
# Uso:  ./store-hermes-key.sh <USER_ID> [APP_CONTAINER]
set -euo pipefail

USER_ID="${1:?uso: $0 <USER_ID> [APP_CONTAINER]}"
APP_CONTAINER="${2:-indigo-notes}"
INSTANCE_CONTAINER="hermes-u$USER_ID"

[[ "$USER_ID" =~ ^[0-9]+$ ]] || { echo "USER_ID debe ser numérico"; exit 1; }

HK="$(docker exec "$INSTANCE_CONTAINER" cat /opt/data/.api_server_key 2>/dev/null || true)"
[ -n "$HK" ] || { echo "No encontré /opt/data/.api_server_key en $INSTANCE_CONTAINER"; exit 1; }

docker exec -i -e HK="$HK" -e TARGET_USER_ID="$USER_ID" "$APP_CONTAINER" node - <<'NODE'
const crypto = require("crypto");
const Database = require("better-sqlite3");

if (!process.env.SECRETS_MASTER_KEY) {
  console.error("SECRETS_MASTER_KEY no está configurada en el contenedor de la app.");
  process.exit(1);
}
const userId = Number(process.env.TARGET_USER_ID);
const db = new Database(process.env.DB_FILE || "/app/data/notes.db");

// Asegura que exista la fila en el vault
db.prepare(
  `INSERT INTO user_secrets (user_id, created_at, updated_at)
   VALUES (?, ?, ?)
   ON CONFLICT(user_id) DO NOTHING`
).run(userId, new Date().toISOString(), new Date().toISOString());

const master = Buffer.from(process.env.SECRETS_MASTER_KEY, "base64");
const iv = crypto.randomBytes(12);
const cipher = crypto.createCipheriv("aes-256-gcm", master, iv);
const enc = Buffer.concat([cipher.update(process.env.HK, "utf8"), cipher.final()]);
const payload = [iv.toString("base64"), cipher.getAuthTag().toString("base64"), enc.toString("base64")].join(".");

const result = db
  .prepare("UPDATE user_secrets SET hermes_key_enc = ?, updated_at = ? WHERE user_id = ?")
  .run(payload, new Date().toISOString(), userId);

console.log(result.changes > 0 ? `hermes_key_enc guardada para el usuario ${userId}` : `usuario ${userId} no encontrado en user_secrets`);
NODE

echo "Listo ✅ — el asistente de ese usuario ya puede hablar con su Hermes."
