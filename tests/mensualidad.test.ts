import test from 'node:test';
import assert from 'node:assert/strict';
import { addMonths, nextPaidUntil, paymentStatus } from '../src/services/subscription';

const d = (iso: string) => new Date(iso + 'T12:00:00Z');
const day = (x: Date) => x.toISOString().slice(0, 10);

test('un mes después de fin de mes cae en el último día del mes siguiente', () => {
  assert.equal(day(addMonths(d('2026-01-31'), 1)), '2026-02-28');
  assert.equal(day(addMonths(d('2026-03-15'), 1)), '2026-04-15');
  assert.equal(day(addMonths(d('2026-11-30'), 3)), '2027-02-28');
});
test('sin pagos anteriores, los meses cuentan desde hoy', () => {
  assert.equal(day(nextPaidUntil(null, 1, d('2026-09-21'))), '2026-10-21');
});
test('pagar antes del vencimiento suma al vencimiento y no se pierde lo ya pagado', () => {
  assert.equal(day(nextPaidUntil(d('2026-10-05'), 1, d('2026-09-21'))), '2026-11-05');
});
test('pagar con la mensualidad vencida cuenta desde hoy', () => {
  assert.equal(day(nextPaidUntil(d('2026-08-01'), 2, d('2026-09-21'))), '2026-11-21');
});
test('el estado avisa cuando vence pronto o ya venció', () => {
  const now = d('2026-09-21');
  assert.equal(paymentStatus(null, now), 'sin_pagos');
  assert.equal(paymentStatus(d('2026-10-30'), now), 'vigente');
  assert.equal(paymentStatus(d('2026-09-24'), now), 'por_vencer');
  assert.equal(paymentStatus(d('2026-09-10'), now), 'vencida');
});
