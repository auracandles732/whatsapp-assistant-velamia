/**
 * Reconocimiento de empaques: la IA a veces escribe el nombre con otras palabras ("bolsa de tul", "caja con lazo").
 * Debe reconocer las variantes claras y no adivinar cuando hay duda.
 */
import './entorno';

import test from 'node:test';
import assert from 'node:assert/strict';

import { findPackaging, normalizeProfile, PROFILE_PRESETS } from '../src/config/businessProfile';
import { buildSystemPrompt, computeOrderTotal } from '../src/services/openai';

const conEmpaques = normalizeProfile({
  ...PROFILE_PRESETS.eventos.profile,
  packaging: {
    enabled: true,
    types: [
      { name: 'Acetato', description: 'transparente', changeCost: null },
      { name: 'Tul', description: 'delicado, con lazo', changeCost: 2 },
      { name: 'Kraft', description: 'natural', changeCost: 0 },
      { name: 'Caja lazo personalizable', description: 'caja con lazo', changeCost: null }
    ]
  }
});

const sinEmpaques = normalizeProfile({ ...PROFILE_PRESETS.tienda.profile, packaging: { enabled: false, types: [] } });

test('reconoce el nombre exacto sin importar mayúsculas, tildes ni espacios', () => {
  assert.equal(findPackaging('Tul', conEmpaques)?.name, 'Tul');
  assert.equal(findPackaging('  kRaFt ', conEmpaques)?.name, 'Kraft');
  assert.equal(findPackaging('caja lazo personalizable', conEmpaques)?.name, 'Caja lazo personalizable');
});

test('reconoce variantes claras que contienen el nombre', () => {
  assert.equal(findPackaging('bolsa de tul', conEmpaques)?.name, 'Tul');
  assert.equal(findPackaging('caja Kraft', conEmpaques)?.name, 'Kraft');
  assert.equal(findPackaging('acetato transparente', conEmpaques)?.name, 'Acetato');
});

test('reconoce la caja aunque cambien las palabras de en medio', () => {
  assert.equal(findPackaging('Caja con lazo', conEmpaques)?.name, 'Caja lazo personalizable');
  assert.equal(findPackaging('caja personalizable con lazo', conEmpaques)?.name, 'Caja lazo personalizable');
});

test('si solo hay una opción que encaja, la reconoce aunque el cliente diga una sola palabra', () => {
  assert.equal(findPackaging('caja', conEmpaques)?.name, 'Caja lazo personalizable');
});

test('ante la duda no adivina', () => {
  assert.equal(findPackaging('tul o kraft', conEmpaques), undefined);
  assert.equal(findPackaging('bolsita', conEmpaques), undefined);
  assert.equal(findPackaging('bolsa o caja de papel', conEmpaques), undefined);
  assert.equal(findPackaging('', conEmpaques), undefined);
  assert.equal(findPackaging(null, conEmpaques), undefined);
});

test('un negocio sin empaques no recibe reglas de empaque en sus instrucciones', () => {
  const prompt = buildSystemPrompt([{ name: 'Wall Panel', price: 75, category: 'PANELES' }], undefined, sinEmpaques);
  assert.ok(!prompt.includes('EMPAQUE (campo packaging'));
  assert.ok(!/Tipos de empaque/.test(prompt));
});

test('con empaques, el asistente recibe la lista completa y qué hacer si un producto no tiene empaque', () => {
  const prompt = buildSystemPrompt([{ name: 'Vela', price: 30, category: 'EVENTOS', description: '' }], undefined, conEmpaques);
  assert.ok(prompt.includes('Tipos de empaque'));
  assert.ok(prompt.includes('Caja lazo personalizable: caja con lazo'));
  assert.ok(prompt.includes('describe TODOS los tipos'));
  assert.ok(prompt.includes('no inventes uno'));
  assert.ok(prompt.includes('Acetato, Tul, Kraft, Caja lazo personalizable'));
});

// ---------- Cómo viajan los pedidos ----------

const conNota = normalizeProfile({
  ...PROFILE_PRESETS.eventos.profile,
  shipping: { ...PROFILE_PRESETS.eventos.profile.shipping, packingNote: 'Todos los pedidos salen en una caja de cartón bien protegida.' }
});

test('la nota de embalaje solo llega a las instrucciones del negocio que la escribió', () => {
  const catalogo = [{ name: 'Vela', price: 30, category: 'EVENTOS' }];
  assert.ok(buildSystemPrompt(catalogo, undefined, conNota).includes('caja de cartón bien protegida'));
  assert.ok(!buildSystemPrompt(catalogo, undefined, conEmpaques).includes('Cómo viajan los pedidos'));
  assert.ok(!buildSystemPrompt(catalogo, undefined, sinEmpaques).includes('Cómo viajan los pedidos'));
});

