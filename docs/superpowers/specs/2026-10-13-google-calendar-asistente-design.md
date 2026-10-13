# Diseño: Hora local + Google Calendar para el asistente de Glass Keep

**Fecha:** 2026-10-13  
**Enfoque elegido:** A — Extender el MCP de GlassKeep y el backend para manejar OAuth + Google Calendar API.  
**Estado:** Pendiente de aprobación para implementación.

---

## 1. Resumen

El asistente AI de Glass Keep (Hermes) actualmente no tiene acceso a la hora actual ni a un calendario externo. Esto impide que el usuario registre de forma confiable el inicio/fin de su jornada laboral u otros eventos en Google Calendar.

Este diseño agrega:

1. **Hora local en el contexto del asistente**: inyección automática de la hora actual en `America/Bogota` en cada conversación.
2. **Integración con Google Calendar**:
   - OAuth2 authorization-code flow manejado por el backend de Glass Keep.
   - Tokens de Google guardados en la base de datos encriptados (igual mecanismo que las LLM keys).
   - Endpoints REST que delegan en la Google Calendar API.
   - Nuevas herramientas en el MCP de GlassKeep para que Hermes pueda consultar y crear eventos.
3. **UI mínima en el frontend**: botón para conectar/desconectar Google Calendar y mostrar el estado.

El asistente siempre confirmará los detalles antes de crear un evento.

---

## 2. Motivación

- El LLM no tiene reloj propio; necesita que el sistema le proporcione la hora local del usuario.
- El usuario quiere registrar inicio/fin de jornada laboral y otros eventos en Google Calendar usando comandos naturales al asistente.
- La solución debe respetar la arquitectura actual: un contenedor Hermes por usuario, MCP por stdio, credenciales cifradas en el backend.

---

## 3. Alcance incluido

- Detectar/inyectar hora local `America/Bogota` en el system prompt.
- Autenticación OAuth2 con Google Calendar.
- Guardar `refresh_token`, `access_token` y expiración en la base de datos encriptados.
- Refrescar automáticamente el `access_token` cuando expire.
- Endpoints REST para:
  - estado de conexión,
  - iniciar OAuth,
  - recibir callback,
  - desconectar,
  - listar eventos,
  - crear eventos,
  - consultar estado de jornada abierta.
- Herramientas MCP:
  - `get_current_time(timezone?)`,
  - `list_calendar_events(start?, end?, max_results?)`,
  - `create_calendar_event(summary, start, end?, description?)`,
  - `start_workday()`,
  - `get_workday_status()`,
  - `end_workday(end_time?)`.
- Comandos de voz/texto soportados:
  - "inicio jornada laboral",
  - "fin jornada laboral",
  - "qué tengo hoy",
  - "crea una reunión mañana a las 3 p.m.".
- UI en Settings para conectar/desconectar Google Calendar.

## 4. Alcance NO incluido (futuro)

- Editar o eliminar eventos existentes.
- Sincronización bidireccional (Glass Keep ↔ Google Calendar).
- Recordatorios/alarms nativos de Google Calendar.
- Soporte para múltiples calendarios (solo el calendario principal del usuario).
- Zona horaria configurable por usuario (fija `America/Bogota` para este usuario/administrador).

---

## 5. Arquitectura

```
Usuario
  │
  ▼
Navegador (React)
  │
  ├── POST /api/assistant/chat  ───────┐
  │                                     ▼
  │                              Glass Keep API
  │                                     │
  │                              ┌──────┴──────┐
  │                              ▼             ▼
  │                         Hermes (SSE)   SQLite
  │                              │        (tokens cifrados)
  │                              ▼
  │                         MCP GlassKeep (stdio)
  │                              │
  │                              ▼
  │                         Glass Keep API
  │                              │
  │                              ▼
  │                         Google Calendar API
  │
  └── GET /api/calendar/auth-url ──► Google OAuth
                                       │
                                       ▼
                              /api/calendar/callback
```

### Flujo normal de un comando

1. El usuario escribe "inicio jornada laboral".
2. El frontend envía el mensaje a `/api/assistant/chat`.
3. El backend inyecta un `system` message con la hora actual en `America/Bogota`.
4. El backend reenvía los mensajes a Hermes.
5. Hermes decide llamar a `start_workday` (u otra herramienta de Calendar) del MCP.
6. El MCP llama al endpoint correspondiente de Glass Keep usando la credencial del usuario.
7. El backend refresca el `access_token` si es necesario y llama a la Google Calendar API.
8. El evento se crea y la respuesta vuelve por SSE al usuario.

---

## 6. Modelo de datos

Se extiende la tabla `user_secrets` para guardar los tokens de Google junto a las demás credenciales cifradas.

```sql
ALTER TABLE user_secrets ADD COLUMN google_refresh_token_enc TEXT;
ALTER TABLE user_secrets ADD COLUMN google_access_token_enc TEXT;
ALTER TABLE user_secrets ADD COLUMN google_token_expires_at TEXT;  -- ISO 8601
ALTER TABLE user_secrets ADD COLUMN google_calendar_connected INTEGER DEFAULT 0;
ALTER TABLE user_secrets ADD COLUMN google_calendar_email TEXT;
```

