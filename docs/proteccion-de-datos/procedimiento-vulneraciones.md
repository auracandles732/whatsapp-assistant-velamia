# Procedimiento ante una vulneración de seguridad (art. 43 LOPDP)

Una vulneración es cualquier acceso, pérdida, alteración o divulgación no autorizada de datos personales: por ejemplo,
una clave filtrada (Supabase, WhatsApp, OpenAI), un usuario del CRM que no debía entrar, un celular robado con la sesión
abierta o un archivo con datos de clientes enviado a quien no correspondía.

## Plazos

- **Superintendencia de Protección de Datos Personales: máximo 5 días** desde que se conoce. No notificar es infracción grave (art. 68).
- **Clientes afectados: máximo 3 días** si hay riesgo para sus derechos, en lenguaje claro.

## Pasos

1. **Contener (mismo día)**
   - Cambiar la clave comprometida: variables de Render (SUPABASE_SERVICE_KEY, WHATSAPP_TOKEN, OPENAI_API_KEY, CRM_PASSWORD, BUSINESS_SECRETS_KEY) o las claves de la empresa en el CRM. Cambiar CRM_PASSWORD cierra todas las sesiones.
   - Desactivar al usuario del CRM involucrado (Empresas → usuarios).
   - Si fue un celular: cerrar sesión de WhatsApp Web / CRM desde otro equipo.
2. **Evaluar**: qué datos, de cuántos clientes, desde cuándo, y si hay riesgo (estafas, suplantación).
   - Revisar el **Registro de seguridad** (Configuración → Privacidad y datos) y los registros de Render.
3. **Notificar a la SPDP** (≤ 5 días) por los canales de [spdp.gob.ec](https://spdp.gob.ec): qué pasó, datos y personas afectadas, consecuencias probables, medidas tomadas, contacto del responsable.
4. **Avisar a los clientes** (≤ 3 días, si hay riesgo): qué pasó, qué datos, qué hicimos y qué pueden hacer (por ejemplo, desconfiar de mensajes que pidan pagos a otras cuentas).
5. **Documentar** en una hoja: fecha de detección, causa, datos afectados, notificaciones enviadas y medidas para que no se repita. Guardarla al menos 3 años.
