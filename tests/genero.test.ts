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
import { customerSex, mentionedGenderedCategory, categoryPhotos, neutralFirstMixed } from '../src/services/photoBackup';

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

test('con productos marcados, las fotos no esperan a saber el sexo y el género no restringe', () => {
  const prompt = buildSystemPrompt(catalogoBaby, undefined, conGenero);
  assert.ok(/NO se lo preguntes antes de mostrar ni condiciones las fotos/.test(prompt));
  assert.ok(!/PREGÚNTASELO PRIMERO/.test(prompt));
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
  assert.ok(!/NO se lo preguntes antes de mostrar/.test(prompt));
});

test('un negocio sin el ajuste no recibe la regla de género aunque el dato viniera en el producto', () => {
  const prompt = buildSystemPrompt(catalogoBaby, undefined, sinGenero);
  assert.ok(!/NO se lo preguntes antes de mostrar/.test(prompt));
  assert.ok(!prompt.includes('· niño'));
});

test('sabe si la clienta ya dijo el sexo; "aún no sabemos" o "niño o niña" no cuentan', () => {
  assert.equal(customerSex('Es para niña'), 'niña');
  assert.equal(customerSex('para mi varoncito'), 'niño');
  assert.equal(customerSex('Para baby shower\nAún no sabemos pero queremos ver opciones'), '');
  assert.equal(customerSex('no sé si niño o niña'), '');
});

const catalogoReal = [
  { name: 'OSITO EN NUBE CON CORAZON', category: 'BABY SHOWER', gender: 'niño', image_url: 'x' },
  { name: 'VELA DE JIRAFA', category: 'BABY SHOWER', gender: 'niña', image_url: 'x' },
  { name: 'VELA DE POLLITO', category: 'BABY SHOWER', gender: null, image_url: 'x' },
  { name: 'VELA DE LEONCITO', category: 'BABY SHOWER', gender: 'niño', image_url: 'x' },
  { name: 'OSITO GRANDE CORAZON', category: 'BABY SHOWER', gender: 'niña', image_url: 'x' },
  { name: 'VELA OSITO TARRO DE MIEL', category: 'BABY SHOWER', gender: null, image_url: 'x' },
  { name: 'CRUZ CON FLORES DE BAUTIZO', category: 'BAUTIZO', gender: null, image_url: 'x' },
  { name: 'VELA DE ANGEL EN BASE', category: 'BAUTIZO', gender: 'niño', image_url: 'x' }
];

test('caso real 23-sep: dijo "baby shower" y no sabe el sexo → se reconoce la categoría y van todas sus fotos', () => {
  const dijo = 'Hola buenas tardes\nPara baby shower\nAún no sabes pero queremos ver opciones';
  assert.equal(mentionedGenderedCategory(dijo, catalogoReal), 'BABY SHOWER');
  assert.equal(mentionedGenderedCategory('para un babyshower', catalogoReal), 'BABY SHOWER');
  assert.equal(mentionedGenderedCategory('bautizo, bueno no, mejor baby shower', catalogoReal), 'BABY SHOWER');
  assert.equal(mentionedGenderedCategory('para una boda', catalogoReal), '');
  assert.equal(categoryPhotos('BABY SHOWER', catalogoReal, ['VELA DE JIRAFA']).length, 5);
});

test('sin saber el sexo: primero los neutros y después niña y niño intercalados', () => {
  const todos = categoryPhotos('BABY SHOWER', catalogoReal, []);
  assert.deepEqual(neutralFirstMixed(todos, catalogoReal), [
    'VELA DE POLLITO', 'VELA OSITO TARRO DE MIEL',
    'VELA DE JIRAFA', 'OSITO EN NUBE CON CORAZON', 'OSITO GRANDE CORAZON', 'VELA DE LEONCITO'
  ]);
});
