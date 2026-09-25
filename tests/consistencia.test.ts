/**
 * Respuestas coherentes con lo que ya pasó en el chat (casos reales del 21 al 25 de septiembre):
 * seguimientos que no aplican, modelos elegidos por la clienta sin que ella eligiera y fotos del otro sexo sin aviso.
 */
import './entorno';

import test from 'node:test';
import assert from 'node:assert/strict';

import { dueFollowUps, nextFollowUp, followUpContext, followUpFits, isNotCustomer, NOT_CUSTOMER_TAG } from '../src/services/followups';
import { modelsToAskAbout, TEAM_MARK } from '../src/services/openai';
import { customerSex, withOppositeGender, noteOppositeGender } from '../src/services/photoBackup';

// Textos reales de las plantillas de VELAMIA.
const COTIZACION = 'Hola, amiga ✨ Espero que estés muy bien. Quería saber si pudiste revisar la cotización de tus velitas 🕯️. Si tienes alguna pregunta, con gusto te ayudo 😊';
const FECHA = 'Amiga 🌸 Para ayudarte mejor, ¿ya tienes definida la fecha de tu evento? Así puedo orientarte con el tiempo ideal para preparar tus velitas 🕯️✨';
const AJUSTAR = 'Amiga 💛 Si deseas ajustar la cantidad, cambiar de modelo o revisar alguna opción, todavía puedo ayudarte a encontrar la alternativa ideal para tu evento 🕯️✨';

const cliente = (content: string, type = 'text') => ({ sender: 'customer', type, content });
const bot = (content: string, type = 'text') => ({ sender: 'bot', type, content });
const foto = (name: string) => bot(`https://x/${name}.jpg\n🕯️ *${name}*\n💰 $30.00 la docena`, 'image');

// ---------------- Seguimientos ----------------

const dia = 24 * 3600 * 1000;
const ultimo = new Date('2026-09-20T12:00:00Z');
const pasos = [
  { template: 'seg_01', days: 1 }, { template: 'seg_02', days: 2 }, { template: 'seg_03', days: 4 }, { template: 'seg_04', days: 7 }
];
const en = (dias: number) => new Date(ultimo.getTime() + dias * dia);

test('los pasos vencidos salen en orden y después del último enviado', () => {
  assert.deepEqual(dueFollowUps(ultimo, [], en(0.5), pasos), []);
  assert.deepEqual(dueFollowUps(ultimo, [], en(2), pasos).map(s => s.template), ['seg_01', 'seg_02']);
  // Se saltó el 02 (no aplicaba) y salió el 03: el 02 ya no vuelve aunque ahora aplique.
  assert.deepEqual(dueFollowUps(ultimo, [{ at: en(4), template: 'seg_03' }], en(8), pasos).map(s => s.template), ['seg_04']);
  // Nunca dos el mismo día.
  assert.deepEqual(dueFollowUps(ultimo, [{ at: en(4), template: 'seg_03' }], en(4.5), pasos), []);
});

test('los registros viejos sin nombre de plantilla cuentan por posición', () => {
  assert.equal(nextFollowUp(ultimo, [en(1)], en(3), pasos)?.template, 'seg_02');
  assert.equal(nextFollowUp(ultimo, [{ at: en(1), template: '' }], en(3), pasos)?.template, 'seg_02');
});

test('Giselle: ya dijo "9 de octubre", no se le vuelve a preguntar la fecha', () => {
  const ctx = followUpContext([
    cliente('¡Hola! Quiero más información'), cliente('Sería para el 9 de octubre'),
    bot('Perfecto, *9 de octubre* 🌺\n\n📅 *Entrega:* 06/10/2026'), cliente('Para un baby shower'), foto('OSITO GRANDE CORAZON')
  ], false);
  assert.equal(ctx.eventDateKnown, true);
  assert.equal(followUpFits(FECHA, ctx), false);
  assert.equal(followUpFits(AJUSTAR, ctx), true);
});

