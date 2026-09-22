/**
 * Si el asistente escribe un modelo con su precio en vez de mandar la foto, el sistema la manda igual.
 */
import './entorno';

import test from 'node:test';
import assert from 'node:assert/strict';
import { productsNamedWithPrice, withOppositeGender, afterPhotosQuestion, needsPhotoNudge } from '../src/services/photoBackup';

const catalog = [
  { name: 'VELA DE ANGELITO REZANDO CON ROSARIO', image_url: 'https://x/a.png' },
  { name: 'VELA DE LEON EN FRASCO DE VIDRIO', image_url: 'https://x/b.png' },
  { name: 'OSITO EN NUBE CON CORAZON', image_url: 'https://x/c.png' },
  { name: 'OSITO EN NUBE CON CORAZON ALADO', image_url: 'https://x/d.png' },
  { name: 'VELA SIN FOTO', image_url: '' }
];

test('manda la foto del modelo que el asistente escribió con precio (caso real del 22-sep)', () => {
  const reply = 'Sí, tenemos la *VELA DE ANGELITO REZANDO CON ROSARIO* para bautizo 🤍\n\n🕯️ *Modelo:* VELA DE ANGELITO REZANDO CON ROSARIO\n💰 *Precio:* $32.00 por docena\n\n¿Para cuántas docenas la necesitas?';
  assert.deepEqual(productsNamedWithPrice(reply, catalog, []), ['VELA DE ANGELITO REZANDO CON ROSARIO']);
});

test('no repite una foto que la clienta ya vio', () => {
  const reply = 'Claro, la *VELA DE LEON EN FRASCO DE VIDRIO* tiene un valor de *$45.00 por docena* 🦁';
  assert.deepEqual(productsNamedWithPrice(reply, catalog, ['VELA DE LEON EN FRASCO DE VIDRIO']), []);
});

test('no manda fotos en resúmenes con total ni cuando no hay precio', () => {
  assert.deepEqual(productsNamedWithPrice('🕯️ *Modelo:* VELA DE LEON EN FRASCO DE VIDRIO\n💰 *Total:* $90.00', catalog, []), []);
  assert.deepEqual(productsNamedWithPrice('La VELA DE LEON EN FRASCO DE VIDRIO es muy linda', catalog, []), []);
});

test('con nombres parecidos se queda con el modelo exacto', () => {
  assert.deepEqual(productsNamedWithPrice('El *OSITO EN NUBE CON CORAZON ALADO* cuesta $30.00 la docena', catalog, []), ['OSITO EN NUBE CON CORAZON ALADO']);
});

const baby = [
  { name: 'Osito rosado', category: 'BABY SHOWER', gender: 'niña', image_url: 'u' },
  { name: 'Conejita rosa', category: 'BABY SHOWER', gender: 'niña', image_url: 'u' },
  { name: 'Osito neutro', category: 'BABY SHOWER', gender: null, image_url: 'u' },
  { name: 'Osito celeste', category: 'BABY SHOWER', gender: 'niño', image_url: 'u' },
  { name: 'Carrito azul', category: 'BABY SHOWER', gender: 'niño', image_url: 'u' },
  { name: 'Cruz niño', category: 'BAUTIZO', gender: 'niño', image_url: 'u' }
];

test('niña: primero los de niña y neutros, después los de niño de la misma categoría', () => {
  assert.deepEqual(withOppositeGender(['Osito neutro', 'Osito rosado', 'Conejita rosa'], baby, []),
    ['Osito neutro', 'Osito rosado', 'Conejita rosa', 'Osito celeste', 'Carrito azul']);
});

test('niño: al revés, y sin repetir fotos ya vistas', () => {
  assert.deepEqual(withOppositeGender(['Osito celeste', 'Osito neutro'], baby, ['Conejita rosa']),
    ['Osito celeste', 'Osito neutro', 'Osito rosado']);
});

test('si la IA mezcla el orden, los neutros van antes que los del otro sexo (caso real del 22-sep)', () => {
  assert.deepEqual(withOppositeGender(['Osito rosado', 'Osito celeste', 'Osito neutro', 'Conejita rosa'], baby, []),
    ['Osito rosado', 'Osito neutro', 'Conejita rosa', 'Osito celeste', 'Carrito azul']);
});

test('no agrega nada con un solo modelo pedido o sin género marcado', () => {
  assert.deepEqual(withOppositeGender(['Osito rosado'], baby, []), ['Osito rosado']);
  assert.deepEqual(withOppositeGender(['Osito neutro', 'Cruz niño'].slice(0, 1), baby, []), ['Osito neutro']);
});

test('después de las fotos pregunta la cantidad si aún no la dio, o cuál le gustó', () => {
  assert.equal(afterPhotosQuestion({ quantityKnown: false, photos: 4 }), 'quantity');
  assert.equal(afterPhotosQuestion({ quantityKnown: true, photos: 4 }), 'liked');
  assert.equal(afterPhotosQuestion({ quantityKnown: false, photos: 1 }), 'liked');
});

const MIN = 60 * 1000;
const chat = (minutosDesdeFotos: number, extra: any[] = []) => {
  const now = 1_000_000_000_000;
  const fotos = now - minutosDesdeFotos * MIN;
  return { now, msgs: [
    { sender: 'customer', type: 'text', content: 'baby shower de niña', at: fotos - MIN },
    { sender: 'bot', type: 'text', content: 'Te muestro los modelos ✨', at: fotos - 30_000 },
    { sender: 'bot', type: 'image', content: 'u\n🕯️ *OSITO*', at: fotos - 10_000 },
    { sender: 'bot', type: 'text', content: '¿Para cuántos invitados sería?', at: fotos },
    ...extra.map(e => ({ ...e, at: fotos + e.min * MIN }))
  ] };
};
const preguntas = ['¿Para cuántos invitados sería?'];

test('seguimiento rápido: le escribe a los 40 minutos de ver fotos sin responder', () => {
  let c = chat(39); assert.equal(needsPhotoNudge(c.msgs, c.now, preguntas), false);
  c = chat(41); assert.equal(needsPhotoNudge(c.msgs, c.now, preguntas), true);
  c = chat(200); assert.equal(needsPhotoNudge(c.msgs, c.now, preguntas), false);
});

test('seguimiento rápido: no le escribe si respondió, si intervino el equipo o si ya se le escribió', () => {
  let c = chat(60, [{ sender: 'customer', type: 'text', content: 'me gusta', min: 5 }]); assert.equal(needsPhotoNudge(c.msgs, c.now, preguntas), false);
  c = chat(60, [{ sender: 'human', type: 'text', content: 'hola', min: 5 }]); assert.equal(needsPhotoNudge(c.msgs, c.now, preguntas), false);
  c = chat(60, [{ sender: 'bot', type: 'text', content: '¿Pudiste ver los modelos?', min: -15 }]);
  c.msgs[c.msgs.length - 1].at = c.now - 20 * MIN; assert.equal(needsPhotoNudge(c.msgs, c.now, preguntas), false);
});
