# Indigo Notes MCP (read-only)

Servidor MCP que expone las notas de Indigo Notes (Glass Keep) a agentes como Hermes/Claude
a través de la **API REST**. Nunca accede a SQLite ni usa tokens de administrador: opera con
la credencial del usuario autenticado.

## Herramientas

| Herramienta | Descripción |
|---|---|
| `search_notes(query?, tags?[], include_archived?, limit=20)` | Busca notas por texto y/o tags; devuelve resúmenes |
| `get_note(id)` | Devuelve una nota completa (incluye archivadas) |
| `list_tags()` | Tags del usuario con conteo, agrupados case-insensitive |
| `get_context(note_id?, query?, max_notes=10)` | Nota focal + notas relacionadas como contexto para el LLM |

## Configuración

Variables de entorno:

| Variable | Requerida | Descripción |
|---|---|---|
| `GLASSKEEP_URL` | sí | Base de la API, p. ej. `https://notes.indigosteam.com` |
| `GLASSKEEP_SECRET_KEY` | sí* | Secret key del usuario (se obtiene en la app: sección Secret Key) |
| `GLASSKEEP_TOKEN` | no | JWT directo (útil para desarrollo; alternativa a la secret key) |

\* Una de las dos credenciales es obligatoria.

El MCP cambia la secret key por un JWT (`POST /api/login/secret`) y lo reutiliza;
si expira, reintenta el login una vez.

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

- Solo lectura: únicamente `GET` + `POST /api/login/secret` (autenticación).
- El token es del usuario dueño de la secret key; jamás un token admin global.
- Las imágenes embebidas (data URLs) se reemplazan por un marcador para no inflar el contexto.

## TODO (Fase 6)

- `POST /api/api-keys` por usuario (clave hasheada, revocable, scopes read/write) para
  reemplazar el uso de la secret key como credencial del MCP.
- Herramientas de escritura (`create_note`, `update_note`, ...) con confirmación explícita.
