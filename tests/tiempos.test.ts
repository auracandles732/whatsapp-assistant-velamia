/**
 * Una respuesta inmediata delata al bot: para todos los negocios (regla general, no por empresa,
 * pedida explícitamente por Aura) se espera un tiempo humano de 30 s a 1 min, contado desde el
 * primer mensaje de la clienta, antes de escribirle. Si armar la respuesta ya tardó, se descuenta.
 */
import './entorno';

import test from 'node:test';
import assert from 'node:assert/strict';

import { MIN_HUMAN_REPLY_MS, MAX_HUMAN_REPLY_MS, waitHumanDelay } from '../src/controllers/messageController';

test('la ventana de espera humana es de 30 segundos a 1 minuto', () => {
  assert.equal(MIN_HUMAN_REPLY_MS, 30_000);
  assert.equal(MAX_HUMAN_REPLY_MS, 60_000);
});

test('si armar la respuesta ya tardó más del máximo, no espera nada extra', async (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'] });
  const firstAt = Date.now() - (MAX_HUMAN_REPLY_MS + 5000);
  let resolved = false;
  waitHumanDelay(firstAt).then(() => { resolved = true; });
  await Promise.resolve();
  assert.equal(resolved, true, 'no debía quedar esperando: ya pasó de sobra el tiempo humano');
});

test('si la respuesta está lista al instante, espera entre 30 y 60 segundos desde el primer mensaje', async (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'] });
  const firstAt = Date.now();
  let resolved = false;
  waitHumanDelay(firstAt).then(() => { resolved = true; });

  await t.mock.timers.tick(MIN_HUMAN_REPLY_MS - 1000);
  await Promise.resolve(); await Promise.resolve();
  assert.equal(resolved, false, 'no debía responder antes de los 30 segundos');

  await t.mock.timers.tick(MAX_HUMAN_REPLY_MS);
  await Promise.resolve(); await Promise.resolve();
  assert.equal(resolved, true, 'debía haber respondido para cuando pasó 1 minuto');
});

test('si ya pasaron 20 segundos armando la respuesta, solo espera lo que falte', async (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'] });
  const firstAt = Date.now() - 20_000;
  let resolved = false;
  waitHumanDelay(firstAt).then(() => { resolved = true; });

  // Nunca debería esperar más de MAX - 20s, ni menos de MIN - 20s.
  await t.mock.timers.tick(MIN_HUMAN_REPLY_MS - 20_000 - 500);
  await Promise.resolve(); await Promise.resolve();
  assert.equal(resolved, false);
  await t.mock.timers.tick(MAX_HUMAN_REPLY_MS - 20_000);
  await Promise.resolve(); await Promise.resolve();
  assert.equal(resolved, true);
});