test('el asistente ya le dio la fecha de entrega: también cuenta como fecha conocida', () => {
  const ctx = followUpContext([cliente('para bautizo'), bot('La entrega queda para el *01/12/2026*.')], false);
  assert.equal(followUpFits(FECHA, ctx), false);
});

test('Nexsi: nunca vio modelos, no se le habla de "cambiar de modelo"', () => {
  const ctx = followUpContext([
    cliente('Hola de dónde son'), cliente('Me gustaría para graduación'),
    bot('Somos de *Guayaquil*… ¿qué diseño te gustaría para ese evento?')
  ], false);
  assert.equal(ctx.modelsShown, false);
  assert.equal(followUpFits(AJUSTAR, ctx), false);
  assert.equal(followUpFits(FECHA, ctx), true);
});

test('sin cotización no se pregunta por "la cotización"', () => {
  const ctx = followUpContext([cliente('Bautizo'), foto('VELA ANGELITO')], false);
  assert.equal(followUpFits(COTIZACION, ctx), false);
  assert.equal(followUpFits(COTIZACION, { ...ctx, hasQuotation: true }), true);
});

test('compra para su negocio: no se le pregunta la "fecha de tu evento"; las fotos del equipo cuentan', () => {
  const ctx = followUpContext([
    cliente('Hola buenos días quería más bien para negocio'), cliente('Por docena'),
    { sender: 'human', type: 'image', content: 'https://x/a.jpg\n🕯️ *DUENDE NAVIDEÑO*' }
  ], false);
  assert.equal(ctx.noEvent, true);
  assert.equal(followUpFits(FECHA, ctx), false);
  assert.equal(followUpFits(AJUSTAR, ctx), true);
});

test('un seguimiento anterior no cuenta como que el asistente dio la fecha ni mostró modelos', () => {
  const ctx = followUpContext([cliente('Bautizo'), bot('⁣⁣' + AJUSTAR)], false);
  assert.equal(ctx.modelsShown, false);
  assert.equal(ctx.eventDateKnown, false);
});

test('los chats etiquetados "No es cliente" no reciben seguimientos', () => {
  assert.equal(isNotCustomer([NOT_CUSTOMER_TAG]), true);
  assert.equal(isNotCustomer(['VIP', 'no es cliente']), true);
  assert.equal(isNotCustomer(['VIP']), false);
  assert.equal(isNotCustomer(null), false);
});

// ---------------- Cantidad sin modelo elegido ----------------

const catalogo = [
  { name: 'CRUZ CON FLORES DE BAUTIZO', category: 'BAUTIZO' },
  { name: 'VELA ANGELITO', category: 'BAUTIZO' },
  { name: 'VELA DE ANGELITO CON CORAZON EN MEDIO', category: 'BAUTIZO' },
  { name: 'VELA DE VIRGENCITA CON CORAZON', category: 'BAUTIZO' },
  { name: 'OSITO GRANDE CORAZON', category: 'BABY SHOWER' }
];
const fotoVista = (name: string) => ({ role: 'assistant', content: `[Foto enviada del producto: ${name}]` });
const qfzb = [
  { role: 'user', content: 'Buenos días' },
  { role: 'assistant', content: 'Buenos días 🤍\n\n¿Para qué evento buscas las velitas?' },
  { role: 'user', content: 'Para bautizo de niña' },
  { role: 'assistant', content: 'Te muestro los de bautizo para niña y los que sirven para ambos ✨' },
  fotoVista('CRUZ CON FLORES DE BAUTIZO'), fotoVista('VELA ANGELITO'),
  fotoVista('VELA DE ANGELITO CON CORAZON EN MEDIO'), fotoVista('VELA DE VIRGENCITA CON CORAZON'),
  { role: 'assistant', content: 'Aún tengo más modelos para mostrarte. ¿Para cuántas personas sería?' }
];
const textoCliente = (extra: string) => ['Buenos días', 'Para bautizo de niña', extra].join('\n');

