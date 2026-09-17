# Plataforma de empresas: cómo agregar y administrar una empresa

Todas las empresas comparten este mismo servidor, base de datos y CRM, pero cada una tiene lo suyo por separado:
número de WhatsApp, clave de OpenAI, chats, catálogo, cotizaciones, pedidos, configuración, archivos y usuarios.
VELAMIA es la instalación original: aparece como una empresa más, con sus datos y claves en el servidor.

Link del CRM: `https://whatsapp-assistant-velamia.onrender.com/crm/`

## 1. Qué necesita la empresa antes de empezar

| Qué | Dónde se consigue | Para qué |
|---|---|---|
| Número de WhatsApp registrado en la API | Meta Business → WhatsApp Manager | Recibir y enviar mensajes |
| Phone Number ID y WhatsApp Business Account ID | Meta for Developers → WhatsApp → Configuración de la API | Saber qué número atiende |
| Token permanente de Meta | Meta Business → Usuarios del sistema → Generar token (permisos `whatsapp_business_messaging` y `whatsapp_business_management`) | Que el bot hable desde ese número |
| Clave de OpenAI (API key) | platform.openai.com → API keys, con saldo cargado | El "cerebro" del bot. Sin ella no responde |

La cuenta de WhatsApp de la empresa debe estar en la **misma App de Meta** que usa la plataforma
(la del webhook y `META_APP_SECRET`), o haberle dado acceso a esa App.

## 2. Crear la empresa (usuario `admin`)

1. Entrar al CRM con usuario `admin` y la contraseña maestra.
2. **+ Nueva empresa**: nombre y tipo (tienda por unidad o detalles para eventos). Las claves se pueden cargar ahí o después.
3. En la tarjeta de la empresa → **🔑 Claves**: cargar número, Phone Number ID, WABA ID, token de Meta y clave de OpenAI → **Guardar claves**.
4. **Probar conexión**: confirma que Meta y OpenAI aceptan las claves.
5. **📲 Conectar WhatsApp**: suscribe la cuenta de la empresa a la App. Sin este paso Meta no envía sus mensajes al bot.
6. **Entrar** a la empresa y completar ⚙️ Configuración (número para avisos a la dueña, datos bancarios, instrucciones) y 🛍️ Catálogo.
7. **👤 Usuarios**: crear el acceso del dueño (correo, contraseña y rol).

La tarjeta muestra si el bot está listo:
- 🔴 obligatorio (WhatsApp, número conectado, OpenAI): sin esto **el bot no atiende**.
- ⚠️ recomendado (catálogo, número para avisos, datos bancarios): atiende, pero incompleto.

## 3. Accesos

- **Administradora:** usuario `admin` + contraseña maestra (`CRM_PASSWORD`). Ve todas las empresas y elige con cuál trabajar.
- **Usuarios de una empresa:** correo + contraseña (mínimo 8 caracteres). Entran directo a su empresa y no ven las demás.
- Roles: **Dueño** (todo, incluidas claves y configuración) · **Encargado** (atiende, catálogo y pedidos; no cambia configuración) · **Solo consulta**.
- Cada usuario cambia su contraseña con **Mi contraseña**; la administradora puede cambiarla o desactivar al usuario.

## 4. Suspender y eliminar

- **⏸️ Suspender:** el bot deja de responder, se detienen los seguimientos y sus usuarios no entran. No se borra nada; **▶️ Reactivar** lo devuelve todo.
- **🗑️ Eliminar:** borra para siempre chats, mensajes, seguimientos, avisos, cotizaciones, pedidos, catálogo, fotos y archivos,
  usuarios, configuración y claves. Exige suspender antes y escribir el nombre exacto.

## 5. Seguimientos automáticos y avisos fuera de 24 h

Necesitan **plantillas aprobadas por Meta en la cuenta de esa empresa**. Mientras no las tenga, dejar los seguimientos
apagados en ⚙️ Configuración. Los avisos a la dueña se envían como texto libre si no hay plantilla (solo llegan si
la dueña le escribió al número en las últimas 24 horas).

## 6. Cómo funciona por dentro (referencia técnica)

- Cada mensaje de WhatsApp trae el `phone_number_id` del número que lo recibió: con él se sabe de qué empresa es.
  Si es `WHATSAPP_PHONE_ID` es VELAMIA; si no pertenece a ninguna empresa activa, se ignora.
- Todo corre dentro del contexto de la empresa (`src/services/tenant.ts`): sus claves, su perfil y solo sus datos
  (`business_id`). VELAMIA = sin `business_id` y variables de entorno.
- Token de Meta y clave de OpenAI se guardan cifrados (AES-256-GCM) con `BUSINESS_SECRETS_KEY`.
  **No cambiar ni perder esa variable**: las claves guardadas quedarían ilegibles.
- Configuración por empresa en `business_config` con claves `business:<id>:<clave>`; archivos en la carpeta `<id>/` de cada bucket.
- Migraciones de la plataforma: `007` a `018`.
