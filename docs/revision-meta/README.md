# Revisión de la app en Meta (acceso avanzado)

App: **VELAMIA Platform** (id 1424596706382124). Mientras un permiso está en "Listo para la prueba", Meta solo entrega
los mensajes y comentarios de personas con un rol en la app. Con el acceso avanzado los entrega de cualquier clienta.

## 1. Permisos que se piden y dónde se ven en el CRM

| Permiso | Para qué lo usa el sistema | Dónde se muestra en el video |
|---|---|---|
| `instagram_manage_messages` | Recibir y contestar los mensajes directos de Instagram | Conversaciones → chat de Instagram |
| `pages_messaging` | Recibir y contestar los mensajes de Messenger de la página | Conversaciones → chat de Facebook |
| `instagram_manage_comments` | Leer los comentarios de las publicaciones y contestarlos | Comentario en Instagram → respuesta pública y chat |
| `pages_read_engagement` | Leer los datos de la página y los comentarios de sus publicaciones | Comentario en Facebook → chat |
| `pages_manage_metadata` | Suscribir la página para que Meta avise de mensajes y comentarios | Configuración → Conectar con Facebook |
| `pages_show_list` | Mostrar las páginas que administra quien conecta | Ventana de Facebook al conectar |
| `instagram_basic` | Leer la cuenta de Instagram enlazada a la página | Configuración → muestra @velamia.ec |
| `business_management` | Leer páginas e Instagram que pertenecen al portafolio comercial | Ventana de Facebook al conectar |
| `instagram_content_publish` | Publicar fotos e historias en Instagram desde el CRM | Publicaciones → publicar |
| `pages_manage_posts` | Publicar en la página de Facebook desde el CRM | Publicaciones → publicar |
| `instagram_manage_insights` | Alcance, vistas y guardados de lo publicado en Instagram | Publicaciones → Resultados |
| `read_insights` | Estadísticas de lo publicado en la página | Publicaciones → Resultados |
| `pages_read_user_content` | Contar comentarios y reacciones de las publicaciones de la página | Publicaciones → Resultados |

## 2. Texto para cada permiso (se pega en "Describe cómo usa tu app este permiso")

Van en inglés porque los revisores de Meta trabajan en inglés.

**instagram_manage_messages**

> VELAMIA Platform is the customer-service inbox of our own business, VELAMIA (candles and event favors, Ecuador). We use instagram_manage_messages to receive the direct messages that customers send to our Instagram professional account (@velamia.ec) and to reply to them from our CRM. Incoming messages arrive through the messages webhook and appear in the "Conversaciones" inbox, next to our WhatsApp and Messenger chats. Our team replies from the CRM, and an automated assistant answers common questions (prices, catalog photos, delivery) on the team's behalf; a team member can pause the assistant in any chat and take over. Messages are only sent in reply to a customer's message, within the 24-hour standard messaging window. We never send unsolicited or promotional messages on Instagram.

**pages_messaging**

> We use pages_messaging to receive the messages that customers send to our Facebook Page (velamia.ec) through Messenger and to reply to them from the same CRM inbox. Messages arrive through the Page's messages webhook, are stored in the conversation, and our team (or the automated assistant, which a team member can pause at any time) replies with text and product photos. Messages are only sent in reply to a customer's message, within the 24-hour standard messaging window. We do not use message tags or send promotional messages.

**instagram_manage_comments**

> We use instagram_manage_comments to read the comments that people leave on our own Instagram posts and to answer them. When someone asks a question in a comment (for example the price of a product), the CRM posts a short public reply to that comment and sends one private reply so the conversation continues in direct messages, where our team answers. Comments are read only from media owned by our Instagram professional account; we do not read or store comments from other accounts.

**pages_read_engagement**

> We use pages_read_engagement to read our own Page's information and the comments and reactions on the posts published by our Page. This lets the CRM show our team new comments on our posts so they can be answered, and lets us read the Instagram professional account linked to the Page. Only content from our own Page is read.

**pages_manage_metadata**

> We use pages_manage_metadata to subscribe our Page to the app's webhooks (messages, messaging_postbacks, message_echoes and feed) when the Page admin connects it from the CRM. This is what allows new messages and comments to reach the CRM in real time. We do not change any other Page setting.

**pages_show_list**

> We use pages_show_list during Facebook Login so the person connecting the CRM can see and choose which of the Pages they manage will be connected. We only store the Page they select.

**instagram_basic**

> We use instagram_basic to read the id and username of the Instagram professional account linked to the connected Page, so the CRM can show which Instagram account is connected and route its messages and comments to the right inbox.

**business_management**

> Our Page and Instagram account belong to a business portfolio. We use business_management so that Facebook Login returns the Pages and Instagram accounts owned by that portfolio when the admin connects the CRM. We do not read or change any other business asset.

**instagram_content_publish**

> We use instagram_content_publish to publish our own product photos and stories to our Instagram professional account from the "Publicaciones" section of the CRM. A team member prepares the image and caption, schedules or approves it, and the CRM publishes it through the content publishing API. Only content created by our team is published, and only to our own account.

**pages_manage_posts**

> We use pages_manage_posts to publish our own product photos and texts to our Facebook Page from the "Publicaciones" section of the CRM, together with the Instagram post. Only content created by our team is published, and only to our own Page.

**instagram_manage_insights**

> We use instagram_manage_insights to read reach, views, saves and shares of the posts and stories that the CRM published to our Instagram account. These numbers are shown to our team in "Publicaciones → Resultados" so they can see which products get more interest. The data is used only inside our CRM.

