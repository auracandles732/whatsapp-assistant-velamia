# Multi-negocio: acceso, claves y separación de datos

**Actualizado:** 17 de septiembre de 2026

## Cómo se separa cada negocio

Cada petición corre dentro de un **contexto de negocio** (`src/services/tenant.ts`, AsyncLocalStorage):

| Qué | VELAMIA (sin contexto) | Negocio (con contexto) |
|-----|------------------------|------------------------|
| Número de WhatsApp | `WHATSAPP_TOKEN` / `WHATSAPP_PHONE_ID` | Columnas del negocio (token cifrado) |
| OpenAI | `OPENAI_API_KEY` | Clave propia cifrada; **nunca** usa la de VELAMIA |
| Perfil | `business_config.business_profile` | `businesses.business_profile` |
| Prompt, datos bancarios, bot on/off | `business_config.<clave>` | `business_config.business:<id>:<clave>` |
| Chats, productos, cotizaciones, pedidos | `business_id IS NULL` | `business_id = <id>` |
| Archivos | raíz del bucket | carpeta `<id>/` |
| Seguimientos | plantillas de VELAMIA | plantillas del WABA del negocio |

**Webhook:** el negocio se identifica por `metadata.phone_number_id` (el número que recibió el mensaje).
Si coincide con `WHATSAPP_PHONE_ID` es VELAMIA; si no pertenece a ningún negocio activo, se ignora.
Todos los números deben estar en la **misma App de Meta** (se valida con `META_APP_SECRET`).

## Acceso al CRM

Una sola pantalla de ingreso (`POST /api/login`):
- **Contraseña maestra** (`CRM_PASSWORD`) → administrador. Ve la pestaña Negocios y elige en qué negocio trabajar (cabecera `X-Business-Id`).
- **Token del negocio** (64 caracteres) → solo ese negocio. La sesión se invalida si el token se revoca, vence (90 días), o el usuario/negocio se desactiva.

Roles: `owner` (todo, incluidas claves y configuración) · `manager` (atiende y edita catálogo/pedidos, no cambia configuración) · `staff` (solo consulta).

## Endpoints

Administrador:
- `GET/POST /api/businesses` · `PATCH /api/businesses/:id` (nombre, activo)
- `PUT /api/businesses/:id/credentials` · `POST /api/businesses/:id/test-credentials`
- `POST /api/businesses/:id/generate-access-token` · `GET /api/businesses/:id/tokens` · `DELETE /api/businesses/:id/tokens/:tokenId`
- `GET/POST /api/businesses/:id/users` · `PATCH/DELETE /api/businesses/:id/users/:userId` · `POST .../users/:userId/generate-token`

Negocio (o admin con un negocio elegido):
- `GET /api/session` · `GET /api/me/business`
- `PUT /api/me/credentials` · `POST /api/me/test-credentials` (solo owner)
- Todas las rutas del CRM de siempre (`/api/conversations`, `/api/products`, ...) quedan limitadas al negocio.

Claves que acepta `credentials`: `displayPhoneNumber`, `phoneNumberId`, `wabaId`, `metaAccessToken`, `openaiApiKey`.
Los campos vacíos conservan lo guardado. Las respuestas nunca devuelven claves, solo `••••` + últimos 4 caracteres.

## Requisitos

- Migración `015_multi_negocio_claves_y_aislamiento.sql` aplicada en Supabase.
- Variable `BUSINESS_SECRETS_KEY` en el servidor (texto aleatorio largo). **No cambiarla** después de guardar claves: las cifradas dejarían de poder leerse.
- En Meta: suscribir el WABA de cada negocio a la misma App del webhook.
