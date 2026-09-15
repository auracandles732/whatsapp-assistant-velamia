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
- Nunca dice que es un bot. Se pausa y avisa a la dueña en: **pago con tarjeta elegido, reclamo**.
  Solo avisa (sin pausar) cuando llega un **comprobante de pago**, un **pedido nuevo** o si la IA falla.

## Pagos

| Forma | Monto que indica el bot | Qué pasa |
|---|---|---|
| Transferencia | Anticipo del 50% del total (saldo antes de la entrega) | El sistema envía el texto de **CRM → Configuración → Datos para transferencia** tal cual. Si está vacío, avisa a la dueña |
| Tarjeta | 100% del total | El bot se pausa y avisa a la dueña para que envíe el link de pago |
| Comprobante | — | Avisa a la dueña para verificar; el bot sigue atendiendo |

La IA nunca redacta números de cuenta: el bloque bancario (clave `payment_transfer_info`) se envía sin modificar.
- Cotización en el CRM solo cuando la clienta pide cotización o valor total.
- Si una persona escribe desde el CRM, el bot queda pausado en ese chat hasta reactivarlo.

## Seguimientos automáticos (`src/services/followups.ts`)

Cada 15 minutos, entre 9:00 y 19:00 (Guayaquil), se envían las plantillas aprobadas en Meta
según los días sin respuesta desde el último mensaje de la clienta:

| Días | Plantilla |
|---|---|
| 1 | `velamia_seguimiento_01` |
| 2 | `velamia_seguimiento_02` |
| 4 | `velamia_seguimiento_03` |
| 7 | `velamia_seguimiento_04_v2` |
| 14 | `velamia_seguimiento_05_v2` |

- No se envían si el bot está apagado, el chat está pausado, hay un pedido en los últimos 60 días
  o la clienta respondió **NO** (queda registrado como `opt_out` en `followups`).
- Si la clienta responde, la serie se reinicia desde su nuevo mensaje. Nunca dos seguimientos en menos de 20 h.
- Cada envío queda en `followups` (`auto_followup`) y en el chat con el prefijo "📩 Seguimiento automático".
- Los avisos a la dueña usan la plantilla `velamia_aviso_equipo`; si no está aprobada, texto libre.
- Requiere la variable `WHATSAPP_BUSINESS_ACCOUNT_ID` (en `/health` aparece `followups: activo`).

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