test('Q.F. ZB: "Deseo 5 docenas" sin elegir modelo → se le pregunta cuál, no se toma la cruz', () => {
  const preguntar = modelsToAskAbout({
    items: [{ name: 'CRUZ CON FLORES DE BAUTIZO', quantity: 5 }],
    customerText: textoCliente('Deseo 5 docenas'), history: qfzb, catalog: catalogo
  });
  assert.deepEqual(preguntar, ['CRUZ CON FLORES DE BAUTIZO', 'VELA ANGELITO', 'VELA DE ANGELITO CON CORAZON EN MEDIO', 'VELA DE VIRGENCITA CON CORAZON']);
});

test('"me gustaría el de la virgen" sí es elegir, aunque no diga el nombre exacto', () => {
  assert.deepEqual(modelsToAskAbout({
    items: [{ name: 'VELA DE VIRGENCITA CON CORAZON', quantity: 5 }],
    customerText: textoCliente('Deseo 5 docenas\nNo, me gustaría el de la virgen'), history: qfzb, catalog: catalogo
  }), []);
});

test('responder a la foto de un modelo también es elegirlo', () => {
  assert.deepEqual(modelsToAskAbout({
    items: [{ name: 'VELA ANGELITO', quantity: 3 }],
    customerText: textoCliente('[El cliente responde a la foto: VELA ANGELITO] quiero 3 docenas'), history: qfzb, catalog: catalogo
  }), []);
});

test('decir la ocasión ("bautizo") no cuenta como elegir la cruz "de bautizo"', () => {
  assert.equal(modelsToAskAbout({
    items: [{ name: 'CRUZ CON FLORES DE BAUTIZO', quantity: 5 }],
    customerText: textoCliente('5 docenas para el bautizo'), history: qfzb, catalog: catalogo
  }).length, 4);
});

test('si vio un solo modelo, ese es el pedido', () => {
  assert.deepEqual(modelsToAskAbout({
    items: [{ name: 'VELA ANGELITO', quantity: 5 }],
    customerText: 'bautizo\n5 docenas', history: [fotoVista('VELA ANGELITO')], catalog: catalogo
  }), []);
});

test('si ya se le preguntó nombrando los modelos y no eligió, el asistente elige para no dar vueltas', () => {
  const yaPreguntado = [...qfzb, { role: 'assistant', content: 'Para las *5 docenas*, ¿cuál te gustó más?\n🕯️ *VELA ANGELITO*\n🕯️ *VELA DE VIRGENCITA CON CORAZON*' }];
  assert.deepEqual(modelsToAskAbout({
    items: [{ name: 'VELA ANGELITO', quantity: 5 }],
    customerText: textoCliente('Deseo 5 docenas\nlo que sea'), history: yaPreguntado, catalog: catalogo
  }), []);
});

test('si el asistente ya propuso ese modelo por su nombre y la clienta siguió, no se vuelve a preguntar', () => {
  const propuesto = [...qfzb, { role: 'assistant', content: 'Entonces lo llevo en *VELA ANGELITO* con colores pastel ✨' }];
  assert.deepEqual(modelsToAskAbout({
    items: [{ name: 'VELA ANGELITO', quantity: 5 }],
    customerText: textoCliente('5 docenas'), history: propuesto, catalog: catalogo
  }), []);
});

test('las fotos que envió el equipo también cuentan como vistas', () => {
  const equipo = [
    { role: 'assistant', content: `${TEAM_MARK}[Archivo] 🕯️ *VELA ANGELITO* 💰 $35.00 la docena` },
    { role: 'assistant', content: `${TEAM_MARK}[Archivo] 🕯️ *OSITO GRANDE CORAZON* 💰 $35.00 la docena` }
  ];
  assert.deepEqual(modelsToAskAbout({
    items: [{ name: 'VELA ANGELITO', quantity: 2 }], customerText: 'quiero 2 docenas', history: equipo, catalog: catalogo
  }), ['VELA ANGELITO', 'OSITO GRANDE CORAZON']);
});

