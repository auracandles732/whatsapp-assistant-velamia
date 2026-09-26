/**
 * Aprobaciones por WhatsApp: marketing elige planificar por día o por semana y aprueba o rechaza con botones (o
 * escribiendo); la dueña recibe los aprendizajes del supervisor y el reporte del día.
 */
import './entorno';

import test from 'node:test';
import assert from 'node:assert/strict';
import { readMarketingReply, planMessageText, dayName } from '../src/social/marketingChat';
import { lessonMessage, reportText, Lesson, DayReport } from '../src/services/supervisor';

const TZ = 'America/Guayaquil';

test('marketing responde con botones o escribiendo: 1 = por día, 2 = semanal, aprobar, rechazar u "hoy no"', () => {
  assert.equal(readMarketingReply('mk:dia', '1. Por día', false), 'dia');
  assert.equal(readMarketingReply('mk:semana', '2. Semanal', false), 'semana');
  assert.equal(readMarketingReply('', '1', false), 'dia');
  assert.equal(readMarketingReply('', '2', false), 'semana');
  assert.equal(readMarketingReply('', 'Por día porfa', false), 'dia');
  assert.equal(readMarketingReply('', 'la semanal', false), 'semana');
  assert.equal(readMarketingReply('mk:ok', '✅ Aprobar', true), 'ok');
  assert.equal(readMarketingReply('', 'Sí, apruebo', true), 'ok');
  assert.equal(readMarketingReply('', 'Aprobado', true), 'ok');
  assert.equal(readMarketingReply('mk:no', '❌ Rechazar', true), 'no');
  assert.equal(readMarketingReply('', 'No', true), 'no', 'con una planificación esperando, "no" la rechaza');
  assert.equal(readMarketingReply('', 'No', false), 'skip', 'sin nada esperando, "no" es "hoy no"');
  assert.equal(readMarketingReply('mk:hoyno', 'Hoy no', false), 'skip');
  assert.equal(readMarketingReply('', 'mejor mañana', false), 'skip');
  assert.equal(readMarketingReply('', 'sí', false), null, 'un "sí" sin nada que aprobar no se adivina');
  assert.equal(readMarketingReply('', 'hola', false), null);
});

test('el resumen de la planificación para WhatsApp va día por día con hora, formato y porqué', () => {
  const posts = [
    { id: 'b', scheduled_at: '2026-09-29T20:00:00Z', theme: 'Bautizo', products: [1, 2, 3].map(i => ({ name: `B${i}`, image_url: 'x', price: 35 })), media: [], channels: ['instagram_story', 'facebook_story'] as any },
    { id: 'a', scheduled_at: '2026-09-29T17:00:00Z', theme: 'Halloween', products: [1, 2, 3, 4, 5].map(i => ({ name: `H${i}`, image_url: 'x', price: 35 })), media: [], channels: ['instagram_story'] as any }
  ];
  const text = planMessageText(posts, 'Halloween es la temporada.', { a: 'Halloween es la temporada: sale todos los días', b: 'Bautizo no se publica desde hace 6 días' }, TZ);
  assert.match(text, /\*Planificación de contenido para aprobar\*/);
  assert.match(text, /2 tandas · 8 fotos/);
  assert.match(text, /\*mar 29 sep\*\n• 12:00 Halloween · 5 fotos en historias — Halloween es la temporada/, 'en orden de hora');
  assert.match(text, /• 15:00 Bautizo · 3 fotos en historias — Bautizo no se publica desde hace 6 días/);
  assert.match(text, /PDF/);
  assert.equal(dayName('2026-10-03'), 'sábado 3 oct');
});

test('cada aprendizaje llega con sus botones para aprobar o descartar', () => {
  const lesson: Lesson = {
    id: '11111111-1111-4111-8111-111111111111', situation: 'El cliente pide factura con RUC', answer: 'Pedir razón social, RUC y correo',
    always: false, status: 'pending', source: 'pausa', conversationId: 'c', customer: 'María', evidence: 'Cliente: ¿dan factura?',
    createdAt: '2026-09-26T12:00:00Z', decidedAt: null
  };
  const m = lessonMessage(lesson);
  assert.equal(m.kind, 'buttons');
  if (m.kind !== 'buttons') return;
  assert.match(m.text, /\*Cuando:\* El cliente pide factura con RUC/);
  assert.match(m.text, /\*El asistente debe:\* Pedir razón social, RUC y correo/);
  assert.match(m.text, /de un chat que atendiste tú · María/);
  assert.deepEqual(m.buttons.map(b => b.id), [`sv:ok:${lesson.id}`, `sv:no:${lesson.id}`]);
  assert.ok(m.buttons.every(b => [...b.title].length <= 20), 'WhatsApp acepta títulos de hasta 20 letras');
});

test('el reporte del día cabe en un mensaje y dice lo importante', () => {
  const report: DayReport = {
    day: '2026-09-25', createdAt: '2026-09-26T11:00:00Z',
    metrics: { chats: 12, newChats: 4, customerMessages: 80, teamChats: 2, unanswered: [{ conversationId: 'x', customer: 'Bea', since: '2026-09-25T22:00:00Z' }], handoffs: { owner_question: 2, card_payment: 1 }, orders: 1, quotations: 3 },
    summary: 'Buen día: 3 cotizaciones y un pedido.', recommendations: ['Responder más rápido en la noche'],
    problems: [{ conversationId: 'y', customer: 'Carla', type: 'venta_perdida', detail: 'Se fue por el precio del envío', suggestion: 'Ofrecer retiro' }],
    lessonsCreated: 1, reviewedChats: 12, aiError: null, attempts: 1
  };
  const text = reportText(report, 2);
  assert.match(text, /Reporte del supervisor · viernes 25 de septiembre/);
  assert.match(text, /12 chats · 1 sin respuesta · 3 avisos para ti · 3 cotizaciones · 1 pedidos/);
  assert.match(text, /Buen día/);
  assert.match(text, /• Responder más rápido en la noche/);
  assert.match(text, /Quedaron sin respuesta:\* Bea/);
  assert.match(text, /• Carla: Se fue por el precio del envío/);
  assert.match(text, /Tienes 2 aprendizajes por aprobar/);
  assert.ok(!/\n\n\n/.test(text), 'sin renglones vacíos de más');
  assert.ok(text.length < 4000);
});
