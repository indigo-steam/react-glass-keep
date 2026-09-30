# Indigo Notes MCP

Servidor MCP que expone las notas de Indigo Notes (Glass Keep) a agentes como Hermes/Claude
a través de la **API REST**. Nunca accede a SQLite ni usa tokens de administrador: opera con
la credencial del usuario autenticado.

## Herramientas

| Herramienta | Descripción |
|---|---|
| `search_notes(query?, queries?, tags?[], include_archived?, limit=20)` | Busca notas por texto y/o tags; `queries` es alias de `query` |
| `get_note(id)` | Devuelve una nota completa (incluye archivadas) |
| `list_tags()` | Tags del usuario con conteo, agrupados case-insensitive |
| `get_context(note_id?, query?, max_notes=10)` | Nota focal + notas relacionadas como contexto para el LLM |
| `create_note(title, content?, tags?, type?, items?)` | Crea una nota (texto o checklist) |
| `update_note(id, campos...)` | Actualización parcial (lee antes de escribir) |
| `archive_note(id, archived?)` | Archiva (default) o desarchiva |
| `restore_note(id)` | Restaura una nota de la papelera |
| `delete_note(id, confirm=true)` | Mueve a la papelera (**requiere `confirm`**, nunca borra permanente) |

Las escrituras envían `X-Edited-By: <nombre del agente>` para la auditoría (`lastEditedBy`).

## Configuración

Variables de entorno:

| Variable | Requerida | Descripción |
|---|---|---|
| `GLASSKEEP_URL` | sí | Base de la API, p. ej. `https://notes.indigosteam.com` |
| `GLASSKEEP_API_KEY` | recomendada | API key `gk_...` (creada en la app; scopes read/write) |
| `GLASSKEEP_SECRET_KEY` | alternativa | Secret key del usuario (flujo `POST /api/login/secret`) |
| `GLASSKEEP_TOKEN` | alternativa | JWT directo (útil para desarrollo) |
| `GLASSKEEP_AGENT_NAME` | no | Nombre para la auditoría (default `"Asistente"`) |

Una de las tres credenciales es obligatoria. Con `GLASSKEEP_SECRET_KEY` el MCP cambia la
clave por un JWT y lo reutiliza (reintenta el login una vez si expira); con `GLASSKEEP_API_KEY`
o `GLASSKEEP_TOKEN` se usa directamente como Bearer.

## Uso

```bash
cd mcp
npm install

GLASSKEEP_URL=https://notes.indigosteam.com \
GLASSKEEP_SECRET_KEY=<secret-key> \
node index.js
```

Configuración para un cliente MCP (ej. Hermes / Claude):

```json
{
  "mcpServers": {
    "indigo-notes": {
      "command": "node",
      "args": ["/home/ubuntu/indigo-notes/mcp/index.js"],
      "env": {
        "GLASSKEEP_URL": "https://notes.indigosteam.com",
        "GLASSKEEP_SECRET_KEY": "<secret-key>"
      }
    }
  }
}
```

## Smoke test

Con una instancia de desarrollo corriendo (registro habilitado):

```bash
GLASSKEEP_TEST_URL=http://127.0.0.1:8096 npm run smoke
```

Crea dos usuarios de prueba, siembra notas, verifica las herramientas y el aislamiento
entre usuarios, y limpia los datos que creó.

## Seguridad

- Lectura y escritura limitadas a la API: nada de SQLite.
- La credencial es del usuario dueño de la API key / secret key; jamás un token admin global.
- Las API keys tienen scopes (`read` / `write`) y son revocables desde la app.
- Las operaciones destructivas requieren `confirm: true` y nunca borran de forma permanente.
- Las imágenes embebidas (data URLs) se reemplazan por un marcador para no inflar el contexto.

## Credenciales del asistente (servidor)

El servidor de Indigo Notes puede generar y gestionar una API key `write` para el asistente
integrado (`POST/PUT /api/assistant/credentials`), almacenada cifrada (AES-256-GCM) para
provisionar la instancia Hermes de cada usuario. La UI permite cargar la API key del LLM
(BYOK: OpenRouter o endpoint custom OpenAI-compatible) y rotar credenciales.
