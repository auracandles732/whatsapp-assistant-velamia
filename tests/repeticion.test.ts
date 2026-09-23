/**
 * El asistente no da vueltas: no repite una pregunta que la clienta dejó sin contestar (aunque haya otros mensajes en
 * medio), no contesta "claro" a "envíamelo" sin enviar nada y no mezcla modelos de otra categoría. Casos reales del 21 al 23-sep.
 */
import './entorno';

import test from 'node:test';
import assert from 'node:assert/strict';
import { repeatedQuestion, asksToBeSent, varietyPicks } from '../src/services/openai';
import { sameCategoryAsMost } from '../src/services/photoBackup';
import { normalizeProfile, PROFILE_PRESETS } from '../src/config/businessProfile';
import { morePhotosQuestions, moreWithQuantityQuestions, quantityAfterPhotosQuestions } from '../src/controllers/messageController';

const perfil = normalizeProfile(PROFILE_PRESETS.eventos.profile);
const nombres = ['VELA REGALO NAVIDEÑO', 'OSITO GRANDE CORAZON'];

const saludo = 'Hola, qué gusto saludarte 🤍\n\nCon mucho gusto te ayudo con la información de nuestros modelos, precios y personalización.\n\n¿Para qué evento buscas las velas?';
const seguimientoCotizacion = 'Hola, amiga ✨ Espero que estés muy bien. Quería saber si pudiste revisar la cotización de tus velitas 🕯️. Si tienes alguna pregunta, con gusto te ayudo 😊';
const seguimientoFecha = 'Amiga 🌸 Para ayudarte mejor, ¿ya tienes definida la fecha de tu evento? Así puedo orientarte con el tiempo ideal para preparar tus velitas 🕯️✨';

test('Giselle: no vuelve a preguntar el evento aunque en medio haya un seguimiento', () => {
  const respuesta = 'Claro, con gusto 🌸\n\n¿Para qué evento buscas las velas?';
  assert.ok(repeatedQuestion(respuesta, [saludo, seguimientoCotizacion], nombres, perfil));
});

test('Giselle: tampoco la tercera vez, aunque cambie las palabras', () => {
  const anteriores = [saludo, seguimientoCotizacion, 'Claro, con gusto 🌸\n\n¿Para qué evento buscas las velas?', seguimientoFecha];
  const respuesta = 'Perfecto, *9 de octubre* 🌺\n\n📅 *Entrega:* 06/10/2026\n\n¿Para qué evento serían?';
  assert.ok(repeatedQuestion(respuesta, anteriores, nombres, perfil));
});

test('no repite la cantidad aunque en medio haya hecho otra pregunta', () => {
  const anteriores = [
    'La vela *VELA REGALO NAVIDEÑO* mide *8 x 8 cm*.\n\nSi quieres, te cotizo cuántas docenas necesitas.',
    '¿Para cuántas docenas la necesitas?',
    'Tómate tu tiempo 💖\n\n¿Te hace dudar el modelo o la cantidad?'
  ];
  assert.ok(repeatedQuestion('Perfecto 💫\n\n¿Para cuántas docenas la necesitas?', anteriores, nombres, perfil));
  assert.ok(repeatedQuestion('¿Cuántos invitados tendrás?', anteriores, nombres, perfil));
});

test('una pregunta nueva o que propone opciones concretas sí se permite', () => {
  assert.equal(repeatedQuestion('*baby shower* 🤍\n\n¿Es para niño o niña?', [saludo, seguimientoFecha], nombres, perfil), '');
  assert.equal(repeatedQuestion('El osito queda lindo 🧸 ¿Te cotizo 3 docenas o prefieres otra cantidad?', ['¿Para cuántas docenas la necesitas?'], nombres, perfil), '');
  assert.equal(repeatedQuestion('Tenemos varios 🕯️ ¿Es para baby shower, bautizo, boda o cumpleaños?', [saludo], nombres, perfil), '');
  assert.equal(repeatedQuestion('¿Para qué evento buscas las velas?', [], nombres, perfil), '');
});

test('reconoce cuando la clienta pide que le envíen algo', () => {
  assert.ok(asksToBeSent('No la revise disculpe me podría enviar de nuevo'));
  assert.ok(asksToBeSent('Mándame el catálogo porfa'));
  assert.ok(asksToBeSent('me pasas fotos de bautizo'));
  assert.ok(asksToBeSent('Quiero ver los modelos'));
  assert.ok(asksToBeSent('Enséñame los de niña'));
});

