/**
 * Cada negocio se maneja distinto: unos venden por docena (VELAMIA) y otros con unidad y medida propias
 * en cada producto (MegaMundo: cajas de 10, tubos, metros). Una configuración no puede afectar a la otra.
 */
import './entorno';

import test from 'node:test';
import assert from 'node:assert/strict';

import { buildSystemPrompt, normalizeQuantities, scopeCatalog } from '../src/services/openai';
import { normalizeProfile, PROFILE_PRESETS, usesProductUnits } from '../src/config/businessProfile';

const porDocena = normalizeProfile({ ...PROFILE_PRESETS.eventos.profile });
const conUnidadPropia = normalizeProfile({
  ...PROFILE_PRESETS.tienda.profile,
  sales: { ...PROFILE_PRESETS.tienda.profile.sales, perProductUnits: true }
});

// El mismo producto guardado con datos de unidad: solo el negocio que los usa debe hacerles caso.
const producto = { name: 'Wall Panel', price: 75, category: 'PANELES', sale_unit: 'caja de 10', measure: '2,95 m x 0,17 m', pieces_per_unit: 10 };

test('las unidades por producto vienen apagadas por defecto', () => {
  assert.equal(usesProductUnits(porDocena), false);
  assert.equal(usesProductUnits(normalizeProfile({})), false);
  assert.equal(usesProductUnits(conUnidadPropia), true);
});

test('un perfil guardado antes de este ajuste no activa las unidades por producto', () => {
  const guardadoAntes = { ...PROFILE_PRESETS.tienda.profile, sales: { ...PROFILE_PRESETS.tienda.profile.sales } };
  delete (guardadoAntes.sales as any).perProductUnits;
  assert.equal(usesProductUnits(normalizeProfile(guardadoAntes)), false);
});

test('el negocio por docena ignora la unidad y la medida de un producto', () => {
  const [visto] = scopeCatalog([producto], porDocena);
  assert.equal(visto.sale_unit, null);
  assert.equal(visto.measure, null);
  assert.equal(visto.pieces_per_unit, null);
});

test('el negocio con unidad propia conserva los datos del producto', () => {
  const [visto] = scopeCatalog([producto], conUnidadPropia);
  assert.equal(visto.sale_unit, 'caja de 10');
  assert.equal(visto.pieces_per_unit, 10);
});

test('las instrucciones del asistente solo mencionan la medida si el negocio la usa', () => {
  const sinMedida = buildSystemPrompt([producto], undefined, porDocena);
  const conMedida = buildSystemPrompt([producto], undefined, conUnidadPropia);
  assert.ok(!sinMedida.includes('2,95 m'));
  assert.ok(sinMedida.includes('Wall Panel: $75.00 por docena'));
  assert.ok(!sinMedida.includes('paneles'), 'el ejemplo de paneles es de MegaMundo y no debe aparecer en VELAMIA');
  assert.ok(conMedida.includes('paneles'));
  assert.ok(conMedida.includes('2,95 m'));
  assert.ok(conMedida.includes('Wall Panel: $75.00 por caja de 10'));
});

test('48 velas siguen siendo 4 docenas aunque un producto diga que trae 10 piezas', () => {
  const items = normalizeQuantities([{ name: 'Wall Panel', quantity: 48 }], 'quiero 48 velas', porDocena, [producto]);
  assert.equal(items[0].quantity, 4);
});

test('18 paneles son 2 cajas de 10 en el negocio que usa unidad propia', () => {
  const items = normalizeQuantities([{ name: 'Wall Panel', quantity: 18, quantity_in_pieces: true }], 'la pared mide 3 x 2', conUnidadPropia, [producto]);
  assert.equal(items[0].quantity, 2);
});
