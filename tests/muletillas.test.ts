/**
 * Muletillas: una persona no abre cinco mensajes seguidos con "Qué lindo". Se detectan las exclamaciones de relleno
 * y las fórmulas repetidas dentro de un mismo chat, con las respuestas reales que dio el asistente.
 */
import './entorno';

import test from 'node:test';
import assert from 'node:assert/strict';

import { recentOpeningsText } from '../src/services/openai';
import { fillerOpening, formulasIn, ticsIn, stripFillerOpening, withoutBrokenChars } from '../src/services/muletillas';

// Respuestas reales del asistente en un mismo chat (baby shower).
const chat = [
  'Qué lindo 💕 te comparto los modelos de *baby shower* que manejamos.',
  'Qué lindo, para *niña* suele quedar precioso en rosado o celeste 💖',
  'Qué lindo, el *Osito en nube con corazón* para *baby shower de niña* queda muy bien.',
  'Qué lindo va a quedar 🤍'
];

test('reconoce las exclamaciones de relleno más comunes', () => {
  assert.equal(fillerOpening('Qué lindo 💕 te comparto los modelos'), 'que + adjetivo');
  assert.equal(fillerOpening('Qué linda elección 🥰'), 'que + adjetivo');
  assert.equal(fillerOpening('¡Qué bonito para Cuenca!'), 'que + adjetivo');
  assert.equal(fillerOpening('Claro 🤍'), 'claro');
  assert.equal(fillerOpening('Perfecto, *3 docenas* de la cruz'), 'perfecto');
  assert.equal(fillerOpening('Sí, claro que se puede ✨'), 'si claro');
  assert.equal(fillerOpening('Listo 🤍 Para *3 docenas*'), 'listo');
});

test('un mensaje que empieza directo con la información no es relleno', () => {
  assert.equal(fillerOpening('Para *Guayaquil* te queda en *$124.00*'), '');
  assert.equal(fillerOpening('El valor total para *Quito* ya incluye el envío'), '');
  assert.equal(fillerOpening('Los precios son *por docena*'), '');
  assert.equal(fillerOpening('Somos de *Guayaquil* y enviamos a todo Ecuador'), '');
  assert.equal(fillerOpening('Tomé como referencia la *Cruz con flores*'), '');
});

test('caso real: el quinto "Qué lindo" seguido se marca como repetido', () => {
  const r = ticsIn('Qué lindo, queda perfecto para tu evento 🌸', chat);
  assert.equal(r.violates, true);
  assert.ok(/que \+ adjetivo|abriste/.test(r.why));
});

test('nunca dos exclamaciones de relleno seguidas, aunque sean distintas', () => {
  const r = ticsIn('Perfecto 🤍 son 4 docenas', ['Qué lindo 💕 te comparto los modelos']);
  assert.equal(r.violates, true);
  assert.match(r.why, /anterior/);
});

test('empezar directo después de un relleno está bien', () => {
  const r = ticsIn('Para *Guayaquil* te queda en *$124.00* 🕯️', ['Qué lindo 💕 te comparto los modelos']);
  assert.equal(r.violates, false);
});

test('un relleno espaciado entre mensajes directos es natural', () => {
  const r = ticsIn('Claro 🤍 con ese color queda bien', [
    'Para *Quito* el envío ya está incluido.',
    'El total es *$102.00*.',
    'La entrega es en 3 días.',
    'Los precios son por docena.'
  ]);
  assert.equal(r.violates, false);
});

test('detecta fórmulas de cortesía repetidas en el mismo chat', () => {
  assert.deepEqual(formulasIn('Con gusto te ayudo 🤍 Te comparto los modelos'), ['con gusto te ayudo', 'te comparto']);
  const r = ticsIn('Te comparto también los de bautizo ✨', ['Hola, te comparto los modelos de baby shower', 'Los precios son por docena.']);
  assert.ok(r.formulas.includes('te comparto'));
  assert.equal(r.violates, true);
});

test('una fórmula usada una sola vez en el chat no es muletilla', () => {
  const r = ticsIn('Te comparto los modelos de baby shower ✨', ['Hola, un gusto saludarte. ¿Qué evento es?']);
  assert.equal(r.formulas.length, 0);
});

test('quita la exclamación aislada y deja el mensaje empezando directo', () => {
  assert.equal(stripFillerOpening('Qué lindo 💕 te comparto los modelos de *baby shower* que manejamos.'), 'Te comparto los modelos de *baby shower* que manejamos.');
  assert.equal(stripFillerOpening('Claro, los precios son *por docena* y varían según el modelo.'), 'Los precios son *por docena* y varían según el modelo.');
  assert.equal(stripFillerOpening('Perfecto 🤍\n\nPara *Guayaquil* te queda en *$124.00*'), 'Para *Guayaquil* te queda en *$124.00*');
});

test('no rompe frases donde la exclamación es parte del mensaje, ni mensajes cortos', () => {
  assert.equal(stripFillerOpening('Qué lindo va a quedar 🤍'), 'Qué lindo va a quedar 🤍');
  assert.equal(stripFillerOpening('Claro 🤍'), 'Claro 🤍');
  assert.equal(stripFillerOpening('Para *Quito* el envío está incluido'), 'Para *Quito* el envío está incluido');
});

test('un emoji partido al recortar un texto se limpia y no tumba el envío a la IA', () => {
  const roto = 'a'.repeat(59) + '🤍'.slice(0, 1);
  assert.ok(/[\uD800-\uDBFF]$/.test(roto), 'el texto de prueba sí está roto');
  const limpio = withoutBrokenChars(roto);
  assert.ok(!/[\uD800-\uDBFF]/.test(limpio));
  assert.equal(limpio, 'a'.repeat(59));
});

test('los emojis completos y las tildes no se tocan', () => {
  const texto = 'Qué lindo 🤍 para tu bautizo ✨ 🕯️ ñandú';
  assert.equal(withoutBrokenChars(texto), texto);
});

test('la memoria de aperturas nunca parte un emoji, aunque el corte caiga justo en él', () => {
  const respuesta = 'x'.repeat(59) + '🤍 y sigue el mensaje';
  const texto = recentOpeningsText([respuesta]);
  assert.ok(!/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(texto));
});

test('un relleno distinto y espaciado (uno solo en los últimos 4) es natural y no se corrige', () => {
  const r = ticsIn('Perfecto 🤍 son 4 docenas', ['Qué lindo 💕 te comparto los modelos', 'Los precios son por docena.', 'El envío a Quito está incluido.']);
  assert.equal(r.violates, false);
});

test('tres rellenos en cuatro mensajes ya es demasiado', () => {
  const r = ticsIn('Listo 🤍 queda registrado', ['Qué lindo 💕 te comparto los modelos', 'Perfecto, son 4 docenas', 'El envío a Quito está incluido.']);
  assert.equal(r.violates, true);
  assert.match(r.why, /varias|anterior|hace poco/);
});
