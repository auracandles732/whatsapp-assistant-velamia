# Instalar el asistente para un negocio nuevo

Cada negocio tiene **su propia instalación**: su número de WhatsApp, su base de datos y su servidor.
Así los chats, clientes y ventas de un negocio nunca se mezclan con los de otro.

Tiempo estimado: 1 a 2 horas (más la aprobación de plantillas en Meta, que puede tardar hasta 24 h).

## 1. Cuentas que necesita el negocio

| Servicio | Para qué | Plan |
|---|---|---|
| Meta (WhatsApp Business Platform) | Número que atiende a las clientas | Responder a clientas es gratis; las plantillas (seguimientos y avisos) se cobran por mensaje |
| Supabase | Base de datos y fotos | Plan gratuito o de pago |
| Render | Servidor del asistente y del CRM | Plan gratuito o de pago |
| OpenAI | Inteligencia del asistente | Pago por uso |

> Revisa los precios y límites vigentes de cada servicio antes de cotizarle al negocio. Los planes gratuitos
> limitan cuántos proyectos o horas de servidor tiene cada cuenta: con varios negocios conviene que cada uno
> tenga sus propias cuentas (así también paga su propio consumo).

## 2. Base de datos (Supabase)

1. Crear un proyecto nuevo.
2. Abrir **SQL Editor**, pegar todo `setup/base_nueva.sql` y ejecutar. Crea tablas, protección y buckets de fotos.
3. En **Project Settings → API** copiar `Project URL` y la clave `service_role`.

## 3. WhatsApp (Meta)

1. En developers.facebook.com crear una app de tipo **Business** y agregar **WhatsApp**.
2. Registrar el número del negocio y copiar: `Phone number ID` y `WhatsApp Business Account ID`.
3. Crear un **usuario del sistema** con token permanente (permisos `whatsapp_business_messaging` y `whatsapp_business_management`).
4. Copiar la **clave secreta de la app** (Configuración → Básica).
5. Crear las plantillas (categoría Marketing o Utilidad, idioma Español):
   - **Aviso para la dueña** (ej. `aviso_equipo`) con 4 variables: `{{1}}` motivo, `{{2}}` cliente, `{{3}}` teléfono, `{{4}}` detalle.
     Opcional: botón de URL "Abrir CRM" hacia `https://<servidor>.onrender.com/crm/`.
   - **Seguimientos** (opcional), una por paso, sin variables. Ej: `seguimiento_01` "¡Hola! 😊 ¿Pudiste revisar las opciones que te compartí? Estoy aquí para ayudarte."

## 4. Servidor (Render)

1. Crear un **Web Service** desde este repositorio (o una copia/fork para el negocio).
   Build command `npm run build` · Start command `npm start`.
2. En **Environment** cargar:

| Variable | Valor |
|---|---|
| `WHATSAPP_TOKEN` | Token permanente del usuario del sistema |
| `WHATSAPP_PHONE_ID` | Phone number ID |
| `WHATSAPP_BUSINESS_ACCOUNT_ID` | WhatsApp Business Account ID |
| `META_APP_SECRET` | Clave secreta de la app |
| `WEBHOOK_VERIFY_TOKEN` | Una palabra secreta inventada |
| `OPENAI_API_KEY` | Clave de OpenAI |
| `SUPABASE_URL` / `SUPABASE_SERVICE_KEY` | Del paso 2 |
| `CRM_PASSWORD` | Contraseña del CRM para el negocio |

3. En Meta → WhatsApp → Configuración: webhook `https://<servidor>.onrender.com/webhook`, token = `WEBHOOK_VERIFY_TOKEN`,
   y suscribirse al campo **messages**.

## 5. Perfil del negocio (desde el CRM)

Entrar a `https://<servidor>.onrender.com/crm/` → **Configuración → Perfil del negocio**:

1. **Empezar desde una plantilla**: "Detalles para eventos" (por docena, con fecha de evento) o "Tienda de productos" (por unidad).
2. Completar: nombre, descripción, ciudad, logo y color; unidad de venta; pagos (anticipo o total, tarjeta);
   fechas de entrega; tipo de envío; **tu WhatsApp para recibir avisos**; nombres de las plantillas del paso 3.
3. **Guardar perfil**. Se aplica al instante.

También en Configuración:
- **Datos para transferencia**: el texto exacto que el asistente envía cuando la clienta elige transferencia.
- **Instrucciones del asistente**: tono, horarios, políticas y preguntas frecuentes del negocio.

Y en **Catálogo** cargar los productos con foto, precio y categoría.

## 6. Probar antes de publicar

Escribir desde otro número al WhatsApp del negocio y recorrer una venta completa:
saludo → pedir fotos → elegir producto → cantidad (y fecha/ciudad si aplica) → total → forma de pago.
Revisar en el CRM que aparezca la cotización y que llegue el aviso al WhatsApp de la dueña.

## Qué es configurable y qué no

| Configurable en el perfil | Fijo en el código |
|---|---|
| Nombre, descripción, logo, color, zona horaria | Idioma español |
| Unidad de venta y cómo se llaman los productos | Moneda en dólares ($) |
| Personalización sí/no | Fotos de 4 en 4, espera de 5 s y pausas entre mensajes |
| Anticipo % por transferencia, tarjeta sí/no | Cálculo del total por el sistema (la IA no hace cuentas) |
| Fecha de evento, días de anticipación, disponibilidad | Formato de mensajes (frases cortas, listas) |
| Envío: tarifario Ecuador, tarifa fija o sin envío; retiro en local | Tarifario de Ecuador con origen Guayaquil |
| Seguimientos (plantillas, días, horario) y plantilla de avisos | |
| Emojis y si se presenta como persona o asistente virtual | |
