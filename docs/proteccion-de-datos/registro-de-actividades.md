# Registro de Actividades de Tratamiento (RAT)

Responsable: el negocio que usa el asistente (VELAMIA o la empresa de Nexly), con los datos de Configuración →
Privacidad y datos. Encargado técnico de la plataforma: Nexly. Actualizar este registro cuando cambie un proceso.

| # | Actividad | Finalidad | Titulares | Datos | Base legal (art. 7 LOPDP) | Destinatarios / encargados | Transferencia internacional | Conservación | Medidas de seguridad |
|---|---|---|---|---|---|---|---|---|---|
| 1 | Atención por WhatsApp, Instagram y Messenger | Responder consultas, enviar fotos y precios | Clientes y posibles clientes | Nombre de perfil, teléfono o usuario, mensajes, audios, fotos, documentos | Medidas precontractuales a pedido del titular | Meta, OpenAI (entender, responder, transcribir), Supabase, Render, ElevenLabs (notas de voz) | Sí: EE. UU./Irlanda | Mientras dure la relación; borrado automático opcional de chats sin pedidos | HTTPS, roles, sesiones firmadas, claves cifradas, registros enmascarados |
| 2 | Cotizaciones y pedidos | Cotizar, registrar, cobrar y entregar | Clientes | Productos, personalización, fecha del evento, ciudad y dirección, comprobante de pago | Ejecución del contrato | Supabase, Render, empresa de envíos | Sí (Supabase, Render) | Hasta 7 años (obligaciones tributarias) | Igual que 1; acceso por rol |
| 3 | Seguimientos comerciales | Recordar cotizaciones y ofrecer productos | Clientes que escribieron primero | Teléfono, nombre, historial del chat | Interés legítimo + consentimiento (se retira con "NO") | Meta (plantillas) | Sí | Hasta que se oponga | Corte automático al pedir no recibir mensajes |
| 4 | Supervisor de chats | Mejorar las respuestas (aprendizajes aprobados por la dueña) y reporte diario | Clientes | Extractos de conversación, nombre de perfil | Interés legítimo | OpenAI, Supabase | Sí | Aprendizajes: se filtran teléfonos y correos (queda el nombre de perfil de origen); reportes: 60 días | Aprobación humana antes de usar un aprendizaje |
| 5 | Avisos al equipo | Avisar a la dueña de pagos, reclamos o preguntas | Clientes | Nombre, teléfono, extracto del mensaje | Ejecución del contrato / interés legítimo | Meta | Sí | Historial de avisos del chat | Solo al número configurado |
| 6 | Usuarios del CRM | Dar acceso al equipo | Personal de la empresa | Correo, contraseña (hash scrypt), rol | Ejecución del contrato laboral o de servicio | Supabase, Render | Sí | Mientras tenga acceso | Contraseñas con hash, bloqueo por intentos |
| 7 | Publicaciones en redes | Publicar productos | — (solo fotos de productos) | Sin datos personales | — | Meta, OpenAI (textos) | Sí | — | — |
