/**
 * Reconocimiento de empaques: la IA a veces escribe el nombre con otras palabras ("bolsa de tul", "caja con lazo").
 * Debe reconocer las variantes claras y no adivinar cuando hay duda.
 */
import './entorno';

import test from 'node:test';
import assert from 'node:assert/strict';

import { findPackaging, normalizeProfile, PROFILE_PRESETS } from '../src/config/businessProfile';
import { buildSystemPrompt } from '../src/services/openai';

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
