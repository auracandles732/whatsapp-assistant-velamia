# Asistente de ventas por WhatsApp

Asistente de ventas por WhatsApp con CRM web instalable como app, **configurable para cualquier negocio**
desde el CRM (Configuración → Perfil del negocio). La primera instalación es VELAMIA (velas para eventos, Guayaquil):
lo que este README describe como comportamiento es el de su perfil.

- **Agregar y administrar empresas:** [docs/NUEVO_NEGOCIO.md](docs/NUEVO_NEGOCIO.md)
- **Perfil del negocio:** `src/config/businessProfile.ts` (tipos, validación y plantillas `VELAMIA_PROFILE`, `EVENTS_PROFILE`, `STORE_PROFILE`).
  Se guarda en `business_config` (clave `business_profile`) y define unidad de venta, pagos, fechas, envíos,
  seguimientos, avisos, emojis, nombre, logo y color. Las reglas de la IA se arman con `buildCoreRules(perfil)`.
- **Cargar un perfil por consola:** `npm run build && npm run perfil -- velamia` (o `eventos`, `tienda`, `archivo.json`; `--ver` para mostrarlo).

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
- **CRM:** `dashboard/index.html` (React). El servidor lo traduce al arrancar (`src/services/crmBuild.ts`, esbuild) y lo
  sirve como `/crm/app.js`, así la página funciona con protección estricta de scripts. Nunca habla directo con Supabase:
  todo pasa por `/api/*` con token de sesión.

## Estructura

| Archivo | Responsabilidad |
|---|---|
| `src/index.ts` | Rutas HTTP: webhook de Meta, login, API del CRM y perfil del negocio |
| `src/config/businessProfile.ts` | Perfil del negocio: todo lo que cambia de un negocio a otro |
| `src/middleware/auth.ts` | Firma del webhook (HMAC) y sesiones del CRM |
| `src/controllers/messageController.ts` | Procesa cada mensaje entrante (en fila por cliente) |
| `src/services/openai.ts` | Reglas del bot, `planTurn`, extracción de pedidos, audio e imágenes |
| `src/services/supabase.ts` | Acceso a la base de datos |
| `src/services/whatsapp.ts` | Envío de mensajes y descarga de archivos (Graph API v25.0) |
| `src/services/storage.ts` | Subida y borrado de archivos en Supabase Storage |
| `src/services/notifications.ts` | Avisos a la dueña por WhatsApp |
| `src/services/tenant.ts` | Empresa en curso (cada empresa con su WhatsApp, su OpenAI y sus datos) y servicios adicionales |
| `src/services/metaChannels.ts`, `src/controllers/socialController.ts` | Instagram y Messenger: conexión, mensajes y comentarios |
| `src/services/socialPosts.ts`, `socialPublisher.ts`, `socialImages.ts` | Publicaciones en redes: calendario, publicación y fotos |
| `src/services/manualSales.ts` | Cotizaciones y pedidos armados a mano en el CRM (mismo cálculo que el bot) |
| `src/services/crmOverview.ts` | Resumen de hoy, lista de chats y resumen de cada cliente para el CRM |
| `src/services/followups.ts` | Seguimientos automáticos con plantillas |
| `src/services/health.ts` | Revisión diaria de las empresas (claves de Meta y OpenAI) |
| `src/services/aiStatus.ts` | Anota si la IA está fallando (por ejemplo, sin créditos) para mostrarlo en el CRM |
| `src/services/crmBuild.ts` | Traduce el CRM al arrancar el servidor |
| `dashboard/index.html` | El CRM completo (computadora y celular) |
| `tests/` | Pruebas (`npm test`): nunca escriben en la base real ni envían mensajes |
| `migrations/` | Historial de VELAMIA. Ninguna borra tablas ni datos |
| `migrations/NO_EJECUTAR/` | Migración antigua que **borra todas las tablas**: solo como referencia, nunca correrla |
| `setup/base_nueva.sql` | Instalación completa de la base para un negocio nuevo |
| `scripts/perfil.js` | Carga o muestra el perfil del negocio desde la consola |

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
- Nunca dice que es un bot. Se pausa y avisa a la dueña en: **pago con tarjeta elegido, reclamo, diseño fuera
  del catálogo**. Solo avisa (sin pausar) con: **cotización enviada, pedido nuevo, pedido actualizado, comprobante
  de pago, entrega muy justa, pregunta sin respuesta** o si la IA falla. Un "gracias" después de elegir tarjeta
  no vuelve a pausar ni a avisar.
- **Cantidades en piezas:** si la clienta pide "48 unidades" o "36 velas", el sistema lo convierte a docenas
  (redondeando hacia arriba) aunque la IA copie el número: el total nunca se multiplica por 12.
- Si la IA falla por el límite de uso de OpenAI, el SDK reintenta hasta 4 veces antes de avisar a la dueña.

