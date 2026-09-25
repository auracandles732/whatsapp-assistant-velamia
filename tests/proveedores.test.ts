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

test('cambiar de categoría no se come las "s" (error real: "velas personalizadas" quedaba "VELA PER ONALIZADA")', async () => {
  const { categoryName } = await import('../src/social/suppliers');
  assert.equal(categoryName('velas personalizadas'), 'VELAS PERSONALIZADAS');
  assert.equal(categoryName('  baby   shower '), 'BABY SHOWER');
});

test('una foto con el diseño hecha con datos que cambiaron mientras tanto no se guarda', async () => {
  const { posterIsStale } = await import('../src/social/posters');
  const model: any = { name: 'VELA OSITO', size: 'mediana' };
  const reglas: any = { sizePrices: { pequena: 30, mediana: 35, grande: 42 }, unitPrices: {} };
  const job = { model, price: 35, unitPrice: 0 };
  assert.equal(posterIsStale(job, { name: 'VELA OSITO', size: 'mediana' } as any, reglas), false);
  assert.equal(posterIsStale(job, { name: 'VELA OSITO', size: 'grande' } as any, reglas), true, 'cambió el tamaño (otro precio)');
  assert.equal(posterIsStale(job, { name: 'VELA OSITO LUNA', size: 'mediana' } as any, reglas), true, 'cambió el nombre');
  assert.equal(posterIsStale(job, { name: 'VELA OSITO', size: 'mediana' } as any, { ...reglas, sizePrices: { ...reglas.sizePrices, mediana: 38 } }), true, 'cambió el precio de la regla');
  assert.equal(posterIsStale(job, null, reglas), true, 'el modelo ya no existe');
});
