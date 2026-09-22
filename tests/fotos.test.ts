/**
 * Si el asistente escribe un modelo con su precio en vez de mandar la foto, el sistema la manda igual.
 */
import './entorno';

import test from 'node:test';
import assert from 'node:assert/strict';
import { productsNamedWithPrice } from '../src/services/photoBackup';

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