## Aromas, empaques y diseños fuera del catálogo

- **Aromas** (Dulce y Tropical, sin costo, todas las velas llevan aroma): están en las instrucciones del CRM.
- **Empaques** (Perfil del negocio → Empaques): Acetato, Tul, Kraft y Caja lazo personalizable. Cada producto
  tiene su empaque incluido en el precio (Catálogo → lista en cada tarjeta; se guarda en `products.description`).
  Si la clienta pide otro empaque, el total suma el "costo del cambio" por docena; si ese costo está vacío, el bot
  no da total y avisa a la dueña. Tul y Caja lazo son personalizables: el bot pregunta el color sin ofrecer lista.
- **Diseño fuera del catálogo** (cualquier modelo que no esté en el catálogo, o si no le gusta ninguno): el bot no
  acepta ni rechaza, no da precio y nunca dice que consulta. Pregunta de a un dato: diseño (y foto de referencia),
  colores, empaque, nombre, cantidad, ciudad y fecha. Con la cantidad ya dicha avisa a la dueña
  (`custom_design_request`, con "con foto de referencia" si la envió) y se pausa. El mismo diseño no se vuelve a
  avisar; si la dueña ya dio el precio en el chat, el bot puede repetirlo (y su anticipo) al cerrar la venta.

## CRM

- **Secciones:** Conversaciones (separadas por red: WhatsApp, Instagram y Facebook, cada una con su color), Cotizaciones,
  Pedidos, Catálogo, Publicaciones, Configuración (perfil del negocio) y Consumo de IA.
- **Celular:** diseño propio (se activa con pantallas de hasta 760 px): barra de abajo, chat a pantalla completa con
  acciones rápidas, Resumen de hoy (Estadísticas), catálogo con alta en 3 pasos, cotizaciones con detalle, configuración
  por secciones con vista previa y consumo con gráficos. La computadora mantiene su diseño.
- **Dirección de cada pantalla:** la sección abierta queda en la dirección (`#/cotizaciones`, `#/conversaciones/<chat>`):
  al recargar se vuelve ahí, y el botón "atrás" del celular o del navegador cierra el chat o vuelve a la sección anterior.
- **Cotizaciones y pedidos a mano** (`POST /api/quotations`, `PUT /api/quotations/:id`, `POST /api/orders`): se calculan
  igual que los del bot (precios del catálogo, empaques y tarifario de envíos). "Enviar" (`POST /api/quotations/:id/send`)
  manda la cotización con las fotos de los productos por el canal de la clienta (WhatsApp, Instagram o Messenger) o por
  otro chat elegido, y pausa el bot en ese chat como cualquier mensaje escrito desde el CRM. Estados: pendiente,
  enviada, aprobada y vencida (las pendientes vencen a los 3 días; editarla le da 3 días más).
- **IA fallando:** si OpenAI se queda sin créditos (o falla), el bot no responde; el CRM lo muestra arriba en rojo en todas
  las pantallas y el aviso a la dueña dice el motivo. Desaparece solo con la primera respuesta que funcione.

## Pedidos (pestaña del CRM)

- Lista todos los pedidos con productos, personalización, empaque, envío y entrega.
- La dueña marca el estado: **Pendiente de pago → Pagado · en preparación → Enviado → Entregado** (o Cancelado).
- Cuando la clienta pregunta "¿cómo va mi pedido?", la IA responde con ese estado real. Si el pedido sigue
  "pendiente de pago" o no hay pedido, dice que lo revisa y la dueña recibe `owner_question`.
- Si la clienta confirma sin repetir modelos ni ciudad, el pedido toma lo ya cotizado: nunca pierde productos ni envío.

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

## Instagram y Messenger (`src/services/metaChannels.ts`, `src/controllers/socialController.ts`)

- Llegan al mismo `/webhook` (objetos `page` e `instagram`). Los chats se guardan como los de WhatsApp, pero con `ig:<id>` o `fb:<id>` en lugar del número: el asistente, el CRM y los avisos los atienden igual.
- Las fotos no llevan texto debajo: el nombre y el precio van en un mensaje aparte. Los textos largos se parten (Instagram acepta 1000 caracteres, Messenger 2000).
- Comentarios nuevos en publicaciones: a quien pregunta o muestra interés se le escribe por privado (lo redacta la IA; Meta permite un solo mensaje hasta que conteste) y en el comentario se responde corto, sin precios. A quien elogia se le agradece. Un reclamo avisa a la dueña y pausa el bot en ese chat.
- Lo que el equipo escriba desde la app de Instagram, Messenger o Business Suite llega como eco: se guarda como del equipo y pausa el bot.
- No hay seguimientos con plantilla ni notas de voz en estos canales; el seguimiento tras las fotos sí (dentro de 24 horas).
- `META_PAGE_TOKEN` puede ser de usuario del sistema: se cambia sola por la de la página y el Instagram se detecta solo. `POST /api/me/connect-social` suscribe la página a la App.
- Por ahora solo VELAMIA: las demás empresas no tienen estos canales.