**read_insights**

> We use read_insights to read the performance metrics of the posts that the CRM published to our Facebook Page, shown to our team in "Publicaciones → Resultados". The data is used only inside our CRM.

**pages_read_user_content**

> We use pages_read_user_content to read the comments and reactions that people leave on the posts of our own Page, so the CRM can count them in "Publicaciones → Resultados" and show our team the comments that need an answer. Only content on our own Page is read.

**whatsapp_business_messaging**

> We use whatsapp_business_messaging to receive the WhatsApp messages that customers send to our business phone number and to reply to them from the CRM inbox ("Conversaciones"). Our team replies from the CRM, and an automated assistant answers common questions (prices, catalog photos, delivery); a team member can pause the assistant in any chat and take over. Free-form messages are only sent inside the 24-hour customer service window; outside that window we only send approved message templates, and customers can opt out by replying "NO".

**whatsapp_business_management**

> We use whatsapp_business_management to subscribe the WhatsApp Business Account to the app's webhooks so incoming messages reach the CRM, to read the phone number connected to the account, and to read the approved message templates that the CRM uses for follow-up messages. We do not create or modify any other business asset.

**public_profile**

> We use public_profile only as part of Facebook Login, to identify the person who connects their Facebook Page to the CRM. We do not store or display profile information.

## 3. Guion del video (grabación de pantalla, sin voz, 3 a 5 minutos)

Meta quiere ver el recorrido completo: cómo se conecta la cuenta y cómo se usa cada permiso. Grabar en este orden:

1. Entrar al CRM con usuario y contraseña.
2. Configuración → **Conectar con Facebook**: que se vea la ventana de Facebook, la lista de páginas, la página
   velamia.ec marcada, los permisos, y la vuelta al CRM con "Conectado: velamia.ec, Instagram @velamia.ec".
3. Desde un celular (que se vea en pantalla o en una segunda toma), enviar un mensaje directo a @velamia.ec en Instagram.
   En el CRM: Conversaciones → filtro **Instagram** → abrir el chat → se ve el mensaje → contestar desde el CRM →
   mostrar la respuesta recibida en el celular.
4. Lo mismo por Messenger con la página de Facebook: filtro **Facebook** → mensaje → respuesta.
5. Comentar una publicación de Instagram ("¿precio?") → mostrar la respuesta pública en el comentario y el chat que se
   abre en el CRM. Repetir con un comentario en la página de Facebook.
6. Publicaciones → preparar una publicación → publicarla → mostrarla publicada en Instagram y en la página de Facebook.
7. Publicaciones → **Resultados**: mostrar los números (me gusta, comentarios, alcance) de lo publicado.

Mientras la app no tenga el acceso avanzado, los pasos 3 a 5 se graban con una cuenta que tenga rol en la app
(administrador o probador): con esas cuentas sí llegan los mensajes.

## 4. Antes de enviar (configuración de la app)

- Ícono de la app (1024 × 1024).
- URL de la política de privacidad: `https://asistente.velamia.shop/privacidad`
- URL de las condiciones: `https://asistente.velamia.shop/condiciones`
- Instrucciones para eliminar datos: `https://asistente.velamia.shop/privacidad` (explica cómo pedir el borrado).
- Categoría de la app y correo de contacto.
- Verificación del negocio completada en Meta Business.

## 5. Acceso para el revisor

El revisor entra a una **empresa de demostración** (sin chats ni datos de clientas reales), con un usuario Dueño creado
solo para él: ahí puede conectar su propia página de prueba, publicar y ver resultados sin tocar la conexión de
VELAMIA. Los mensajes los prueba escribiéndole a la página de VELAMIA, y el recorrido completo va en el video.

Texto para "Proporciona las instrucciones para acceder a la app":

> VELAMIA Platform is the CRM that our own business (VELAMIA, Ecuador) uses to answer customers on Messenger, Instagram and WhatsApp and to publish our own posts. It is used by our team, not by the general public.
>
> HOW TO ACCESS
> 1. Open https://asistente.velamia.shop/crm/
> 2. Sign in with the test credentials provided in the access-code field below. They open a demo business that contains no real customer data.
> 3. Open the "Publicaciones" tab. In the "Canales conectados" card click "Administrar conexión". This starts Facebook Login: choose a Facebook Page and its linked Instagram professional account and accept the permissions. The card then shows the connected Page and Instagram account (public_profile, pages_show_list, business_management, pages_read_engagement, pages_manage_metadata, instagram_basic).
> 4. In "Publicaciones", create a post with a photo and a caption and publish it to Instagram and to the Facebook Page (instagram_content_publish, pages_manage_posts).
> 5. In "Publicaciones → Resultados" the CRM shows likes, comments and reach of the published posts (instagram_manage_insights, read_insights, pages_read_user_content).
>
> MESSAGING (pages_messaging, instagram_manage_messages, instagram_manage_comments, whatsapp_business_messaging, whatsapp_business_management)
> The inbox is connected to our own Page, Instagram account and WhatsApp number. Those conversations contain our customers' personal data, so they are not available in the demo business. To test messaging:
> 1. Open https://m.me/1044219295441808 and send a message in Spanish, for example "Hola, quiero información de precios".
> 2. The Page replies within one to two minutes.
> 3. The same works by sending a direct message to @velamia.ec on Instagram.
> The attached screen recording shows the complete flow inside the CRM inbox: incoming Messenger, Instagram and WhatsApp messages, the replies sent from the CRM, and the reply to an Instagram comment.