test('no confunde con el saludo del anuncio, con lo que ella envía ni con pedidos de pago o total', () => {
  assert.ok(!asksToBeSent('¡Hola! Quiero más información'));
  assert.ok(!asksToBeSent('Te mando la foto de referencia'));
  assert.ok(!asksToBeSent('Envíame los datos para transferir'));
  assert.ok(!asksToBeSent('¿Me envías el total?'));
});

test('modelos variados: uno por categoría, primero los neutros y sin repetir lo ya enviado', () => {
  const catalogo = [
    { name: 'Osito niño', price: 30, category: 'BABY SHOWER', gender: 'niño', image_url: 'x' },
    { name: 'Pollito', price: 30, category: 'BABY SHOWER', gender: null, image_url: 'x' },
    { name: 'Cruz', price: 32, category: 'BAUTIZO', gender: null, image_url: 'x' },
    { name: 'Papá Noel', price: 42, category: 'NAVIDAD', gender: null, image_url: 'x' },
    { name: 'Reno', price: 42, category: 'NAVIDAD', gender: null, image_url: 'x' },
    { name: 'Sin foto', price: 20, category: 'BODA', gender: null, image_url: '' }
  ];
  assert.deepEqual(varietyPicks(catalogo, [], 4), ['Pollito', 'Cruz', 'Papá Noel', 'Osito niño']);
  assert.deepEqual(varietyPicks(catalogo, ['Cruz'], 3), ['Pollito', 'Papá Noel', 'Osito niño']);
});

const catalogoBaby = [
  { name: 'OSITO EN NUBE CON CORAZON ALADO', category: 'BABY SHOWER', gender: 'niña' },
  { name: 'OSITO GRANDE CORAZON', category: 'BABY SHOWER', gender: 'niña' },
  { name: 'VELA DE JIRAFA', category: 'BABY SHOWER', gender: 'niña' },
  { name: 'VELA DE VIRGENCITA CON CORAZON', category: 'BAUTIZO', gender: 'niña' },
  { name: 'CRUZ CON FLORES DE BAUTIZO', category: 'BAUTIZO', gender: null }
];

test('Giselle: no se cuela una virgencita de bautizo entre los de baby shower', () => {
  const elegidos = ['OSITO EN NUBE CON CORAZON ALADO', 'OSITO GRANDE CORAZON', 'VELA DE JIRAFA', 'VELA DE VIRGENCITA CON CORAZON'];
  assert.deepEqual(
    sameCategoryAsMost(elegidos, catalogoBaby, 'Sería para el 9 de octubre\nPara un baby shower\nEs para niña'),
    ['OSITO EN NUBE CON CORAZON ALADO', 'OSITO GRANDE CORAZON', 'VELA DE JIRAFA']
  );
});

test('si la clienta nombró esa otra categoría o el modelo, se respeta', () => {
  const elegidos = ['OSITO EN NUBE CON CORAZON ALADO', 'OSITO GRANDE CORAZON', 'VELA DE JIRAFA', 'VELA DE VIRGENCITA CON CORAZON'];
  assert.deepEqual(sameCategoryAsMost(elegidos, catalogoBaby, 'Es para baby shower y bautizo'), elegidos);
  const mitad = ['OSITO GRANDE CORAZON', 'VELA DE JIRAFA', 'VELA DE VIRGENCITA CON CORAZON', 'CRUZ CON FLORES DE BAUTIZO'];
  assert.deepEqual(sameCategoryAsMost(mitad, catalogoBaby, 'hola'), mitad);
});

test('tras las fotos ya no pregunta solo "¿Deseas ver más opciones?": invita a elegir o pide la cantidad', () => {
  for (const q of morePhotosQuestions()) {
    assert.ok(!/^¿Deseas ver más opciones\?/.test(q));
    assert.ok(/gust|convence/.test(q), q);
  }
  const conCantidad = moreWithQuantityQuestions();
  assert.equal(conCantidad.length, quantityAfterPhotosQuestions().length);
  for (const q of conCantidad) assert.ok(/más .* para mostrarte\. ¿/.test(q), q);
});
