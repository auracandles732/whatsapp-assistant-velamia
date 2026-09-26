/**
 * Supervisor de los chats: aprende de lo que respondió el equipo (solo con la aprobación de la dueña), le pasa al bot
 * únicamente lo que aplica a cada mensaje y arma los números del reporte diario sin IA.
 */
import './entorno';

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  relevantLessons, lessonsContext, newLessonsFrom, sameSituation, cleanLessonText, transcript, dayMetrics, plainWords, Lesson
} from '../src/services/supervisor';

const lesson = (situation: string, answer: string, extra: Partial<Lesson> = {}): Lesson => ({
  id: situation, situation, answer, always: false, status: 'approved', source: 'pausa', conversationId: null, customer: '',
  evidence: '', createdAt: '2026-09-26T12:00:00Z', decidedAt: '2026-09-26T12:00:00Z', ...extra
});

test('al bot solo le llega lo aprobado que tiene que ver con lo que escribe el cliente', () => {
  const lessons = [
    lesson('El cliente pide factura con RUC', 'Pedir razón social, RUC y correo; la factura se envía con el pedido'),
    lesson('Preguntan si hacen envíos a Galápagos', 'Decir que sí, por Servientrega, con 5 días más de entrega'),
    lesson('Quieren retirar en persona el pedido', 'Explicar que no hay local; se entrega a domicilio'),
    lesson('Piden factura electrónica', 'Pedir los datos', { status: 'pending' })
  ];
  const picked = relevantLessons(lessons, 'Hola, necesito factura con mi RUC por favor');
  assert.deepEqual(picked.map(l => l.situation), ['El cliente pide factura con RUC'], 'lo pendiente no llega al bot');
  assert.deepEqual(relevantLessons(lessons, 'Buenas tardes, cuánto cuesta la vela angelito?'), [], 'si no aplica, nada');
  assert.equal(relevantLessons(lessons, '¿Hacen envíos a Galápagos?')[0]?.situation, 'Preguntan si hacen envíos a Galápagos');
});

test('las reglas marcadas "siempre" llegan en todos los mensajes', () => {
  const lessons = [lesson('No se trabaja los domingos', 'Avisar que los domingos no hay entregas', { always: true })];
  assert.equal(relevantLessons(lessons, 'Hola').length, 1);
  const text = lessonsContext(relevantLessons(lessons, 'Hola'));
  assert.match(text, /APRENDIZAJES QUE APROBÓ LA DUEÑA/);
  assert.match(text, /- Cuando No se trabaja los domingos: Avisar que los domingos no hay entregas/);
  assert.equal(lessonsContext([]), '');
});

test('lo que propone la IA se limpia: sin datos personales, sin repetir y máximo 3', () => {
  const existing = [lesson('El cliente pide factura con RUC', 'x'.repeat(10))];
  const raw = [
    { situacion: 'Cliente pide factura con su RUC', respuesta: 'Pedir datos de facturación', evidencia: '', alcance: 'cuando_aplique' },
    { situacion: 'Preguntan por envíos a Galápagos', respuesta: 'Sí se envía; llamar al 0991234567 o escribir a ana@correo.com', evidencia: 'Cliente: envían a Galápagos?', alcance: 'cuando_aplique' },
    { situacion: 'corto', respuesta: 'muy corto', evidencia: '', alcance: 'siempre' },
    { situacion: 'No se hacen entregas los domingos', respuesta: 'Avisar que el domingo no se entrega', evidencia: '', alcance: 'siempre' },
    { situacion: 'Uno más que no entra', respuesta: 'Porque solo van tres', evidencia: '', alcance: 'siempre' }
  ];
  const out = newLessonsFrom(raw, existing, { source: 'pausa', conversationId: 'c1', customer: 'María 0998887766' });
  assert.deepEqual(out.map(l => l.situation), ['Preguntan por envíos a Galápagos', 'No se hacen entregas los domingos']);
  assert.ok(out.every(l => l.status === 'pending'), 'todo queda por aprobar');
  assert.match(out[0].answer, /\[número\]/);
  assert.match(out[0].answer, /\[correo\]/);
  assert.ok(!/0991234567|ana@correo/.test(out[0].answer));
  assert.equal(out[1].always, true);
  assert.equal(out[0].customer, 'María [número]');
});

