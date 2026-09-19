/**
 * Una respuesta inmediata delata al bot: para todos los negocios (regla general, no por empresa,
 * pedida explícitamente por Aura) se espera un tiempo humano de 30 s a 1 min, contado desde el
 * primer mensaje de la clienta, antes de escribirle. Si armar la respuesta ya tardó, se descuenta.
 */
import './entorno';

import test from 'node:test';
import assert from 'node:assert/strict';

import { MIN_HUMAN_REPLY_MS, MAX_HUMAN_REPLY_MS, TYPING_LEAD_MS, RESPONSE_DELAY_MS, humanReadyAt, replyDelayMs, typingDelayMs } from '../src/controllers/messageController';

test('la ventana de espera humana es de 30 segundos a 1 minuto', () => {
  assert.equal(MIN_HUMAN_REPLY_MS, 30_000);
  assert.equal(MAX_HUMAN_REPLY_MS, 60_000);
});

test('la hora de contestar cae siempre dentro de la ventana de 30 s a 1 min', () => {
  for (let i = 0; i < 200; i++) {
    const espera = humanReadyAt(1_000_000) - 1_000_000;
    assert.ok(espera >= MIN_HUMAN_REPLY_MS && espera <= MAX_HUMAN_REPLY_MS, `espera fuera de rango: ${espera}`);
  }
});

test('mientras no toque contestar, se sigue esperando; el cliente puede escribir más', () => {
  const firstAt = 1_000_000;
  const batch = { firstAt, readyAt: firstAt + 40_000 };
  assert.equal(replyDelayMs(batch, firstAt), 40_000);
  assert.equal(replyDelayMs(batch, firstAt + 30_000), 10_000);
});

test('llegada la hora, contesta aunque el cliente siga escribiendo', () => {
  const firstAt = 1_000_000;
  const batch = { firstAt, readyAt: firstAt + 40_000 };
  assert.equal(replyDelayMs(batch, firstAt + 40_000), 0);
  assert.equal(replyDelayMs(batch, firstAt + 50_000), 0);
});

test('si el cliente escribe justo antes de la hora, se le da un momento para terminar', () => {
  const firstAt = 1_000_000;
  // Una tanda cuya espera humana ya pasó: manda el silencio de 5 s, sin pasar del tope de 20 s.
  const batch = { firstAt, readyAt: firstAt - 1 };
  assert.equal(replyDelayMs(batch, firstAt + 1_000), RESPONSE_DELAY_MS);
  assert.equal(replyDelayMs(batch, firstAt + 18_000), 2_000);
  assert.equal(replyDelayMs(batch, firstAt + 25_000), 0);
});

test('"escribiendo…" se programa 15 segundos antes de contestar', () => {
  const batch = { readyAt: 1_040_000 };
  assert.equal(typingDelayMs(batch, 1_000_000), 40_000 - TYPING_LEAD_MS);
  // Si la respuesta ya se pasó de hora, sale negativo y no se programa.
  assert.ok(typingDelayMs(batch, 1_060_000) < 0);
});
