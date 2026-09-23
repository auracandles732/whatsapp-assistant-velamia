/**
 * Notas de voz de VELAMIA: una al día por chat, cuando la clienta responde después de ver fotos, y nunca con precios o
 * listas. También: descargas solo desde servidores de Meta y una respuesta automática cada 6 horas por persona que comenta.
 */
import './entorno';

import test from 'node:test';
import assert from 'node:assert/strict';
import { voiceNoteFits, speakableText } from '../src/services/voiceNotes';
import { isMp3 } from '../src/services/audio';
import { isMetaMediaUrl } from '../src/services/metaChannels';
import { commenterOnCooldown } from '../src/controllers/socialController';

const ahora = Date.parse('2026-09-23T20:00:00Z');
const conFotos = [
  { sender: 'customer', type: 'text', content: 'Para baby shower', timestamp: '2026-09-23T19:50:00' },
  { sender: 'bot', type: 'text', content: 'Te muestro los modelos', timestamp: '2026-09-23T19:51:00' },
  { sender: 'bot', type: 'image', content: 'https://x/1.jpg\n🕯️ *OSITO*', timestamp: '2026-09-23T19:51:10' },
  { sender: 'bot', type: 'text', content: '¿Alguno te gustó?', timestamp: '2026-09-23T19:51:20' }
];

test('responde con voz cuando la clienta contesta después de ver fotos', () => {
  assert.equal(voiceNoteFits({ history: conFotos, reply: '¡Qué lindo que te gustó el osito! 🤍 ¿Para cuántos invitados sería?', now: ahora }), true);
});

test('sin fotos antes, con precios, listas o texto largo va por escrito', () => {
  assert.equal(voiceNoteFits({ history: conFotos.slice(0, 2), reply: '¿Para cuántos invitados?', now: ahora }), false);
  assert.equal(voiceNoteFits({ history: conFotos, reply: 'El osito cuesta $30.00 la docena', now: ahora }), false);
  assert.equal(voiceNoteFits({ history: conFotos, reply: '🕯️ *Modelo:* Osito\n📦 *Cantidad:* 3 docenas', now: ahora }), false);
  assert.equal(voiceNoteFits({ history: conFotos, reply: 'Opciones:\n- Osito\n- Jirafa', now: ahora }), false);
  assert.equal(voiceNoteFits({ history: conFotos, reply: 'a'.repeat(400), now: ahora }), false);
});

test('una sola nota de voz al día por chat', () => {
  const conAudio = [{ sender: 'bot', type: 'audio', content: 'https://x/v.ogg\n🎤 "hola"', timestamp: '2026-09-23T10:00:00' }, ...conFotos];
  assert.equal(voiceNoteFits({ history: conAudio, reply: '¿Para cuántos invitados?', now: ahora }), false);
  const ayer = [{ sender: 'bot', type: 'audio', content: 'https://x/v.ogg', timestamp: '2026-09-22T10:00:00' }, ...conFotos];
  assert.equal(voiceNoteFits({ history: ayer, reply: '¿Para cuántos invitados?', now: ahora }), true);
});

test('lo que se lee en voz alta va sin emojis, asteriscos ni enlaces', () => {
  assert.equal(speakableText('¡Hola! 🤍 El *osito* es lindo ✨\n\nMira https://velamia.shop'), '¡Hola! El osito es lindo\nMira');
});

test('solo se convierte a nota de voz un MP3 de verdad', () => {
  assert.equal(isMp3(Buffer.from('ID3\x04\x00\x00', 'latin1')), true);
  assert.equal(isMp3(Buffer.from([0xff, 0xfb, 0x90, 0x64])), true);
  assert.equal(isMp3(Buffer.from('#EXTM3U\nfile:///etc/passwd')), false);
});

test('los archivos de Instagram y Messenger solo se descargan de servidores de Meta', () => {
  assert.equal(isMetaMediaUrl('https://scontent.xx.fbcdn.net/v/t1.jpg'), true);
  assert.equal(isMetaMediaUrl('https://lookaside.fbsbx.com/ig_messaging_cdn/?asset_id=1'), true);
  assert.equal(isMetaMediaUrl('https://instagram.fgye1-1.fna.fbcdn.net/x.jpg'), true);
  assert.equal(isMetaMediaUrl('http://scontent.xx.fbcdn.net/x.jpg'), false);
  assert.equal(isMetaMediaUrl('https://fbcdn.net.atacante.com/x.jpg'), false);
  assert.equal(isMetaMediaUrl('https://169.254.169.254/latest/meta-data'), false);
  assert.equal(isMetaMediaUrl('no es una url'), false);
});

test('quien no ha comentado antes no está en espera', () => {
  assert.equal(commenterOnCooldown('persona-nueva'), false);
  assert.equal(commenterOnCooldown(''), false);
});
