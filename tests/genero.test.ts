/**
 * Baby shower: los productos pueden marcarse niño, niña o neutro (para ambos). Solo lo usan
 * los negocios con este ajuste activado (VELAMIA); el género es una guía de diseño, nunca una
 * restricción: el cliente puede pedir cualquier modelo para el sexo que quiera.
 */
import './entorno';

import test from 'node:test';
import assert from 'node:assert/strict';

import { normalizeProfile, PROFILE_PRESETS, usesGenderTagging } from '../src/config/businessProfile';
import { buildSystemPrompt, scopeCatalog } from '../src/services/openai';

const conGenero = normalizeProfile({
  ...PROFILE_PRESETS.eventos.profile,
  sales: { ...PROFILE_PRESETS.eventos.profile.sales, genderTagging: true }
});
const sinGenero = normalizeProfile({ ...PROFILE_PRESETS.tienda.profile });

const catalogoBaby = [
  { name: 'Osito celeste', price: 30, category: 'BABY SHOWER', gender: 'niño' },
  { name: 'Osito rosado', price: 30, category: 'BABY SHOWER', gender: 'niña' },
  { name: 'Osito neutro', price: 30, category: 'BABY SHOWER', gender: null },
  { name: 'Cruz de bautizo', price: 32, category: 'BAUTIZO', gender: null }
];

test('el ajuste viene apagado por defecto', () => {
  assert.equal(usesGenderTagging(sinGenero), false);
  assert.equal(usesGenderTagging(normalizeProfile({})), false);
  assert.equal(usesGenderTagging(conGenero), true);
});

test('un perfil guardado antes de este ajuste queda apagado', () => {
  const antes = { ...PROFILE_PRESETS.eventos.profile, sales: { ...PROFILE_PRESETS.eventos.profile.sales } };
  delete (antes.sales as any).genderTagging;
  assert.equal(usesGenderTagging(normalizeProfile(antes)), false);
});

test('el negocio sin este ajuste no ve el género de ningún producto', () => {
  const visto = scopeCatalog(catalogoBaby, sinGenero);
  assert.ok(visto.every(p => p.gender == null));
});

test('el negocio con el ajuste conserva el género de cada producto', () => {
  const visto = scopeCatalog(catalogoBaby, conGenero);
  assert.equal(visto.find(p => p.name === 'Osito celeste')?.gender, 'niño');
  assert.equal(visto.find(p => p.name === 'Osito rosado')?.gender, 'niña');
});

test('el catálogo que ve la IA incluye "niño" o "niña" en la línea del producto', () => {
  const prompt = buildSystemPrompt(catalogoBaby, undefined, conGenero);
  assert.ok(prompt.includes('Osito celeste: $30.00 por docena · niño'));
  assert.ok(prompt.includes('Osito rosado: $30.00 por docena · niña'));
  assert.ok(!prompt.includes('Osito neutro: $30.00 por docena · '));
});

test('con productos marcados, las instrucciones piden preguntar el sexo antes de mostrar fotos y no restringir', () => {
  const prompt = buildSystemPrompt(catalogoBaby, undefined, conGenero);
  assert.ok(/PREGÚNTASELO PRIMERO/.test(prompt));
  assert.ok(prompt.includes('solo una guía de diseño'));
  assert.ok(/Nunca le digas que un \S+ "no se puede" por su g[eé]nero/.test(prompt));
});

test('las instrucciones piden mencionar que hay del otro sexo y que se puede personalizar, solo la primera vez', () => {
  const prompt = buildSystemPrompt(catalogoBaby, undefined, conGenero);
  assert.ok(/también le muestras los del otro sexo porque se pueden personalizar/.test(prompt));
  assert.ok(/PRIMERO los \S+ marcados para ese sexo y los que sirven para ambos/.test(prompt));
  assert.ok(/solo la primera vez que muestras esa categoría/.test(prompt));
});

test('un negocio sin productos marcados no recibe la regla de género, aunque tenga el ajuste activado', () => {
  const catalogoSinMarcar = [{ name: 'Vela', price: 30, category: 'EVENTOS', gender: null }];
  const prompt = buildSystemPrompt(catalogoSinMarcar, undefined, conGenero);
  assert.ok(!/PREGÚNTASELO PRIMERO/.test(prompt));
});

test('un negocio sin el ajuste no recibe la regla de género aunque el dato viniera en el producto', () => {
  const prompt = buildSystemPrompt(catalogoBaby, undefined, sinGenero);
  assert.ok(!/PREGÚNTASELO PRIMERO/.test(prompt));
  assert.ok(!prompt.includes('· niño'));
});
