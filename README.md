# Asistente WhatsApp VELAMIA 🕯️

Bot de ventas por WhatsApp para VELAMIA (velas para eventos, Guayaquil) con CRM web instalable como app.

## Arquitectura

```
Cliente WhatsApp ──► Meta (WhatsApp Cloud API) ──► POST /webhook (Render)
                                                        │
                         ┌──────────────────────────────┤
                         ▼                              ▼
                 OpenAI gpt-5.4-mini            Supabase (PostgreSQL + Storage)
            (respuesta, fotos, intención,      conversaciones, mensajes, catálogo,
             audio con whisper-1, visión)       cotizaciones, pedidos, avisos, archivos
                                                        ▲
                                  CRM /crm (PWA) ──► /api/* con sesión
```

- **Servidor:** Node 22 + TypeScript + Express en Render (plan gratuito, auto-ping cada 10 min).
- **Cerebro:** una sola llamada a la IA (`planTurn`) decide la respuesta, qué fotos del catálogo enviar,
  la intención (cotización / pedido) y si el caso requiere revisión manual.
- **CRM:** `dashboard/index.html` (React sin compilación). Nunca habla directo con Supabase:
  todo pasa por `/api/*` con token de sesión.

## Estructura

| Archivo | Responsabilidad |
|---|---|
| `src/index.ts` | Rutas HTTP: webhook de Meta, login, API del CRM |
| `src/middleware/auth.ts` | Firma del webhook (HMAC) y sesiones del CRM |
| `src/controllers/messageController.ts` | Procesa cada mensaje entrante (en fila por cliente) |
| `src/services/openai.ts` | Reglas del bot, `planTurn`, extracción de pedidos, audio e imágenes |
| `src/services/supabase.ts` | Acceso a la base de datos |
| `src/services/whatsapp.ts` | Envío de mensajes y descarga de archivos (Graph API v25.0) |
| `src/services/storage.ts` | Subida y borrado de archivos en Supabase Storage |
| `src/services/notifications.ts` | Avisos a la dueña por WhatsApp |
| `migrations/` | SQL en orden. **002 borra todo: no re-ejecutar en producción** |

## Comportamiento del bot

- Precios siempre **por docena**; solo productos reales del catálogo.
- Envía fotos solo cuando la clienta pide ver modelos; todas las de la categoría, sin repetir.
- Reconoce la foto que la clienta cita al responder.
- La personalización (colores, nombres, frases) siempre es válida y no impide cerrar la venta.
- Nunca dice que es un bot. Se pausa y avisa a la dueña en: **pago con tarjeta elegido,
  comprobante de pago, reclamo**. También avisa de cada **pedido nuevo** y si la IA falla.
- Cotización en el CRM solo cuando la clienta pide cotización o valor total.
- Si una persona escribe desde el CRM, el bot queda pausado en ese chat hasta reactivarlo.

## Variables de entorno (Render → Environment)

| Variable | Uso |
|---|---|
| `WHATSAPP_TOKEN` | Token permanente de usuario del sistema de Meta |
| `WHATSAPP_PHONE_ID` | Id del número de WhatsApp Business |
| `META_APP_SECRET` | Clave secreta de la app de Meta (verifica que el webhook venga de Meta) |
| `WEBHOOK_VERIFY_TOKEN` | Token para verificar el webhook en Meta |
| `OPENAI_API_KEY` | OpenAI |
| `SUPABASE_URL`, `SUPABASE_SERVICE_KEY` | Supabase (service key: solo servidor) |
| `CRM_PASSWORD` | Contraseña del CRM |

El número que recibe avisos está en la tabla `business_config` (clave `owner_phone`).

## Desarrollo

```bash
npm install
npm run build
```

Para probar localmente, crear `.env` con las variables anteriores y ejecutar `npm run dev`.
Cada push a `main` despliega en Render automáticamente.
