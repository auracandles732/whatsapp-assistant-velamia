# Encargados del tratamiento y transferencias internacionales

Los proveedores del sistema tratan datos por encargo del negocio (art. 33 LOPDP). Como están fuera del Ecuador, hay
**transferencia internacional** (arts. 55–61; Res. SPDP-SPD-2025-0024-R y SPDP-SPD-2026-0004-R). Estados Unidos no
tiene nivel adecuado reconocido, así que la vía es usar **garantías adecuadas**: el acuerdo de tratamiento de datos
(DPA) del proveedor más las cláusulas contractuales, informarlo en la política de privacidad (ya está) y registrar la
transferencia en la SPDP cuando habilite el registro.

| Proveedor | Para qué | Datos | Dónde | Acuerdo de tratamiento (DPA) |
|---|---|---|---|---|
| Meta Platforms (WhatsApp Business, Instagram, Messenger) | Recibir y enviar mensajes | Teléfono, nombre de perfil, mensajes y archivos | EE. UU. / Irlanda | Condiciones de WhatsApp Business y términos de tratamiento de datos de Meta (se aceptan en Meta Business) |
| OpenAI | Entender y preparar respuestas, leer fotos, transcribir audios, supervisor y agente de redes | Mensajes y archivos del chat | EE. UU. | DPA de OpenAI: se firma desde la configuración de la organización en platform.openai.com. Por defecto la API no usa los datos para entrenar. |
| Supabase | Base de datos y archivos | Todo lo del CRM | EE. UU. (región del proyecto) | DPA de Supabase (en el panel de la organización: Legal Documents) |
| Render | Servidor de la aplicación | Todo lo que pasa por el servidor (en memoria y en los registros) | EE. UU. | DPA de Render (render.com/dpa) |
| ElevenLabs (solo si se usan notas de voz) | Voz de las respuestas | Texto de la respuesta | EE. UU. | DPA de ElevenLabs |
| Empresa de envíos | Entregar pedidos | Nombre, teléfono, dirección | Ecuador | Acuerdo de confidencialidad o condiciones del servicio |

## Qué guardar (al menos 3 años)

- Copia o captura de cada DPA aceptado, con la fecha.
- El análisis de riesgos: ubicación de los servidores en EE. UU., cifrado, control de acceso y retención (ver el README).
- La constancia del registro de transferencias internacionales en la SPDP.

## Nexly y sus empresas clientes

Para cada empresa que usa la plataforma, la empresa es la **responsable** y Nexly es su **encargado**. El contrato
de servicio debe tener las cláusulas del art. 34 LOPDP: tratar los datos solo según las instrucciones de la empresa,
confidencialidad, medidas de seguridad, ayudar con los derechos de los titulares y las vulneraciones, lista de
subencargados (la tabla de arriba) y devolución o borrado de los datos al terminar el servicio.