## Publicaciones en redes (servicio adicional) (`src/services/socialPosts.ts`, `socialPublisher.ts`, `socialImages.ts`)

- **Para cualquier empresa**: la administradora lo activa en Empresas → "Publicaciones en redes" (`businesses.addons.publicaciones`). VELAMIA lo tiene siempre. Sin el servicio, la pestaña Publicaciones muestra la oferta.
- **Cómo funciona**: en CRM → Publicaciones se eligen días, hora, redes (Instagram, historia de Instagram, Facebook), fotos por publicación (1 o carrusel) e indicaciones para los textos. "Preparar próximos 7 días" elige productos con foto del catálogo —primero lo que nunca salió o hace más tiempo, variando la categoría y dando prioridad a la temporada (Navidad en oct-dic, etc.)— y la IA escribe los textos en una sola llamada con precios exactos del catálogo. Si la IA falla, va un texto de respaldo.
- **Lo programado sale solo, sin aprobación**: cada publicación (creada por la empresa o por la IA) queda "Programada" y se publica a su hora. Cada 5 minutos se publican las que llegaron a su hora; si se pasaron más de 6 h (servidor caído), quedan como "No se publicó" para que la empresa elija otra hora o "Programar de nuevo". También se puede "Publicar ahora", pedir "Otro texto", cambiar día, hora y redes, o descartar (ese día no se vuelve a llenar).
- **Modo automático con IA** (interruptor en la pestaña): la IA prepara y programa los próximos 7 días al encenderlo y luego revisa cada hora que la semana siga completa. Apagado, solo sale lo que programe la empresa.
- Cada red se publica por separado: si una falla, las demás salen y queda "Publicada en parte" con el motivo.
- **Fotos**: cada foto se arma para Instagram sin recortarla: publicación en 4:5 (1080×1350, con la foto dentro del ancho que muestra la cuadrícula del perfil) e historia en 9:16 (1080×1920), con la foto completa al centro y la misma foto difuminada de fondo. Se guardan en `product-images` como `social-<feed|story>-v2-<hash>.jpg` en la carpeta de la empresa (una sola vez por foto). Facebook usa la foto original.
- **Conexión**: cada empresa conecta su propia página con el botón de la pestaña (el sello del enlace lleva el id de la empresa). Para las demás empresas la conexión sirve solo para publicar; los mensajes de Instagram y Messenger siguen siendo solo de VELAMIA.
- **Para ponerlo en producción**:
  1. Aplicar `migrations/024_publicaciones_en_redes.sql` en Supabase (sin ella el servidor avisa una vez y no publica).
  2. Instagram: el permiso `instagram_content_publish` ya se pide al conectar.
  3. Facebook: agregar `pages_manage_posts` a la App de Meta y luego poner `META_PUBLISH_FACEBOOK=true` en Render (antes no: un permiso que la App no tiene rompe la ventana de conexión). Después, volver a conectar con Facebook.
  4. Publicar para otras empresas fuera de los roles de la App requiere App Review de esos permisos.

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
| `META_PAGE_ID`, `META_PAGE_TOKEN` | Página de Facebook (Messenger) y su Instagram conectado. Sin ellas, esos canales quedan apagados |
| `META_PUBLISH_FACEBOOK` | `true` cuando la App de Meta ya tiene `pages_manage_posts`: se pide al conectar y permite publicar en la página |
| `META_APP_ID` | Id de la App de Meta (botón "Conectar con Facebook") |
| `WHATSAPP_BUSINESS_ACCOUNT_ID` | Cuenta de WhatsApp Business: plantillas de seguimiento y avisos |
| `BUSINESS_SECRETS_KEY` | Cifra las claves de Meta y OpenAI que guarda cada empresa |
| `PLATFORM_ALERT_PHONE` | A quién avisa la revisión diaria de empresas (si falta, al número de la dueña) |
| `RENDER_EXTERNAL_URL` | Lo pone Render: auto-ping, enlaces del CRM en los avisos y conexión con Facebook |
| `ELEVENLABS_API_KEY`, `ELEVENLABS_VOICE_ID` | Notas de voz (solo VELAMIA) |

El número que recibe avisos está en la tabla `business_config` (clave `owner_phone`).

## Desarrollo

```bash
npm install
npm run build
npm test
```

- Cada push a `main` despliega en Render automáticamente.
- **Nunca correr el servidor local con el `.env` de producción**: escribe en la base real, envía WhatsApp de verdad y
  corre los seguimientos en paralelo a Render. Para ver cambios del CRM se usa una base simulada (sin WhatsApp ni datos reales).
- Las pruebas (`tests/`) simulan Meta, WhatsApp y la base: nunca publican ni envían nada.
