/**
 * Candados de los arreglos del chat del CRM (9-oct-2026) y de la revisión del catálogo (7-oct-2026): si alguno se
 * pierde, esta prueba falla antes de publicar. Ver docs/ARREGLOS.md.
 */
import './entorno';

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';
import { documentContent, sendDocumentMessage } from '../src/services/whatsapp';

const html = readFileSync('dashboard/index.html', 'utf8');
const server = readFileSync('src/index.ts', 'utf8');
const delivery = readFileSync('src/services/delivery.ts', 'utf8');

test('chat: se pueden enviar fotos y PDF; el iPhone entrega las fotos en JPG (no se piden en HEIC)', () => {
  assert.ok(html.includes("accept: 'image/*'"), 'el botón Fotos debe pedir image/* para que el iPhone convierta a JPG');
  assert.ok(!/accept\s*=\s*'image\/\*,\.heic/.test(html), 'pedir .heic hace que el iPhone mande HEIC y la foto se rechaza');
  assert.ok(html.includes("api('/api/send-document'"), 'el CRM debe poder enviar PDF y documentos');
  assert.ok(!/const caption = prompt\(/.test(html), 'el texto de la foto se escribe en la vista previa, no en un prompt()');
  assert.ok(server.includes("app.post('/api/send-document'"), 'falta la ruta para enviar documentos');
  assert.match(server, /BIG_BODY_PATHS = new Set\(\[[^\]]*'\/api\/send-document'/, 'la ruta de documentos necesita aceptar archivos grandes');
});

test('chat: un PDF queda en el historial con su nombre y, si pasaron 24 h, se guarda y sale después como documento', async () => {
  assert.equal(documentContent('https://x/a.pdf', 'Cotizacion.pdf', 'Hola'), 'https://x/a.pdf\n📄 Cotizacion.pdf\nHola');
  assert.equal(documentContent('https://x/a.pdf', 'Cotizacion.pdf'), 'https://x/a.pdf\n📄 Cotizacion.pdf');
  await assert.rejects(sendDocumentMessage('ig:1', 'https://x/a.pdf', 'a.pdf'), /solo se envían por WhatsApp/);
  assert.match(delivery, /PendingKind = [^;]*'document'/);
  assert.match(delivery, /item\.kind === 'document'\) return sendDocumentMessage/);
});

test('chat: sin botón ni opción de nota interna (Aura no la usa)', () => {
  assert.ok(!html.includes("className={'nx-note-btn'"), 'volvió el botón Nota del chat');
  assert.ok(!html.includes("'Escribir nota interna'"), 'volvió la opción de nota interna en el celular');
});

test('chat: Cerrar, bot, Datos y Más van arriba a la derecha y el chat tiene más espacio para los mensajes', () => {
  assert.ok(html.includes('.nx-shell .nx-chat-head { flex-wrap: nowrap;'), 'los botones de la cabecera deben quedar en la misma fila del nombre');
  assert.ok(html.includes('.nx-shell .nx-head-actions { flex-wrap: nowrap; flex-shrink: 0; margin-left: auto;'));
  assert.ok(/@media \(max-width: 1500px\) \{\s*\.nx-shell \.nx-content \{ grid-template-columns: 360px minmax\(0, 1fr\); \}/.test(html), 'el resumen lateral se esconde para darle ancho al chat');
});

test('lista de chats: la hora y el orden son los del último mensaje enviado o recibido', () => {
  assert.equal(html.split('listTime(lastActivity(conv))').length - 1, 2, 'la hora de la lista (celular y computador) debe ser la del último mensaje');
  assert.ok(!html.includes('listTime(conv.last_message_time)'), 'last_message_time solo cambia con mensajes de la clienta');
  assert.ok(html.includes('}).sort((a, b) => activityMs(b) - activityMs(a));'), 'la lista se ordena por el último mensaje');
});

test('revisión del catálogo: apagada salvo que se encienda a mano (no gasta IA sola)', () => {
  assert.ok(readFileSync('src/services/catalogReview.ts', 'utf8').includes('enabled: s.enabled === true'));
});

test('revisión del catálogo pausada: el reporte no habla del catálogo y la pantalla dice "pausada"', () => {
  const review = readFileSync('src/services/catalogReview.ts', 'utf8');
  assert.ok(review.includes("return state.enabled ? state.findings.filter(f => f.status === 'pendiente').length : 0;"), 'pausada, el reporte diario no debe decir "cosas del catálogo por revisar"');
  assert.ok(/async function catalogTick[\s\S]{0,300}if \(!\(await readState\(\)\)\.enabled\) return;/.test(review), 'la vuelta automática no revisa si está pausada');
  assert.ok(html.includes("{data.enabled ? '(' + data.pending.length + ')' : '· pausada'}"));
  assert.ok(html.includes('no revisa nada sola ni gasta IA'));
});

test('Render publica solo cuando pasan las pruebas de GitHub (nada que rompa un candado llega a producción)', () => {
  assert.match(readFileSync('render.yaml', 'utf8'), /^\s+autoDeployTrigger: checksPass$/m);
  assert.match(readFileSync('.github/workflows/pruebas.yml', 'utf8'), /run: npm test/);
});
