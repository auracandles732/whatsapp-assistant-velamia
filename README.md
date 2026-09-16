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
- Espera **5 segundos** sin mensajes nuevos antes de responder y contesta en un solo turno todo lo que la clienta
  escribió seguido (máximo 20 s de espera si no deja de escribir). El mensaje se guarda en el CRM al instante.
- Envía fotos solo cuando la clienta pide ver modelos, sin repetir, **de 4 en 4**: si quedan más, pregunta
  "¿Te gustaría ver más modelos?" y envía las siguientes 4 cuando acepta. Si no quedan más, pregunta cuál le gustó.
  Las preguntas sobre las fotos las envía el sistema **después** de las imágenes, nunca antes.
- **Pausas entre mensajes** de una misma respuesta: 3 s entre el texto, las fotos y la pregunta final, y 2 s entre
  fotos (`MESSAGE_GAP_MS`, `PHOTO_GAP_MS`). Al apagar el servidor responde sin pausas.
- Nunca escribe listas de modelos con sus precios en el texto: para mostrar modelos envía las fotos, que ya
  llevan nombre y precio en el pie.
- Reconoce la foto que la clienta cita al responder.
- La personalización (colores, nombres, frases) siempre es válida y no impide cerrar la venta.
- Solo registra un pedido (y avisa a la dueña) cuando la clienta confirma o elige forma de pago; dar modelo,
  cantidad y ciudad no es un pedido. Cotización y pedido usan los mismos modelos, docenas y personalización
  con que se calculó el valor que recibió la clienta, y guardan la **fecha de entrega** y la ciudad.
- **Cada vez que el bot le da a una clienta el valor total, queda cotización en el CRM y la dueña recibe el
  aviso `new_quotation` para revisarla.** El bot nunca se pausa por eso. Mientras haya un pedido en curso,
  lo que venga después (personalización, cambio de cantidad) actualiza ese pedido y avisa con `order_updated`.
- Al publicar una versión (SIGTERM de Render) responde de inmediato los mensajes que estaban en espera.
- **Formato:** frase cálida, datos en lista (un dato por línea con emoji), reserva de fecha debajo y una pregunta.
  Nunca "te lo dejo anotado". Si la IA repite un emoji de adorno de los últimos 4 mensajes, `varyEmojis` lo cambia.
- **Datos bancarios:** solo cuando la clienta elige transferencia o pide la cuenta (`BANK_CHOICE_PATTERN`);
  si no eligió forma de pago, el bot pregunta "transferencia o tarjeta".
- Nunca dice que es un bot. Se pausa y avisa a la dueña en: **pago con tarjeta elegido, reclamo**.
  Solo avisa (sin pausar) con: **cotización enviada, pedido nuevo, pedido actualizado, comprobante de pago,
  entrega muy justa, pregunta sin respuesta** o si la IA falla.

## Pagos

| Forma | Monto que indica el bot | Qué pasa |
|---|---|---|
| Transferencia | Anticipo del 50% del total (saldo antes de la entrega) | El sistema envía el texto de **CRM → Configuración → Datos para transferencia** tal cual. Si está vacío, avisa a la dueña |
| Tarjeta | 100% del total | El bot se pausa y avisa a la dueña para que envíe el link de pago |
| Comprobante | — | Avisa a la dueña para verificar; el bot sigue atendiendo |

La IA nunca redacta números de cuenta: el bloque bancario (clave `payment_transfer_info`) se envía sin modificar.

## Fechas, envíos y preguntas sin respuesta

- **Entrega = fecha del evento − 3 días** (el pedido le llega a la clienta ese día). Siempre hay disponibilidad.
  La resta la hace el sistema (`subtractDays`); si la IA menciona otra fecha, se rehace la respuesta.
  Si la entrega calculada es hoy o ya pasó, el bot no menciona fecha. La dueña recibe el aviso `urgent_date`
  cuando la entrega es dentro de **3 días o menos** (una vez al día por chat).
- Urgencia honesta: la fecha se reserva al recibir el anticipo.
- **Envíos** a todo Ecuador desde Guayaquil (Servientrega), sin retiro en local, sin pedido mínimo.

## Envíos y valor total (`src/services/shippingRates.ts`)

- Tarifario referencial hasta 2 kg (24 provincias, 222 cantones) tomado de `Tarifario_Envios_Ecuador_Hasta_2kg.pdf`.
  Todos los cantones cuestan lo de su provincia, excepto Guayas: Guayaquil y Durán $3.00, resto $5.25.
- Hasta **3 docenas** se cobra la tarifa; con más docenas el envío sube **$1.00** (una vez). Nunca se le menciona a la clienta.
- La clienta recibe **un solo valor**: velas + envío. Sin la ciudad, el bot la pide antes de dar cualquier monto.
- El total lo calcula el sistema (`computeOrderTotal`): precios del catálogo × docenas + envío. Si la IA escribe
  otro total, otro anticipo o cualquier monto extra (precio por docena, costo de envío), la respuesta se rehace.
- Anticipo por transferencia = 50% del valor total con envío; tarjeta = 100%.
- Reconoce "Ciudad, Provincia", nombres populares (Puyo, Macas, El Coca, Sangolquí, Puerto Ayora…) y pide la provincia
  cuando un nombre es ambiguo con tarifas distintas (Olmedo, Bolívar, Pichincha) o cuando solo dicen "Guayas".
- En el CRM (pestaña Cotizaciones) la dueña sí ve el envío como línea aparte ("🚚 Envío a…").
- Si la clienta pregunta algo que no está en las instrucciones, el bot dice que lo verifica y la dueña
  recibe el aviso `owner_question` con la pregunta; el bot sigue atendiendo.
- Cotización en el CRM cada vez que el bot entrega el valor total (lo pida la clienta con esas palabras o no).
  La tarjeta muestra la fecha de entrega, guardada dentro de `products` como `{ type: 'delivery', date }`
  (la tabla `quotations` no tiene columna propia; `orders` sí usa `delivery_date`).
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

- No se envían si el bot está apagado, el chat está pausado, la clienta lleva más de 21 días sin escribir,
  hay un pedido en los últimos 60 días
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
