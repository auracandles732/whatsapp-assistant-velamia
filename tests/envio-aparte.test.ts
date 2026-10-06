/**
 * Con el envío aparte, la vendedora da el valor de los productos apenas sabe modelo y cantidad (sin esperar la ciudad)
 * y suma el envío cuando la sabe. Antes no daba ningún valor sin la ciudad y las clientas se iban sin cotización.
 */
import './entorno';

import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSystemPrompt } from '../src/services/openai';
import { normalizeProfile, PROFILE_PRESETS } from '../src/config/businessProfile';

const base = PROFILE_PRESETS.eventos.profile;
const catalogo = [{ name: 'VELA ANGELITO', price: 35, category: 'BAUTIZO', description: '' }] as any[];

test('envío aparte: el valor de los productos se da sin la ciudad; el total y el anticipo esperan la ciudad', () => {
  const p = normalizeProfile({ ...base, shipping: { ...base.shipping, mode: 'ecuador_table', showSeparately: true } });
  const prompt = buildSystemPrompt(catalogo, '', p);
  assert.match(prompt, /basta con saber qué/);
  assert.match(prompt, /aunque falte la ciudad/);
  assert.doesNotMatch(prompt, /pregúntala antes de dar cualquier total/);
});

test('un solo total (como antes): sin la ciudad no se da ningún valor', () => {
  const p = normalizeProfile({ ...base, shipping: { ...base.shipping, mode: 'ecuador_table', showSeparately: false } });
  assert.match(buildSystemPrompt(catalogo, '', p), /pregúntala antes de dar cualquier total/);
});

test('fotos de una vez: 4 si la empresa no eligió, entre 1 y 10 si eligió', () => {
  assert.equal(normalizeProfile({ ...base, sales: { ...base.sales, photosPerBatch: undefined } }).sales.photosPerBatch, 4);
  assert.equal(normalizeProfile({ ...base, sales: { ...base.sales, photosPerBatch: 2 } }).sales.photosPerBatch, 2);
  assert.equal(normalizeProfile({ ...base, sales: { ...base.sales, photosPerBatch: 50 } }).sales.photosPerBatch, 10);
});
