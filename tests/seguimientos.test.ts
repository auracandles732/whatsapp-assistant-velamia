/**
 * Seguimientos automáticos: solo a quien mostró interés real, con plantillas que tengan sentido para él.
 * Quien nunca recibió una cotización no debe leer "¿pudiste revisar la cotización?", y quien solo saludó no recibe nada.
 */
import './entorno';

import test from 'node:test';
import assert from 'node:assert/strict';

import { hasRealInterest, followUpStepsFor, nextFollowUp } from '../src/services/followups';
import { normalizeProfile, PROFILE_PRESETS } from '../src/config/businessProfile';

const texto = (content: string) => ({ type: 'text', content });

test('quien solo tocó el anuncio y saludó no cuenta como interesado (casos reales)', () => {
  assert.equal(hasRealInterest([texto('¡Hola! Quiero más información')]), false);
  assert.equal(hasRealInterest([texto('¡Hola! Me gustaría conseguir más información sobre esto.')]), false);
  assert.equal(hasRealInterest([texto('Hola buenas tardes')]), false);
  assert.equal(hasRealInterest([texto('Hola'), texto('Buenas noches')]), false);
  assert.equal(hasRealInterest([]), false);
});

test('quien dijo qué busca sí cuenta, aunque sea una sola palabra', () => {
  assert.equal(hasRealInterest([texto('¡Hola! Quiero más información'), texto('Bautizo')]), true);
  assert.equal(hasRealInterest([texto('Precio')]), true);
  assert.equal(hasRealInterest([texto('Hola de dónde son'), texto('Me gustaría para graduación')]), true);
  assert.equal(hasRealInterest([texto('Hola quiero velitas para baby shower')]), true);
});

test('una foto, un audio o un documento siempre cuentan como interés', () => {
  assert.equal(hasRealInterest([texto('¡Hola! Quiero más información'), { type: 'image', content: 'https://x/foto.jpg' }]), true);
  assert.equal(hasRealInterest([{ type: 'audio', content: 'https://x/a.ogg' }]), true);
});

const conLista = normalizeProfile({
  ...PROFILE_PRESETS.eventos.profile,
  followUps: {
    ...PROFILE_PRESETS.eventos.profile.followUps,
    enabled: true,
    steps: [{ template: 'seg_cotizacion', days: 1 }, { template: 'seg_pedido', days: 3 }],
    stepsNoQuote: [{ template: 'seg_neutra', days: 2 }],
    requireInterest: true
  }
});

test('con cotización se usa la lista completa; sin cotización, la neutra', () => {
  assert.deepEqual(followUpStepsFor(true, conLista).map(s => s.template), ['seg_cotizacion', 'seg_pedido']);
  assert.deepEqual(followUpStepsFor(false, conLista).map(s => s.template), ['seg_neutra']);
});

test('un negocio sin lista propia sigue usando la misma para todos', () => {
  const sinLista = normalizeProfile({ ...PROFILE_PRESETS.eventos.profile, followUps: { ...PROFILE_PRESETS.eventos.profile.followUps, stepsNoQuote: [] } });
  assert.deepEqual(followUpStepsFor(false, sinLista), sinLista.followUps.steps);
  assert.equal(sinLista.followUps.requireInterest, false);
});

test('la lista sin cotización se guarda ordenada y se descartan plantillas inválidas', () => {
  const p = normalizeProfile({
    ...PROFILE_PRESETS.eventos.profile,
    followUps: { ...PROFILE_PRESETS.eventos.profile.followUps, stepsNoQuote: [{ template: 'b', days: 5 }, { template: 'a', days: 2 }, { template: 'MAL NOMBRE', days: 1 }] }
  });
  assert.deepEqual(p.followUps.stepsNoQuote, [{ template: 'a', days: 2 }, { template: 'b', days: 5 }]);
});

test('el siguiente seguimiento respeta la lista que se le da', () => {
  const dia = 24 * 3600 * 1000;
  const ultimo = new Date('2026-09-20T12:00:00Z');
  const lista = [{ template: 'seg_neutra', days: 2 }];
  assert.equal(nextFollowUp(ultimo, [], new Date(ultimo.getTime() + 1 * dia), lista), null);
  assert.equal(nextFollowUp(ultimo, [], new Date(ultimo.getTime() + 2 * dia), lista)?.template, 'seg_neutra');
  assert.equal(nextFollowUp(ultimo, [new Date(ultimo.getTime() + 2 * dia)], new Date(ultimo.getTime() + 9 * dia), lista), null);
});
