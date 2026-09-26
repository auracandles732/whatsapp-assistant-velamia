# Protección de datos personales · Ecuador

Guía de cumplimiento del asistente de WhatsApp y CRM (VELAMIA y las empresas de la plataforma Nexly) con la
**Ley Orgánica de Protección de Datos Personales (LOPDP)**, su **Reglamento General** y las normas de la
**Superintendencia de Protección de Datos Personales (SPDP)**, más lo que aplica de la **Ley Orgánica de Defensa del
Consumidor** y la **Ley de Comercio Electrónico, Firmas Electrónicas y Mensajes de Datos**.

> Esto es una guía técnica y de buenas prácticas, no asesoría legal. Conviene revisarla una vez con un abogado de
> protección de datos antes de presentarla ante la SPDP.

Revisado: 26 de septiembre de 2026.

## Qué ya hace el sistema

| Obligación | Cómo se cumple en el sistema |
|---|---|
| Deber de informar (art. 12 LOPDP) | Página pública **/privacidad** (y /legal/&lt;empresa&gt;/privacidad para cada empresa) armada con el perfil; el asistente manda el enlace en su primera respuesta a cada cliente nuevo (se puede apagar en Configuración → Privacidad y datos). |
| Condiciones de venta (LODC, Comercio Electrónico) | Página pública **/condiciones** con pago, anticipo, entrega, devoluciones (art. 45 LODC) y reclamos. |
| Derechos de los titulares (arts. 13–24) | Si la clienta pide ver o borrar sus datos, el asistente le confirma el plazo de 15 días, deja de enviarle seguimientos y avisa a la dueña. En el CRM: **Descargar datos del cliente** (acceso y portabilidad) y **Eliminar chat** (eliminación). Ver [derechos-de-los-titulares.md](derechos-de-los-titulares.md). |
| Oposición a publicidad (Comercio Electrónico, LOPDP) | Los seguimientos se cortan si la clienta responde NO o pide que no le escriban. |
| Conservación limitada (art. 10) | Configuración → Privacidad y datos: borrado automático de chats sin pedidos después de 6 meses a 5 años (apagado por defecto; se recomiendan 2 años). |
| Seguridad (art. 37) | HTTPS; claves de terceros cifradas (AES-256-GCM); sesiones firmadas que vencen; contraseñas con scrypt; roles (administradora, dueña, encargada, personal); bloqueo por intentos fallidos; CSP y cabeceras de seguridad; firma de los webhooks de Meta; el servidor solo descarga fotos de su propio almacenamiento; teléfonos enmascarados en los registros. |
| Rendición de cuentas (art. 47) | **Registro de seguridad** en Configuración → Privacidad y datos: descargas y borrados de datos, borrados por plazo y pedidos de clientes. |
| Registro de actividades (RAT) | [registro-de-actividades.md](registro-de-actividades.md). |
| Vulneraciones (art. 43) | [procedimiento-vulneraciones.md](procedimiento-vulneraciones.md): SPDP en 5 días, titulares en 3 días. |
| Encargados y transferencias internacionales (arts. 33, 55–61; Res. SPDP-SPD-2026-0004-R) | [encargados-y-transferencias.md](encargados-y-transferencias.md). |

## Lo que tiene que hacer la dueña (no se puede hacer desde el código)

1. **Completar Configuración → Privacidad y datos**: razón social o nombre, RUC, dirección y un correo para temas de datos. Sin eso la política sale solo con el nombre comercial.
2. **Publicar los enlaces** de /privacidad y /condiciones en la descripción de WhatsApp Business, Instagram y Facebook, y en la web. Meta también los pide para la revisión de la App.
3. **Aceptar o descargar los acuerdos de tratamiento de datos (DPA)** de cada proveedor (enlaces en [encargados-y-transferencias.md](encargados-y-transferencias.md)) y guardarlos al menos 3 años.
4. **Registrar las transferencias internacionales** en el Registro Nacional de la SPDP cuando la plataforma lo habilite (Res. SPDP-SPD-2026-0004-R): hay un plazo de regularización para las que ya existían.
5. **Delegado de protección de datos**: una tienda que vende por WhatsApp no está en los 14 sectores obligados (Res. SPDP-SPD-2025-0028-R), pero uno de ellos incluye "inteligencia artificial". Confirmarlo con el abogado, sobre todo para **Nexly** como plataforma que atiende a varias empresas con IA.
6. **Elegir el plazo de conservación** (recomendado: 2 años para chats sin pedidos).
7. **Responder cada pedido de un cliente sobre sus datos en máximo 15 días** (llega como aviso por WhatsApp).
8. **Contrato con cada empresa cliente de Nexly** (Nexly es su encargado del tratamiento): incluir cláusulas de encargo según el art. 34 LOPDP.

## Referencias

- [LOPDP (texto)](https://www.finanzaspopulares.gob.ec/wp-content/uploads/2021/07/ley_organica_de_proteccion_de_datos_personales.pdf)
- [Reglamento General a la LOPDP](https://www.cosede.gob.ec/wp-content/uploads/2023/12/REGLAMENTO-GENERAL-A-LA-LEY-ORG%C3%81NICA-DE-PROTECCION-DE-DATOS-PERSONALES_compressed-1.pdf)
- [Resoluciones de la SPDP](https://spdp.gob.ec/resoluciones2/): delegado (SPDP-SPD-2025-0028-R), transferencias (SPDP-SPD-2025-0024-R y SPDP-SPD-2026-0004-R)
- [Ley de Comercio Electrónico, Firmas y Mensajes de Datos](https://www.gob.ec/regulaciones/ley-comercio-electronico-firmas-mensaje-datos)