test('sin cantidad en el pedido no hay nada que preguntar', () => {
  assert.deepEqual(modelsToAskAbout({ items: [], customerText: 'hola', history: qfzb, catalog: catalogo }), []);
});

// ---------------- Fotos por sexo ----------------

test('"Bautizo para hombre" es niño (caso Zamuuu)', () => {
  assert.equal(customerSex('Bautizo para hombre'), 'niño');
  assert.equal(customerSex('es para mi sobrina'), 'niña');
  assert.equal(customerSex('Para bautizo de niña'), 'niña');
  assert.equal(customerSex('no sé si niño o niña'), '');
});

const bautizo = [
  { name: 'CRUZ CON FLORES', category: 'BAUTIZO', gender: null, image_url: 'x' },
  { name: 'VELA CRUZ CON NIÑA', category: 'BAUTIZO', gender: 'niña', image_url: 'x' },
  { name: 'VELA CRUZ CON NIÑO', category: 'BAUTIZO', gender: 'niño', image_url: 'x' },
  { name: 'VELA CRUZ FLORAL', category: 'BAUTIZO', gender: 'niña', image_url: 'x' }
];

test('con el sexo dicho por la clienta, los suyos van primero aunque la IA ponga otro antes', () => {
  assert.deepEqual(withOppositeGender(['VELA CRUZ CON NIÑA', 'CRUZ CON FLORES', 'VELA CRUZ CON NIÑO'], bautizo, [], 'niño'),
    ['CRUZ CON FLORES', 'VELA CRUZ CON NIÑO', 'VELA CRUZ CON NIÑA', 'VELA CRUZ FLORAL']);
});

test('si la tanda trae del otro sexo y el texto no lo dice, se aclara antes de la pregunta', () => {
  const texto = noteOppositeGender('Para bautizo te muestro más opciones que van muy bien para niño 🕯️', ['VELA CRUZ CON NIÑO', 'VELA CRUZ CON NIÑA'], bautizo, 'niño');
  assert.ok(/algunos de niña porque se pueden personalizar/.test(texto));
  const conPregunta = noteOppositeGender('Te muestro opciones para niño.\n¿Para cuántas personas sería?', ['VELA CRUZ CON NIÑA'], bautizo, 'niño');
  assert.ok(/personalizar[^?]*\n\n¿Para cuántas personas sería\?$/.test(conPregunta));
});

test('no se agrega nada si la tanda es solo de su sexo o si el texto ya lo explica', () => {
  const solo = 'Opciones para niño 🕯️';
  assert.equal(noteOppositeGender(solo, ['VELA CRUZ CON NIÑO', 'CRUZ CON FLORES'], bautizo, 'niño'), solo);
  const explicado = 'Te muestro los de niño y también de niña, que se pueden personalizar ✨';
  assert.equal(noteOppositeGender(explicado, ['VELA CRUZ CON NIÑA'], bautizo, 'niño'), explicado);
  assert.equal(noteOppositeGender(solo, ['VELA CRUZ CON NIÑA'], bautizo, ''), solo);
});

test('"¿Para qué evento buscas las velitas?" no es pedir elegir modelo (daba avisos falsos de "atascado")', async () => {
  const { sameQuestion } = await import('../src/services/openai');
  const nombres = ['VELA ANGELITO', 'VELA DE VIRGENCITA CON CORAZON'];
  assert.equal(sameQuestion('¿Cuál te gustó más: *VELA ANGELITO* o *VELA DE VIRGENCITA CON CORAZON*?', '¿Para qué evento buscas las velitas?', nombres), false);
  assert.equal(sameQuestion('¿Qué modelo prefieres?', '¿Cuál de las dos velitas quieres?', nombres), true);
});
