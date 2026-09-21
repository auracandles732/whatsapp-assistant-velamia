/**
 * Diseños personalizados: la dueña recibe un aviso apenas se detecta la idea (sin esperar la cantidad)
 * y otro cuando ya se puede cotizar. Ninguno pausa al asistente: sigue atendiendo.
 */
import './entorno';

import test from 'node:test';
import assert from 'node:assert/strict';

import { customDesignAlerts } from '../src/services/customDesign';
import { buildSystemPrompt } from '../src/services/openai';
import { normalizeProfile, PROFILE_PRESETS } from '../src/config/businessProfile';

const base = { requested: false, summary: '', hasQuantity: false, earlyRecentlySent: false, finalAlreadySent: false };

test('caso Jessica: pidió una conejita y aún no hay cantidad → aviso temprano, no el final', () => {
  const r = customDesignAlerts({ ...base, requested: true, summary: 'Conejita para baby shower · con foto de referencia' });
  assert.deepEqual(r, { early: true, final: false });
});

test('caso velas navideñas: la idea sin resumen todavía ya avisa', () => {
  assert.deepEqual(customDesignAlerts({ ...base, requested: true }), { early: true, final: false });
});

test('sin diseño personalizado no se avisa nada', () => {
  assert.deepEqual(customDesignAlerts(base), { early: false, final: false });
});

test('el aviso temprano no se repite en los mensajes siguientes', () => {
  const r = customDesignAlerts({ ...base, requested: true, summary: 'Conejita rosada', earlyRecentlySent: true });
  assert.deepEqual(r, { early: false, final: false });
});

test('caso Elena: con la cantidad en el resumen llega el aviso "listo para cotizar"', () => {
  const r = customDesignAlerts({ ...base, requested: true, summary: 'Flor pequeña · rojo, violeta y rosado · 2 docenas', hasQuantity: true });
  assert.equal(r.final, true);
});

test('el aviso final no se repite para el mismo diseño', () => {
  const r = customDesignAlerts({ ...base, requested: true, summary: 'Flor · 2 docenas', hasQuantity: true, earlyRecentlySent: true, finalAlreadySent: true });
  assert.deepEqual(r, { early: false, final: false });
});

test('un resumen que aún no dice la cantidad no dispara el aviso final', () => {
  const r = customDesignAlerts({ ...base, requested: true, summary: 'Conejita rosada con nombre', hasQuantity: false, earlyRecentlySent: true });
  assert.equal(r.final, false);
});

test('las instrucciones piden llenar el resumen desde el principio y que el asistente siga atendiendo', () => {
  const p = normalizeProfile(PROFILE_PRESETS.eventos.profile);
  const prompt = buildSystemPrompt([{ name: 'Vela', price: 30, category: 'EVENTOS' }], undefined, p);
  assert.ok(/Llena custom_design_summary desde el primer momento/.test(prompt));
  assert.ok(/Solo pon la cantidad cuando el cliente la haya dicho/.test(prompt));
  assert.ok(/El asistente sigue atendiendo con normalidad/.test(prompt));
  assert.ok(!/Antes de tener esos datos, custom_design_summary va vacío/.test(prompt));
});
