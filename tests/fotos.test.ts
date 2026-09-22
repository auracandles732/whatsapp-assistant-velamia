/**
 * Si el asistente escribe un modelo con su precio en vez de mandar la foto, el sistema la manda igual.
 */
import './entorno';

import test from 'node:test';
import assert from 'node:assert/strict';
import { productsNamedWithPrice, withOppositeGender, isGenericFirstContact, introSelection, afterPhotosQuestion } from '../src/services/photoBackup';

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

test('reconoce el primer mensaje genérico del anuncio o un saludo, pero no una consulta concreta', () => {
  assert.equal(isGenericFirstContact('¡Hola! Quiero más información'), true);
  assert.equal(isGenericFirstContact('¡Hola! Me gustaría conseguir más información sobre esto.'), true);
  assert.equal(isGenericFirstContact('Hola'), true);
  assert.equal(isGenericFirstContact('Buenas tardes'), true);
  assert.equal(isGenericFirstContact('¡Hola! Quiero más información\nHola de dónde son'), false);
  assert.equal(isGenericFirstContact('Buenas noches tiene rosarios para bautizos para niña'), false);
  assert.equal(isGenericFirstContact('Precio'), false);
});

test('presentación: un modelo por categoría, las más grandes primero y los neutros antes', () => {
  const cat = [
    { name: 'Boda 1', category: 'BODA', gender: null, image_url: 'u' },
    { name: 'Baby niña', category: 'BABY', gender: 'niña', image_url: 'u' },
    { name: 'Baby neutro', category: 'BABY', gender: null, image_url: 'u' },
    { name: 'Baby niño', category: 'BABY', gender: 'niño', image_url: 'u' },
    { name: 'Boda 2', category: 'BODA', gender: null, image_url: 'u' },
    { name: 'Quince', category: 'QUINCE', gender: null, image_url: 'u' },
    { name: 'Sin foto', category: 'OTRA', gender: null, image_url: '' }
  ];
  assert.deepEqual(introSelection(cat, 4), ['Baby neutro', 'Boda 1', 'Quince', 'Baby niña']);
});

test('después de las fotos pregunta la ocasión, la cantidad o cuál le gustó según lo que falte', () => {
  assert.equal(afterPhotosQuestion({ intro: true, quantityKnown: false, photos: 4 }), 'event');
  assert.equal(afterPhotosQuestion({ intro: false, quantityKnown: false, photos: 4 }), 'quantity');
  assert.equal(afterPhotosQuestion({ intro: false, quantityKnown: true, photos: 4 }), 'liked');
  assert.equal(afterPhotosQuestion({ intro: false, quantityKnown: false, photos: 1 }), 'liked');
});