### Política de cifrado

- Se usa el mismo mecanismo `encryptSecret`/`decryptSecret` basado en `SECRETS_MASTER_KEY` que ya se usa para `llm_key_enc` y `hermes_key_enc`.
- Los tokens de Google **nunca** se devuelen al navegador.
- El `refresh_token` solo se usa en el backend.

---

## 7. Variables de entorno

El administrador del servidor debe configurar:

```env
GOOGLE_CLIENT_ID=<client-id-de-google-cloud>
GOOGLE_CLIENT_SECRET=<client-secret-de-google-cloud>
GOOGLE_REDIRECT_URI=https://notas.tu-dominio.com/api/calendar/callback
GOOGLE_CALENDAR_SCOPES=https://www.googleapis.com/auth/calendar.events
```

En desarrollo local se puede usar `http://localhost:8080/api/calendar/callback` registrado en Google Cloud Console.

---

## 8. Endpoints REST

Todos requieren autenticación (`auth` middleware). Los endpoints de lectura/escritura de calendar fallan con `409` si el usuario no tiene conectada una cuenta de Google.

### `GET /api/calendar/status`

Respuesta:
```json
{
  "connected": true,
  "email": "usuario@gmail.com"
}
```

### `GET /api/calendar/auth-url`

Respuesta:
```json
{
  "url": "https://accounts.google.com/o/oauth2/v2/auth?..."
}
```

El backend genera un `state` JWT corto (vida útil de 10 minutos, firmado con `JWT_SECRET`) para prevenir CSRF.

### `GET /api/calendar/callback?code=&state=`

1. Valida el `state`.
2. Intercambia `code` por tokens en `https://oauth2.googleapis.com/token`.
3. Llama a la Google People API o Calendar API para obtener el email.
4. Guarda tokens encriptados y marca `google_calendar_connected = 1`.
5. Redirige al frontend a una ruta de settings con `?calendar=connected`.

### `POST /api/calendar/disconnect`

1. Revoca el `refresh_token` en Google (best effort).
2. Borra las columnas de Google en `user_secrets`.
3. Responde `{ disconnected: true }`.

### `GET /api/calendar/events?timeMin=&timeMax=&maxResults=`

Delega a `GET https://www.googleapis.com/calendar/v3/calendars/primary/events`.
Parámetros opcionales:
- `timeMin`: ISO 8601 (default: inicio del día actual en America/Bogota).
- `timeMax`: ISO 8601 (default: fin del día actual en America/Bogota).
- `maxResults`: número (default: 50, max: 250).

Respuesta simplificada:
```json
{
  "items": [
    {
      "id": "...",
      "summary": "Jornada laboral",
      "start": { "dateTime": "2026-10-13T08:00:00-05:00" },
      "end": { "dateTime": "2026-10-13T17:00:00-05:00" },
      "status": "confirmed"
    }
  ]
}
```

### `POST /api/calendar/events`

Body:
```json
{
  "summary": "Reunión de equipo",
  "start": "2026-10-14T15:00:00-05:00",
  "end": "2026-10-14T16:00:00-05:00",
  "description": "Agendada por el asistente"
}
```

Reglas:
- Si no se envía `end`, se asume duración de 1 hora.
- La zona horaria default es `America/Bogota` si no se incluye offset.
- Delega a `POST https://www.googleapis.com/calendar/v3/calendars/primary/events`.

### `GET /api/calendar/workday`

Busca el evento de jornada del día actual marcado con `extendedProperties.private.glassKeepWorkday = "true"`.

Respuesta:
```json
{
  "open": true,
  "event": { "id": "...", "start": "..." }
}
```

---

## 9. Herramientas MCP

Se agregan en `mcp/index.js`. Todas usan la credencial de GlassKeep existente (token de sesión o API key).

### `get_current_time`

Devuelve la hora actual del servidor formateada en la zona horaria configurada.

Input:
```json
{ "timezone": "America/Bogota" }
```

Default: `America/Bogota`.

### `list_calendar_events`

Input:
```json
{
  "start": "2026-10-13T00:00:00-05:00",
  "end": "2026-10-13T23:59:59-05:00",
  "max_results": 20
}
```

### `create_calendar_event`

Input:
```json
{
  "summary": "Jornada laboral",
  "start": "2026-10-13T08:00:00-05:00",
  "end": "2026-10-13T16:00:00-05:00",
  "description": "Inicio de jornada laboral"
}
```

### `start_workday`

Sin input. Crea un evento "Jornada laboral" que empieza en el momento actual, con duración mínima (1 minuto), y lo marca con `extendedProperties.private.glassKeepWorkday = "true"`.

Respuesta:
```json
{
  "id": "...",
  "summary": "Jornada laboral",
  "start": "2026-10-13T08:00:00-05:00",
  "end": "2026-10-13T08:01:00-05:00"
}
```

### `get_workday_status`

Sin input. Busca el evento de jornada de hoy marcado con `glassKeepWorkday = "true"`.

