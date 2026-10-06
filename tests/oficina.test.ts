/**
 * Oficina: a cada agente se le habla y, si propone un cambio, solo se aplica lo que ese agente puede hacer y con datos
 * completos (lo que llega del navegador se vuelve a revisar).
 */
import './entorno';

import test from 'node:test';
import assert from 'node:assert/strict';
import { cleanAction, describeAction, fallbackReply, stateText, OfficeState } from '../src/services/office';

const estado: OfficeState = {
  now: '2026-10-06T15:00:00Z', business: 'VELAMIA',
  seller: { botOn: true, mode: 'idle', channel: 'whatsapp', customer: 'María', lastAt: null, chatsToday: 7, withTeam: 1, waiting: 2 },
  social: { available: true, mode: 'planned', publishingNow: '', next: { at: '2026-10-06T20:00:00Z', theme: 'Bautizo', channels: ['instagram_story'] }, drafts: 0, publishedToday: 2, upcoming: 5 },
  supervisor: { mode: 'idle', pendingLessons: 0, lastReport: null }
};

test('cada agente solo propone lo suyo: la vendedora aprende, el de redes planifica, el supervisor no cambia nada', () => {
  const teach = { tipo: 'teach', situation: 'Preguntan por envíos a Quito', answer: 'Decir que llegan en 1 a 3 días', always: false };
  const plan = { tipo: 'plan', request: 'más bautizos', days: 8 };
  assert.deepEqual(cleanAction('seller', teach), { type: 'teach', situation: 'Preguntan por envíos a Quito', answer: 'Decir que llegan en 1 a 3 días', always: false });
  assert.equal(cleanAction('seller', plan), null);
  assert.deepEqual(cleanAction('social', plan), { type: 'plan', request: 'más bautizos', days: 8 });
  assert.equal(cleanAction('social', teach), null);
  assert.equal(cleanAction('supervisor', teach), null);
});

test('una propuesta incompleta o con días raros no se aplica tal cual', () => {
  assert.equal(cleanAction('seller', { tipo: 'teach', situation: 'x', answer: 'algo largo', always: false }), null);
  assert.equal(cleanAction('social', { tipo: 'plan', request: 'más bautizos', days: 99 })!.type, 'plan');
  assert.equal((cleanAction('social', { tipo: 'plan', request: 'más bautizos', days: 99 }) as any).days, 8);
});

test('la propuesta se explica en palabras simples antes del "sí"', () => {
  assert.match(describeAction({ type: 'teach', situation: 'Cuando preguntan por envíos.', answer: 'Decir que sí', always: false }), /Cuándo: preguntan por envíos\. Qué hacer: Decir que sí$/);
  assert.match(describeAction({ type: 'plan', request: 'más bautizos', days: 2 }), /de hoy y mañana/);
});

test('sin IA, el agente igual cuenta cómo va y el de redes entiende pedidos simples', () => {
  const vendedora = fallbackReply('seller', '¿cómo vamos?', estado, 'Sin IA.');
  assert.match(vendedora.reply, /Chats con mensajes hoy: 7/);
  assert.equal(vendedora.action, null);
  const redes = fallbackReply('social', 'más bautizos', estado, 'Sin IA.');
  assert.deepEqual(redes.action, { type: 'plan', request: 'más bautizos', days: 8 });
  assert.match(stateText('social', estado), /La próxima: Bautizo/);
});