test('frases parecidas cuentan como la misma situación', () => {
  assert.ok(sameSituation('El cliente pide factura con RUC', 'Clientes que piden facturas con RUC'));
  assert.ok(!sameSituation('El cliente pide factura con RUC', 'Preguntan por envíos a Galápagos'));
  assert.deepEqual(plainWords('¿Hacen envíos a Galápagos?'), ['hacen', 'envios', 'galapagos']);
  assert.equal(cleanLessonText('  hola\n  mundo  ', 20), 'hola mundo');
});

test('el chat se le pasa al supervisor como lo leería una persona', () => {
  const text = transcript([
    { sender: 'customer', type: 'text', content: '¿Hacen factura?' },
    { sender: 'bot', type: 'image', content: 'https://x/foto.jpg\n🕯️ *VELA RENO*' },
    { sender: 'human', type: 'text', content: 'Sí, pásame tu RUC' },
    { sender: 'customer', type: 'audio', content: 'https://x/a.ogg\nte lo mando' }
  ]);
  assert.equal(text, 'Cliente: ¿Hacen factura?\nAsistente: [foto] 🕯️ *VELA RENO*\nEquipo: Sí, pásame tu RUC\nCliente: [audio] te lo mando');
});

test('los números del día salen sin IA: chats, sin respuesta, avisos, cotizaciones y pedidos', () => {
  const start = new Date('2026-09-25T05:00:00Z');
  const end = new Date('2026-09-26T05:00:00Z');
  const now = new Date('2026-09-26T12:00:00Z');
  const m = (conversation_id: string, sender: string, timestamp: string) => ({ conversation_id, sender, type: 'text', content: 'x', timestamp });
  const metrics = dayMetrics({
    start, end, now,
    conversations: [
      { id: 'a', customer_name: 'Ana', created_at: '2026-09-25T15:00:00Z' },
      { id: 'b', customer_name: 'Bea', created_at: '2026-09-01T15:00:00Z' },
      { id: 'c', customer_name: 'Caro', created_at: '2026-09-01T15:00:00Z' }
    ],
    messages: [
      m('a', 'customer', '2026-09-25T15:00:00'), m('a', 'bot', '2026-09-25T15:01:00'),
      m('b', 'customer', '2026-09-25T20:00:00'), m('b', 'human', '2026-09-25T21:00:00'), m('b', 'customer', '2026-09-26T03:00:00'),
      m('c', 'bot', '2026-09-25T16:00:00')
    ],
    notifications: [
      { conversation_id: 'b', event_type: 'owner_question', created_at: '2026-09-25T20:01:00' },
      { conversation_id: 'b', event_type: 'owner_question', created_at: '2026-09-24T20:01:00' }
    ],
    orders: [{ created_at: '2026-09-25T18:00:00' }, { created_at: '2026-09-20T18:00:00' }],
    quotations: [{ created_at: '2026-09-25T17:00:00' }]
  });
  assert.equal(metrics.chats, 2, 'solo cuentan los chats donde escribió un cliente');
  assert.equal(metrics.newChats, 1);
  assert.equal(metrics.customerMessages, 3);
  assert.equal(metrics.teamChats, 1);
  assert.deepEqual(metrics.unanswered.map(u => u.customer), ['Bea'], 'Bea escribió de último y nadie le respondió');
  assert.deepEqual(metrics.handoffs, { owner_question: 1 });
  assert.equal(metrics.orders, 1);
  assert.equal(metrics.quotations, 1);
});