test('un perfil guardado antes de esta nota queda con la nota vacía', () => {
  const antes = { ...PROFILE_PRESETS.eventos.profile, shipping: { ...PROFILE_PRESETS.eventos.profile.shipping } };
  delete (antes.shipping as any).packingNote;
  assert.equal(normalizeProfile(antes).shipping.packingNote, '');
});

// ---------- Empaques que solo vienen en ciertos modelos ----------

const conRestriccion = normalizeProfile({
  ...PROFILE_PRESETS.eventos.profile,
  shipping: { ...PROFILE_PRESETS.eventos.profile.shipping, mode: 'flat', flatRate: 10, unitsIncludedInRate: 0, extraCost: 0 },
  packaging: {
    enabled: true,
    types: [
      { name: 'Tul', description: 'delicado, con lazo', changeCost: 0 },
      { name: 'Kraft', description: 'natural', changeCost: null },
      { name: 'Caja lazo personalizable', description: 'caja con lazo', changeCost: 0, onlyIncluded: true }
    ]
  }
});

const catalogoEmpaques = [
  { name: 'Vela con tul', price: 30, category: 'EVENTOS', description: 'Tul' },
  { name: 'Vela con caja', price: 30, category: 'EVENTOS', description: 'Caja lazo personalizable' }
];

test('la restricción de empaque se guarda y por defecto no existe', () => {
  const caja = conRestriccion.packaging.types.find(t => t.name === 'Caja lazo personalizable');
  const tul = conRestriccion.packaging.types.find(t => t.name === 'Tul');
  assert.equal(caja?.onlyIncluded, true);
  assert.equal(tul?.onlyIncluded, false);
  assert.equal(normalizeProfile({ packaging: { enabled: true, types: [{ name: 'X', description: 'y' }] } }).packaging.types[0].onlyIncluded, false);
});

test('de tul a caja NO se puede: se queda el tul y se avisa', () => {
  const pedido = computeOrderTotal([{ name: 'Vela con tul', quantity: 2, packaging: 'Caja lazo personalizable' }], 'Quito', catalogoEmpaques, conRestriccion);
  assert.equal(pedido.items[0].packaging, 'Tul');
  assert.equal(pedido.items[0].packagingChanged, false);
  assert.equal(pedido.packagingBlocked, 'Caja lazo personalizable');
  assert.equal(pedido.missing, '');
  assert.equal(pedido.total, 70);
});

test('de caja a tul sí se puede y no cuesta extra', () => {
  const pedido = computeOrderTotal([{ name: 'Vela con caja', quantity: 2, packaging: 'Tul' }], 'Quito', catalogoEmpaques, conRestriccion);
  assert.equal(pedido.items[0].packaging, 'Tul');
  assert.equal(pedido.items[0].packagingChanged, true);
  assert.equal(pedido.packagingBlocked, '');
  assert.equal(pedido.total, 70);
});

test('quedarse con la caja que ya trae no es un cambio ni se bloquea', () => {
  const pedido = computeOrderTotal([{ name: 'Vela con caja', quantity: 1, packaging: 'Caja lazo personalizable' }], 'Quito', catalogoEmpaques, conRestriccion);
  assert.equal(pedido.items[0].packagingChanged, false);
  assert.equal(pedido.packagingBlocked, '');
});

test('un empaque que sí se puede elegir sigue funcionando con su costo por confirmar', () => {
  const pedido = computeOrderTotal([{ name: 'Vela con tul', quantity: 1, packaging: 'Kraft' }], 'Quito', catalogoEmpaques, conRestriccion);
  assert.equal(pedido.packagingBlocked, '');
  assert.equal(pedido.missing, 'packaging_cost');
});

test('las instrucciones avisan qué empaques no se pueden elegir y no cobran por ellos', () => {
  const prompt = buildSystemPrompt(catalogoEmpaques, undefined, conRestriccion);
  assert.ok(prompt.includes('NO se pueden elegir como cambio: Caja lazo personalizable'));
  assert.ok(prompt.includes('Costo del cambio por docena: Tul (sin costo), Kraft (costo por confirmar).'));
  assert.ok(!buildSystemPrompt(catalogoEmpaques, undefined, conEmpaques).includes('NO se pueden elegir como cambio'));
});
