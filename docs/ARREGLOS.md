# Registro de arreglos sellados

Cada arreglo del CRM, del asistente IA o de la infraestructura se anota aquí con su candado (la prueba que falla si el
error vuelve). Regla obligatoria: ver [CLAUDE.md](../CLAUDE.md). Antes de arreglar algo, buscar aquí si ya pasó.

Desde el 10-oct-2026 **todas las pruebas que ya existían (431) quedaron selladas** en `tests/candados.json`: los arreglos
anteriores a esta lista ya están protegidos por esas pruebas.

| Fecha | Qué pasaba | Qué se hizo | Candado (prueba) |
|---|---|---|---|
| 2026-10-07 | Los nombres corregidos en el catálogo del CRM no cambiaban en la página web | La web sigue al nombre del CRM si el suyo era copia; los escritos en mayúsculas se ven como el resto | `el nombre de la web: escrito todo en mayúsculas se ve como el resto de la tienda; si era copia del CRM, sigue al nombre nuevo` |
| 2026-10-07 | El catálogo no llegaba a la web cuando el panel estaba dormido (error 502 de Render) | Despertar el panel y reintentar; se anota cada intento fallido | `si la web está despertando (502 de Render) se espera y se repite; un error del panel no se repite` |
| 2026-10-07 | La revisión del catálogo gastaba IA sola | Apagada salvo que se encienda a mano ("Revisar ahora") | `revisión del catálogo: apagada salvo que se encienda a mano (no gasta IA sola)` |
| 2026-10-08 | El creador de campañas cambiaba las fotos elegidas y los textos no tenían que ver con las fotos | Respeta las piezas elegidas; la IA mira cada foto antes de escribir | pruebas de `tests/crear-campanas.test.ts` |
| 2026-10-09 | No se podían enviar fotos (iPhone mandaba HEIC) ni PDF desde el celular | Botones Fotos y PDF o documento, vista previa con texto, ruta `/api/send-document` | `chat: se pueden enviar fotos y PDF; el iPhone entrega las fotos en JPG (no se piden en HEIC)` y `chat: un PDF queda en el historial con su nombre y, si pasaron 24 h, se guarda y sale después como documento` |
| 2026-10-09 | El botón Nota estorbaba; los botones del chat ocupaban espacio de los mensajes | Sin Nota; Cerrar, bot, Datos y Más arriba a la derecha; chat más ancho | `chat: sin botón ni opción de nota interna (Aura no la usa)` y `chat: Cerrar, bot, Datos y Más van arriba a la derecha y el chat tiene más espacio para los mensajes` |
| 2026-10-09 | La hora de la lista de chats no cambiaba al responder | La hora y el orden siguen al último mensaje enviado o recibido (los seguimientos siguen usando la última respuesta de la clienta) | `lista de chats: la hora y el orden son los del último mensaje enviado o recibido` |
