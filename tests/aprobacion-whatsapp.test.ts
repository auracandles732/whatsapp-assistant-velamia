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
  assert.equal(readMarketingReply('', 'Gracias', true), null, '"gracias" solo no aprueba nada');
  assert.equal(readMarketingReply('', 'De acuerdo', true), 'ok');
  assert.equal(readMarketingReply('', 'Sí, pero sin Halloween', true), null, 'con algo más, es un pedido de cambio');
  assert.equal(readMarketingReply('mk:cambiar', '✏️ Cambiar algo', true), 'change');
  assert.equal(readMarketingReply('', 'Cambiar', true), 'change');
  assert.equal(readMarketingReply('', 'más bautizos y sin halloween', true), null, 'un pedido: se rehace con eso');
});

test('la pregunta sale a las 22:00: en la noche se planifica desde mañana; en la mañana, desde hoy', async () => {
  const { planStart, questionText } = await import('../src/social/marketingChat');
  const { normalizeSettings } = await import('../src/social/posts');
  assert.equal(normalizeSettings({}).marketingHour, 22, 'por defecto a las 10 de la noche');
  assert.equal(normalizeSettings({ marketingHour: 7 }).marketingHour, 7);
  assert.equal(normalizeSettings({ marketingHour: 3 }).marketingHour, 22, 'fuera de rango vuelve a las 22:00');
  const noche = planStart(new Date('2026-09-27T03:05:00Z'), TZ); // sábado 26, 22:05 en Ecuador
  assert.equal(noche.tomorrow, true);
  assert.equal(noche.from.toISOString(), '2026-09-27T05:00:00.000Z', 'desde el domingo 27 a las 00:00');
  const manana = planStart(new Date('2026-09-27T13:00:00Z'), TZ); // domingo 27, 8:00
  assert.equal(manana.tomorrow, false, 'si responde en la mañana, se planifica ese mismo día');
  assert.match(questionText(true), /armo lo que sale mañana/);
  assert.match(questionText(false), /armo lo que sale hoy/);
});

test('lo que pide marketing además de elegir se usa para planificar', async () => {
  const { extraRequest } = await import('../src/social/marketingChat');
  assert.equal(extraRequest('2, más bautizos y sin Halloween'), 'más bautizos y sin Halloween');
  assert.equal(extraRequest('1'), '');
  assert.equal(extraRequest('Semanal'), '');
  assert.equal(extraRequest('por día: el sábado baby shower'), 'el sábado baby shower');
});

test('sin la IA, el pedido escrito también se cumple: más de lo pedido y nada de lo que no', async () => {
  const { readRequest, pickProducts } = await import('../src/social/posts');
  const cats = ['BAUTIZO', 'HALLOWEEN', 'NAVIDAD', 'ANIMALES', 'PERSONAJES ANIMADOS', 'BABY SHOWER', 'MISA'];
  assert.deepEqual(readRequest('más bautizos y sin Halloween', cats), { prefer: ['BAUTIZO'], exclude: ['HALLOWEEN'] });
  assert.deepEqual(readRequest('menos navidad, más animales', cats), { prefer: ['ANIMALES'], exclude: ['NAVIDAD'] }, '"animales" no es "personajes animados"');
  assert.deepEqual(readRequest('el sábado baby shower y misas', cats), { prefer: ['BABY SHOWER', 'MISA'], exclude: [] });
  assert.deepEqual(readRequest('navideñas no', cats).prefer, ['NAVIDAD']);
  assert.deepEqual(readRequest('hola', cats), { prefer: [], exclude: [] });

  const catalog = cats.flatMap(cat => Array.from({ length: 6 }, (_, i) => ({ name: `${cat} ${i}`, category: cat, price: 35, image_url: `https://x/${cat}${i}.png` })));
  const picks = pickProducts(catalog, [], 4, [3, 3, 3, 3], 10, { slotDays: ['d1', 'd1', 'd2', 'd2'], prefer: ['BAUTIZO'], exclude: ['HALLOWEEN'] });
  assert.ok(!picks.some(p => p.theme === 'Halloween'), 'sin Halloween aunque sea temporada');
  assert.equal(picks.filter(p => p.theme === 'Bautizo').length, 2, 'Bautizo cada día, sin repetirse el mismo día');
  assert.equal(picks[0].theme, 'Bautizo');
});

test('el resumen dice qué se entendió del pedido (o que sin IA no se pudo)', async () => {
  const { requestNote } = await import('../src/social/brain');
  assert.equal(requestNote('más bautizos, sin halloween', { prefer: ['BAUTIZO'], exclude: ['HALLOWEEN'] }), 'Según tu pedido: más Bautizo y sin Halloween.');
  assert.match(requestNote('que se vea más elegante', { prefer: [], exclude: [] }), /No pude aplicar tu pedido/);
  assert.equal(requestNote('', { prefer: [], exclude: [] }), '');
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
