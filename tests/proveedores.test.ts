/**
 * Catálogos de proveedores: el tamaño se deduce de la nota del PDF, el nombre entra al Catálogo sin repetirse y la
 * regla de precios se limpia.
 */
import './entorno';

import test from 'node:test';
import assert from 'node:assert/strict';
import { VELAMIA_PROFILE } from '../src/config/businessProfile';
import { sizeFromNote, catalogName, normalizeSupplierSettings, mostUsedPackaging } from '../src/social/suppliers';

test('el tamaño sale del peso en cera y, si no está, de la medida', () => {
  assert.equal(sizeFromNote('Medida de la vela : 7,8 x 5,8 cm Peso en cera: 85 g'), 'grande');
  assert.equal(sizeFromNote('Peso en cera: 40g'), 'mediana');
  assert.equal(sizeFromNote('Peso en cera: 31,5 g'), 'pequena');
  assert.equal(sizeFromNote('Medida de la vela : 7 x 4,5 cm'), 'pequena');
  assert.equal(sizeFromNote('Medida: 6,5 x 5,5 cm'), 'mediana');
  assert.equal(sizeFromNote(''), null, 'sin nota no se inventa el tamaño');
});

test('el nombre entra en mayúsculas, con la palabra de la empresa y sin repetir', () => {
  const taken = new Set<string>(['vela ghostface']);
  assert.equal(catalogName('Calabaza 1', 'VELA', taken), 'VELA CALABAZA 1');
  assert.equal(catalogName('Ghostface', 'VELA', taken), 'VELA GHOSTFACE 2', 'ya existía: se numera');
  assert.equal(catalogName('Ghostface', 'VELA', taken), 'VELA GHOSTFACE 3');
  assert.equal(catalogName('Vela Monja', 'VELA', taken), 'VELA MONJA', 'no repite la palabra si ya la trae');
  assert.equal(catalogName('Búho', '', taken), 'BÚHO');
});

test('la regla de precios se limpia y por defecto agrega al Catálogo', () => {
  const s = normalizeSupplierSettings({ sizePrices: { pequena: '30', mediana: 35, grande: -4 }, defaultSize: 'enorme', namePrefix: '  vela ' });
  assert.deepEqual(s.sizePrices, { pequena: 30, mediana: 35, grande: 0 });
  assert.equal(s.defaultSize, 'mediana');
  assert.equal(s.namePrefix, 'VELA');
  assert.equal(s.autoAddToCatalog, true);
});

test('sin empaque en la regla, los modelos entran con el empaque más usado del Catálogo', () => {
  const catalogo = [{ description: 'Tul' }, { description: 'tul' }, { description: 'Acetato' }, { description: '' }, { description: null }, { description: 'Algo raro' }];
  assert.equal(mostUsedPackaging(catalogo, VELAMIA_PROFILE), 'Tul');
  assert.equal(mostUsedPackaging([{ description: '' }], VELAMIA_PROFILE), '', 'si nadie tiene empaque no se inventa uno');
});
