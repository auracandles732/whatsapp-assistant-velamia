/**
 * Supervisor comercial: etapa de cada clienta, embudo, rendimiento de seguimientos y alertas en tiempo real, todo con
 * reglas del CRM (sin IA).
 */
import './entorno';

import test from 'node:test';
import assert from 'node:assert/strict';
import { stageOf, funnelFrom, followUpStatsFrom, watchChat, importantMessage, isCourtesy, asksForPerson } from '../src/services/salesWatch';

const signals = (texts: string[], extra = {}) => ({ customerTexts: texts, botSentPhotos: false, bankDetailsSent: false, hasQuotation: false, hasOrder: false, ...extra });
const MIN = 60_000;

test('etapa de la clienta: fría, interesada, caliente o lista para pagar', () => {
  assert.equal(stageOf(signals(['Hola', 'de dónde son?'])), 'frio');
  assert.equal(stageOf(signals(['Hola, cuánto cuesta la vela de angelito?'])), 'interesado');
  assert.equal(stageOf(signals(['Hola'], { botSentPhotos: true })), 'interesado');
  assert.equal(stageOf(signals(['Necesito 3 docenas para el 20 de noviembre'])), 'caliente');
  assert.equal(stageOf(signals(['ok'], { hasQuotation: true })), 'caliente');
  assert.equal(stageOf(signals(['Dónde te pago?'])), 'listo_para_pagar');
  assert.equal(stageOf(signals(['ok'], { bankDetailsSent: true })), 'listo_para_pagar');
});

test('embudo: cada etapa incluye a las siguientes y dice dónde se pierden más', () => {
  const f = funnelFrom({
    from: 'a', to: 'b',
    chats: new Set(['1', '2', '3', '4', '5', '6', '7', '8', '9', '10']),
    interested: new Set(['1', '2', '3', '4', '5']),
    quoted: new Set(['1', '2', '3']),
    readyToPay: new Set(['1']),
    ordered: new Set(['1', '2']),
    paid: new Set(['1'])
  });
  assert.deepEqual([f.chats, f.interested, f.quotations, f.pendingPayment, f.orders, f.sales], [10, 5, 3, 2, 2, 1]);
  assert.equal(f.rates.sale, 10);
  assert.equal(f.rates.quote, 30);
  assert.equal(f.biggestDrop, 'chats → interesadas');
});

test('seguimientos: respondido, cotizado y comprado se cuentan aparte; enviar no es éxito', () => {
  const t0 = Date.parse('2026-10-01T15:00:00Z');
  const s = followUpStatsFrom({
    from: 'a', to: 'b',
    sent: [
      { conversation_id: 'a', at: t0, template: 'seg_01' },
      { conversation_id: 'b', at: t0, template: 'seg_01' },
      { conversation_id: 'c', at: t0, template: 'seg_01' },
      { conversation_id: 'd', at: t0, template: 'seg_02' }
    ],
    customerAt: new Map([['a', [t0 + 60 * MIN]], ['b', [t0 + 5 * 86_400_000]]]),
    quotesAt: new Map([['a', [t0 + 2 * 86_400_000]]]),
    ordersAt: new Map([['a', [t0 + 3 * 86_400_000]]])
  });
  assert.deepEqual(s.total, { template: 'Todos', sent: 4, responded: 1, quoted: 1, bought: 1 });
  assert.equal(s.byTemplate.find(r => r.template === 'seg_01')!.responded, 1, 'la respuesta de 5 días después ya no cuenta');
  assert.equal(s.best, 'seg_01');
});

test('alerta: lista para pagar esperando 15 minutos o más; un "gracias" no cuenta', () => {
  const now = Date.parse('2026-10-06T15:00:00Z');
  const msg = (sender: string, content: string, minsAgo: number) => ({ sender, type: 'text', content, at: now - minsAgo * MIN });
  const base = { conversationId: 'x', quotationAt: null, hasOrder: false, followUpAfterQuote: false, now };
  assert.equal(watchChat({ ...base, messages: [msg('bot', 'Total $111', 30), msg('customer', '¿Dónde te pago?', 20)] })[0].event, 'ready_to_pay_waiting');
  assert.deepEqual(watchChat({ ...base, messages: [msg('customer', '¿Dónde te pago?', 5)] }), [], 'todavía no pasan 15 minutos');
  assert.deepEqual(watchChat({ ...base, messages: [msg('bot', 'Listo', 40), msg('customer', 'gracias', 30)] }), []);
  assert.equal(watchChat({ ...base, messages: [msg('customer', 'Necesito 4 docenas para el 15 de noviembre', 25)] })[0].event, 'hot_waiting');
  assert.deepEqual(watchChat({ ...base, messages: [msg('customer', 'hola, de dónde son?', 60)] }), [], 'una clienta fría esperando no es urgente');
});

test('alerta: pide una persona (si nadie del equipo respondió) y cotización sin avance ni seguimiento', () => {
  const now = Date.parse('2026-10-06T15:00:00Z');
  const msg = (sender: string, content: string, minsAgo: number) => ({ sender, type: 'text', content, at: now - minsAgo * MIN });
  const base = { conversationId: 'x', quotationAt: null, hasOrder: false, followUpAfterQuote: false, now };
  assert.ok(watchChat({ ...base, messages: [msg('customer', 'quiero hablar con una persona', 3), msg('bot', 'Claro', 2)] }).some(f => f.event === 'asks_person'));
  assert.ok(!watchChat({ ...base, messages: [msg('customer', 'quiero hablar con una persona', 30), msg('human', 'Hola, soy Aura', 20)] }).some(f => f.event === 'asks_person'));
  const quoteAt = now - 30 * 60 * MIN;
  assert.ok(watchChat({ ...base, quotationAt: quoteAt, messages: [msg('bot', 'Velas: $70', 30 * 60)] }).some(f => f.event === 'quote_stalled'));
  assert.ok(!watchChat({ ...base, quotationAt: quoteAt, followUpAfterQuote: true, messages: [] }).some(f => f.event === 'quote_stalled'), 'ya le salió un seguimiento');
  assert.ok(asksForPerson('¿eres un bot?'));
  assert.ok(isCourtesy('Muchas gracias!!'));
});

test('mensaje importante no entregado: cotización, pago, pedido, seguimiento o respuesta del equipo', () => {
  assert.equal(importantMessage({ sender: 'bot', content: 'Total: $111.00' }), true);
  assert.equal(importantMessage({ sender: 'human', content: 'Hola' }), true);
  assert.equal(importantMessage({ sender: 'bot', content: '¿Para qué fecha sería?' }), false);
});