Respuesta:
```json
{
  "open": true,
  "event": { "id": "...", "start": "..." }
}
```

### `end_workday`

Input opcional:
```json
{ "end_time": "2026-10-13T17:00:00-05:00" }
```

Si no se envía `end_time`, usa el momento actual. Actualiza el evento de jornada abierto de hoy con la hora de finalización.

---

## 10. Evento de jornada laboral

Para distinguir un evento de jornada de cualquier otro evento llamado "Jornada laboral", se usa una convención:

- El evento se crea con `summary = "Jornada laboral"`.
- Se agrega una propiedad extendida privada en `extendedProperties.private`:
  ```json
  { "glassKeepWorkday": "true" }
  ```
- Al iniciar la jornada, el evento se crea con `end = start + 1 minuto` para que sea válido en la API de Google.
- Al cerrar la jornada, el evento se actualiza con el horario real de finalización.

La marca `glassKeepWorkday` permite encontrar la jornada abierta sin depender del título exacto.

---

## 11. System prompt del asistente

Al inicio de cada conversación con `/api/assistant/chat`, el backend inserta un mensaje `system` con la hora actual:

```text
Eres el asistente personal de Glass Keep. La hora actual del usuario es 2026-10-13T09:30:00-05:00 (zona horaria America/Bogota).

Pautas:
- Antes de crear o consultar eventos en Google Calendar, usá las herramientas disponibles.
- Cuando el usuario diga "inicio jornada laboral", usá la herramienta `start_workday` para registrar el inicio.
- Cuando diga "fin jornada laboral", usá la herramienta `end_workday` para cerrar la jornada abierta de hoy.
- Siempre confirmá los detalles (título, hora, descripción) antes de crear un evento que no sea de jornada.
- Si el usuario no tiene Google Calendar conectado, explicale cómo hacerlo desde Configuración.
```

Este system prompt se inserta **antes** de los mensajes del historial del usuario.

---

## 12. Frontend

### Settings → Google Calendar

Se añade una nueva sección en la pantalla de configuración (o en la misma sección del AI Assistant).

Componentes:
- Estado: "Desconectado" / "Conectado como usuario@gmail.com".
- Botón "Conectar Google Calendar": abre `/api/calendar/auth-url` en una nueva pestaña o redirige.
- Botón "Desconectar": llama a `POST /api/calendar/disconnect` y refresca el estado.

### Ruta de callback

El backend redirige a `/#/settings?calendar=connected` (o similar). El frontend lee el query param y refresca el estado de `/api/calendar/status`.

---

## 13. Manejo de errores

| Situación | Comportamiento |
|---|---|
| Access token expirado | Backend usa `refresh_token` para renovarlo automáticamente antes de llamar a Google. |
| Refresh token inválido/expirado | Se marca `google_calendar_connected = 0`, se borran tokens y se pide reconexión. |
| Usuario no conectó Google Calendar | El asistente responde con instrucciones para conectarlo. Los endpoints devuelven `409`. |
| Google Calendar API no disponible | Error amigable: "No se pudo contactar a Google Calendar. Probá de nuevo en unos minutos." |
| Jornada ya abierta al iniciar | El asistente informa que ya hay una jornada abierta y pregunta si quiere cerrarla. |
| No hay jornada abierta al cerrar | El asistente informa que no encontró una jornada abierta para hoy. |

---

## 14. Seguridad

- Los tokens de Google se cifran con AES-256-GCM usando `SECRETS_MASTER_KEY`.
- Los tokens **nunca** se envían al navegador.
- El `state` del OAuth es un JWT firmado con `JWT_SECRET` y de corta duración.
- El scope solicitado es el mínimo necesario: `https://www.googleapis.com/auth/calendar.events`.
- Al desconectar se revoca el token en Google (best effort) y se borra de la DB.

---

## 15. Testing

### Backend

- Test unitario de helpers de OAuth (generación de URL, validación de state).
- Test de endpoints con mock de Google OAuth y Calendar API.
- Test de refresco automático de access token.

### MCP

- Extensión del smoke test actual para probar las nuevas herramientas con un backend mock.

### Integración

- Flujo end-to-end simulado:
  1. Conectar Google Calendar.
  2. Pedir "inicio jornada laboral".
  3. Verificar evento creado.
  4. Pedir "fin jornada laboral".
  5. Verificar evento cerrado.

---

## 16. Plan de implementación (resumen)

1. Backend: migración de `user_secrets` para tokens de Google.
2. Backend: helpers de OAuth y tokens (`auth-url`, `callback`, `disconnect`, refresh).
3. Backend: endpoints de Calendar (`events`, `workday`).
4. Backend: inyección de system prompt con hora local.
5. MCP: nuevas herramientas (`get_current_time`, `list_calendar_events`, `create_calendar_event`, `start_workday`, `get_workday_status`, `end_workday`).
6. Frontend: UI de conexión en Settings.
7. Testing y documentación de setup en Google Cloud.

---

## 17. Open questions

Ninguna. El diseño fue validado con el usuario antes de escribir este documento.
