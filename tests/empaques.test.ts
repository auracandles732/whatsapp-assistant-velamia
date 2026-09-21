/**
 * Reconocimiento de empaques: la IA a veces escribe el nombre con otras palabras ("bolsa de tul", "caja con lazo").
 * Debe reconocer las variantes claras y no adivinar cuando hay duda.
 */
import './entorno';

import test from 'node:test';
import assert from 'node:assert/strict';

import { findPackaging, normalizeProfile, packagingChange, PROFILE_PRESETS, getOpenAIVisionModel, getOpenAIModel } from '../src/config/businessProfile';
import { buildSystemPrompt, computeOrderTotal, namedByCustomer, sameQuestion, removeUnverifiedTotals, removeBareFromPersonalization, ensurePackagingLine, bareOffer, buildImagePrompt } from '../src/services/openai';

const conEmpaques = normalizeProfile({
  ...PROFILE_PRESETS.eventos.profile,
  packaging: {
    enabled: true,
    types: [
      { name: 'Acetato', description: 'transparente', changeCost: null },
      { name: 'Tul', description: 'delicado, con lazo', changeCost: 2 },
      { name: 'Kraft', description: 'natural', changeCost: 0 },
      { name: 'Caja lazo personalizable', description: 'caja con lazo', changeCost: null }
    ]
  }
});

const sinEmpaques = normalizeProfile({ ...PROFILE_PRESETS.tienda.profile, packaging: { enabled: false, types: [] } });

test('reconoce el nombre exacto sin importar mayúsculas, tildes ni espacios', () => {
  assert.equal(findPackaging('Tul', conEmpaques)?.name, 'Tul');
  assert.equal(findPackaging('  kRaFt ', conEmpaques)?.name, 'Kraft');
  assert.equal(findPackaging('caja lazo personalizable', conEmpaques)?.name, 'Caja lazo personalizable');
});

test('reconoce variantes claras que contienen el nombre', () => {
  assert.equal(findPackaging('bolsa de tul', conEmpaques)?.name, 'Tul');
  assert.equal(findPackaging('caja Kraft', conEmpaques)?.name, 'Kraft');
  assert.equal(findPackaging('acetato transparente', conEmpaques)?.name, 'Acetato');
});

test('reconoce la caja aunque cambien las palabras de en medio', () => {
  assert.equal(findPackaging('Caja con lazo', conEmpaques)?.name, 'Caja lazo personalizable');
  assert.equal(findPackaging('caja personalizable con lazo', conEmpaques)?.name, 'Caja lazo personalizable');
});

test('si solo hay una opción que encaja, la reconoce aunque el cliente diga una sola palabra', () => {
  assert.equal(findPackaging('caja', conEmpaques)?.name, 'Caja lazo personalizable');
});

test('ante la duda no adivina', () => {
  assert.equal(findPackaging('tul o kraft', conEmpaques), undefined);
  assert.equal(findPackaging('bolsita', conEmpaques), undefined);
  assert.equal(findPackaging('bolsa o caja de papel', conEmpaques), undefined);
  assert.equal(findPackaging('', conEmpaques), undefined);
  assert.equal(findPackaging(null, conEmpaques), undefined);
});

test('un negocio sin empaques no recibe reglas de empaque en sus instrucciones', () => {
  const prompt = buildSystemPrompt([{ name: 'Wall Panel', price: 75, category: 'PANELES' }], undefined, sinEmpaques);
  assert.ok(!prompt.includes('EMPAQUE (campo packaging'));
  assert.ok(!/Tipos de empaque/.test(prompt));
});

test('con empaques, el asistente recibe la lista completa y qué hacer si un producto no tiene empaque', () => {
  const prompt = buildSystemPrompt([{ name: 'Vela', price: 30, category: 'EVENTOS', description: '' }], undefined, conEmpaques);
  assert.ok(prompt.includes('Tipos de empaque'));
  assert.ok(prompt.includes('Caja lazo personalizable: caja con lazo'));
  assert.ok(prompt.includes('describe TODOS los tipos'));
  assert.ok(prompt.includes('no inventes: dile que confirmas cuál lleva'));
  assert.ok(prompt.includes('Acetato, Tul, Kraft, Caja lazo personalizable'));
});

// ---------- Cómo viajan los pedidos ----------

const conNota = normalizeProfile({
  ...PROFILE_PRESETS.eventos.profile,
  shipping: { ...PROFILE_PRESETS.eventos.profile.shipping, packingNote: 'Todos los pedidos salen en una caja de cartón bien protegida.' }
});

test('la nota de embalaje solo llega a las instrucciones del negocio que la escribió', () => {
  const catalogo = [{ name: 'Vela', price: 30, category: 'EVENTOS' }];
  assert.ok(buildSystemPrompt(catalogo, undefined, conNota).includes('caja de cartón bien protegida'));
  assert.ok(!buildSystemPrompt(catalogo, undefined, conEmpaques).includes('Cómo viajan los pedidos'));
  assert.ok(!buildSystemPrompt(catalogo, undefined, sinEmpaques).includes('Cómo viajan los pedidos'));
});

test('un perfil guardado antes de esta nota queda con la nota vacía', () => {
  const antes = { ...PROFILE_PRESETS.eventos.profile, shipping: { ...PROFILE_PRESETS.eventos.profile.shipping } };
  delete (antes.shipping as any).packingNote;
  assert.equal(normalizeProfile(antes).shipping.packingNote, '');
});

// ---------- Cambios de un empaque a otro ----------

const conCambios = normalizeProfile({
  ...PROFILE_PRESETS.eventos.profile,
  shipping: { ...PROFILE_PRESETS.eventos.profile.shipping, mode: 'flat', flatRate: 10, unitsIncludedInRate: 0, extraCost: 0 },
  packaging: {
    enabled: true,
    types: [
      { name: 'Tul', description: 'delicado, con lazo', changeCost: null },
      { name: 'Acetato', description: 'transparente', changeCost: null },
      { name: 'Caja lazo personalizable', description: 'caja con lazo', changeCost: null },
      { name: 'Kraft', description: 'natural', changeCost: null }
    ],
    changes: [
      { from: 'Caja lazo personalizable', to: 'Tul', cost: 0, allowed: true, note: '' },
      { from: 'Caja lazo personalizable', to: 'Acetato', cost: 4, allowed: true, note: '' },
      { from: 'Tul', to: 'Caja lazo personalizable', cost: null, allowed: false, note: 'por el peso y la altura de la vela' },
      { from: 'Tul', to: 'Acetato', cost: 5, allowed: true, note: '' },
      { from: 'Acetato', to: 'Tul', cost: 0, allowed: true, note: 'En el tul sí se aprecia bien la vela.' },
      { from: 'Acetato', to: 'Caja lazo personalizable', cost: 0, allowed: true, note: 'No se recomienda: en la caja no se aprecia bien la vela.' },
      { from: 'Tul', to: 'Tul', cost: 1, allowed: true, note: 'inválida: mismo empaque' },
      { from: '', to: 'Kraft', cost: 1, allowed: true, note: 'inválida: sin origen' }
    ]
  }
});

const catalogoCambios = [
  { name: 'Vela con tul', price: 30, category: 'EVENTOS', description: 'Tul' },
  { name: 'Vela con caja', price: 30, category: 'EVENTOS', description: 'Caja lazo personalizable' },
  { name: 'Vela con acetato', price: 30, category: 'EVENTOS', description: 'Acetato' }
];

const pedir = (modelo: string, empaque: string) =>
  computeOrderTotal([{ name: modelo, quantity: 2, packaging: empaque }], 'Quito', catalogoCambios, conCambios);

test('las reglas de cambio se guardan y se descartan las que no tienen sentido', () => {
  assert.equal(conCambios.packaging.changes.length, 6);
  assert.equal(normalizeProfile({ packaging: { enabled: true, types: [] } }).packaging.changes.length, 0);
});

test('una regla escrita manda; si no hay regla vale el costo general del empaque nuevo', () => {
  assert.deepEqual(packagingChange('Tul', 'Acetato', conCambios), { allowed: true, cost: 5, note: '', specific: true });
  assert.equal(packagingChange('Tul', 'Caja lazo personalizable', conCambios)?.allowed, false);
  assert.equal(packagingChange('Acetato', 'Kraft', conCambios)?.specific, false);
  assert.equal(packagingChange('Acetato', 'Kraft', conCambios)?.cost, null);
  assert.equal(packagingChange('Tul', 'no existe', conCambios), undefined);
});

test('de tul a caja NO se puede: se queda el tul, se explica el motivo y se ofrecen las otras opciones', () => {
  const pedido = pedir('Vela con tul', 'Caja lazo personalizable');
  assert.equal(pedido.items[0].packaging, 'Tul');
  assert.equal(pedido.items[0].packagingChanged, false);
  assert.equal(pedido.packagingBlocked, 'Caja lazo personalizable');
  assert.equal(pedido.packagingBlockedNote, 'por el peso y la altura de la vela');
  assert.deepEqual(pedido.packagingAlternatives, ['Acetato', 'Kraft']);
  assert.equal(pedido.missing, '');
  assert.equal(pedido.total, 70);
});

test('de caja a tul sí se puede y no cuesta extra', () => {
  const pedido = pedir('Vela con caja', 'Tul');
  assert.equal(pedido.items[0].packaging, 'Tul');
  assert.equal(pedido.items[0].packagingChanged, true);
  assert.equal(pedido.packagingBlocked, '');
  assert.equal(pedido.total, 70);
});

test('de caja a acetato suma $4 por docena', () => {
  assert.equal(pedir('Vela con caja', 'Acetato').total, 2 * 34 + 10);
});

test('de tul a acetato suma $5 por docena', () => {
  assert.equal(pedir('Vela con tul', 'Acetato').total, 2 * 35 + 10);
});

test('de acetato a tul o a caja no cuesta extra, y a la caja se le avisa que no se recomienda', () => {
  assert.equal(pedir('Vela con acetato', 'Tul').total, 70);
  const aCaja = pedir('Vela con acetato', 'Caja lazo personalizable');
  assert.equal(aCaja.total, 70);
  assert.equal(aCaja.items[0].packaging, 'Caja lazo personalizable');
  assert.equal(aCaja.packagingBlocked, '');
  assert.match(packagingChange('Acetato', 'Caja lazo personalizable', conCambios)!.note, /No se recomienda/);
});

test('quedarse con el empaque que ya trae no es un cambio', () => {
  const pedido = pedir('Vela con caja', 'Caja lazo personalizable');
  assert.equal(pedido.items[0].packagingChanged, false);
  assert.equal(pedido.packagingBlocked, '');
});

test('un cambio sin regla ni costo definido queda por confirmar', () => {
  assert.equal(pedir('Vela con tul', 'Kraft').missing, 'packaging_cost');
});

test('las instrucciones del asistente traen la tabla de cambios con costos, prohibiciones y notas', () => {
  const prompt = buildSystemPrompt(catalogoCambios, undefined, conCambios);
  assert.ok(prompt.includes('Caja lazo personalizable → Tul: sin costo'));
  assert.ok(prompt.includes('Caja lazo personalizable → Acetato: +$4.00 por docena'));
  assert.ok(prompt.includes('Tul → Acetato: +$5.00 por docena'));
  assert.ok(prompt.includes('Tul → Caja lazo personalizable: NO se puede. por el peso y la altura de la vela'));
  assert.ok(prompt.includes('Acetato → Caja lazo personalizable: sin costo. No se recomienda'));
  assert.ok(!buildSystemPrompt(catalogoCambios, undefined, conEmpaques).includes('Cambios de empaque, del empaque que trae'));
});

test('un cambio con nota devuelve el aviso que hay que darle a la clienta; uno sin nota no', () => {
  const aCaja = pedir('Vela con acetato', 'Caja lazo personalizable');
  assert.equal(aCaja.packagingAdvice?.packaging, 'Caja lazo personalizable');
  assert.match(aCaja.packagingAdvice!.note, /No se recomienda/);
  assert.equal(pedir('Vela con caja', 'Tul').packagingAdvice, null);
  assert.equal(pedir('Vela con tul', 'Acetato').packagingAdvice, null);
});

// ---------- Modelos que van tal cual (frascos): ningún empaque ----------

const conFrascos = normalizeProfile({
  ...PROFILE_PRESETS.eventos.profile,
  shipping: { ...PROFILE_PRESETS.eventos.profile.shipping, mode: 'flat', flatRate: 10, unitsIncludedInRate: 0, extraCost: 0 },
  packaging: {
    enabled: true,
    types: [
      { name: 'Tul', description: 'delicado', changeCost: null },
      { name: 'Kraft', description: 'natural', changeCost: null },
      { name: 'Sin empaque', description: 'va tal cual en su frasco', changeCost: null }
    ],
    changes: [
      { from: 'Sin empaque', to: 'Tul', cost: null, allowed: false, note: 'Los frascos son anchos y pesados: van tal cual.' },
      { from: 'Sin empaque', to: 'Kraft', cost: null, allowed: false, note: 'Los frascos son anchos y pesados: van tal cual.' }
    ]
  }
});

test('un modelo en frasco no admite ningún empaque y no se ofrecen alternativas', () => {
  const catalogo = [{ name: 'Vela en frasco', price: 45, category: 'EVENTOS', description: 'Sin empaque' }];
  const pedido = computeOrderTotal([{ name: 'Vela en frasco', quantity: 1, packaging: 'Tul' }], 'Quito', catalogo, conFrascos);
  assert.equal(pedido.items[0].packaging, 'Sin empaque');
  assert.equal(pedido.items[0].packagingChanged, false);
  assert.equal(pedido.packagingBlocked, 'Tul');
  assert.deepEqual(pedido.packagingAlternatives, []);
  assert.equal(pedido.total, 55);
});

test('el mismo negocio sigue dejando cambiar entre los empaques de los demás modelos', () => {
  const catalogo = [{ name: 'Vela normal', price: 30, category: 'EVENTOS', description: 'Tul' }];
  const pedido = computeOrderTotal([{ name: 'Vela normal', quantity: 1, packaging: 'Kraft' }], 'Quito', catalogo, conFrascos);
  assert.equal(pedido.packagingBlocked, '');
  assert.equal(pedido.missing, 'packaging_cost');
});

// ---------- Estilo de conversación: no repetir el saludo, entender erratas ----------

test('las instrucciones piden saludar solo una vez y entender erratas sin preguntar', () => {
  const prompt = buildSystemPrompt([{ name: 'Vela', price: 30, category: 'EVENTOS' }], undefined, conEmpaques);
  assert.ok(/Saluda[\s\S]*?SOLO en tu primer mensaje/.test(prompt));
  assert.ok(/errata obvia/.test(prompt));
});

// ---------- Baby shower: sugerir color según el sexo del bebé ----------

test('con personalización activa, las instrucciones piden sugerir el color típico según el sexo del bebé', () => {
  const prompt = buildSystemPrompt([{ name: 'Vela', price: 30, category: 'EVENTOS' }], undefined, conEmpaques);
  assert.ok(/celeste o azul para ni[ñn]o, rosado para ni[ñn]a/.test(prompt));
});

test('un negocio sin personalización no recibe esta regla', () => {
  const prompt = buildSystemPrompt([{ name: 'Producto', price: 30, category: 'X' }], undefined, sinEmpaques);
  assert.ok(!/color típico/.test(prompt));
});

// ---------- Una pregunta por mensaje y datos ya dados ----------

test('las instrucciones piden una sola pregunta y no repetir datos que el cliente ya dio', () => {
  const prompt = buildSystemPrompt([{ name: 'Vela', price: 30, category: 'EVENTOS' }], undefined, conEmpaques);
  assert.ok(/UNA sola pregunta por mensaje/.test(prompt));
  assert.ok(/NUNCA se le vuelve a preguntar/.test(prompt));
});

// ---------- Fotos repetidas: reconocer cuando el cliente nombra un modelo ----------

test('reconoce el modelo aunque el cliente no diga el nombre completo', () => {
  assert.equal(namedByCustomer('OSITO GRANDE CORAZON', 'me mandas el osito grande porfa'), true);
  assert.equal(namedByCustomer('VELA DE ANGELITO REZANDO CON ROSARIO', 'no me llego la del angelito rezando'), true);
  assert.equal(namedByCustomer('OSITO EN NUBE CON CORAZON', 'quiero el osito en nube'), true);
});

test('no confunde un modelo con otro ni con una frase cualquiera', () => {
  assert.equal(namedByCustomer('OSITO GRANDE CORAZON', 'quiero velitas para baby shower'), false);
  assert.equal(namedByCustomer('VELA DE JIRAFA', 'me gustan las velas'), false);
  assert.equal(namedByCustomer('OSITO GRANDE CORAZON', 'el osito'), false);
});

// ---------- "Solo la vela": quitar el empaque (descuento) ----------

const conSoloVela = normalizeProfile({
  ...PROFILE_PRESETS.eventos.profile,
  shipping: { ...PROFILE_PRESETS.eventos.profile.shipping, mode: 'flat', flatRate: 10, unitsIncludedInRate: 0, extraCost: 0 },
  packaging: {
    enabled: true,
    types: [
      { name: 'Caja lazo personalizable', description: 'caja con lazo', changeCost: null },
      { name: 'Sin empaque', description: 'va tal cual en su frasco', changeCost: null },
      { name: 'Solo la vela', description: 'la vela sola, sin empaque', changeCost: -2, bare: true }
    ],
    changes: [
      { from: 'Sin empaque', to: 'Solo la vela', cost: null, allowed: true, note: 'Sin el frasco el precio lo confirma el equipo.' }
    ]
  }
});

const catalogoSoloVela = [
  { name: 'Vela con caja', price: 30, category: 'BABY SHOWER', description: 'Caja lazo personalizable' },
  { name: 'Vela en frasco', price: 45, category: 'BABY SHOWER', description: 'Sin empaque' }
];

test('los costos de cambio pueden ser negativos (descuentos) y se guardan', () => {
  assert.equal(conSoloVela.packaging.types.find(t => t.name === 'Solo la vela')?.changeCost, -2);
  assert.equal(conSoloVela.packaging.types.find(t => t.name === 'Solo la vela')?.bare, true);
  assert.equal(conSoloVela.packaging.types.find(t => t.name === 'Caja lazo personalizable')?.bare, false);
});

test('"solo la vela" en un modelo con caja cuesta $2 menos por docena (caso Sandra: $30 → $28)', () => {
  const pedido = computeOrderTotal([{ name: 'Vela con caja', quantity: 4, packaging: 'Solo la vela' }], 'Quito', catalogoSoloVela, conSoloVela);
  assert.equal(pedido.items[0].price, 28);
  assert.equal(pedido.items[0].packaging, 'Solo la vela');
  assert.equal(pedido.items[0].packagingChanged, true);
  assert.equal(pedido.missing, '');
  assert.equal(pedido.total, 4 * 28 + 10);
});

test('"sin frasco" en un modelo en frasco queda por confirmar y no da total', () => {
  const pedido = computeOrderTotal([{ name: 'Vela en frasco', quantity: 4, packaging: 'Solo la vela' }], 'Quito', catalogoSoloVela, conSoloVela);
  assert.equal(pedido.missing, 'packaging_cost');
  assert.equal(pedido.total, 0);
});

test('un descuento nunca deja el precio en negativo', () => {
  const barato = [{ name: 'Vela barata', price: 1, category: 'X', description: 'Caja lazo personalizable' }];
  const pedido = computeOrderTotal([{ name: 'Vela barata', quantity: 1, packaging: 'Solo la vela' }], 'Quito', barato, conSoloVela);
  assert.equal(pedido.items[0].price, 0);
});

test('las instrucciones piden confirmar con sí o no y luego vender "solo la vela", mostrando el descuento', () => {
  const prompt = buildSystemPrompt(catalogoSoloVela, undefined, conSoloVela);
  assert.ok(prompt.includes('Solo la vela (descuento de $2.00 por docena)'));
  assert.ok(/es una VENTA, no un problema/.test(prompt));
  assert.ok(/CAMBIO DE EMPAQUE a "Solo la vela"/.test(prompt));
  assert.ok(/UNA pregunta de sí o no/.test(prompt));
  assert.ok(/Claro que sí 🤍 ¿Entonces deseas la velita sin el frasco de vidrio\?/.test(prompt));
  assert.ok(/Si responde que sí.*sigue vendiendo hasta el total/.test(prompt));
  assert.ok(/nunca inventes el precio/.test(prompt));
  assert.ok(/nunca vuelvas a preguntar cuál/.test(prompt));
});

test('un negocio sin empaque marcado como "solo el producto" no recibe esa regla', () => {
  const prompt = buildSystemPrompt(catalogoSoloVela, undefined, conEmpaques);
  assert.ok(!/CAMBIO DE EMPAQUE a "/.test(prompt));
});

// ---------- Freno anti-bucle ----------

test('reconoce la misma pregunta dicha con palabras parecidas (caso Sandra)', () => {
  const a = 'Sí, claro 🤍 la *VELA DE LEON EN FRASCO DE VIDRIO* ya va *sin empaque*.\n\n¿Cuál de las dos deseas?';
  const b = 'Sí, claro 🤍 la *VELA DE LEON EN FRASCO DE VIDRIO* ya va *sin empaque*.\n\n¿Cuál de los dos modelos deseas?';
  assert.equal(sameQuestion(b, a), true);
  assert.equal(sameQuestion('¿Para qué ciudad sería el envío?', '¿Cuál de los dos modelos deseas?'), false);
  assert.equal(sameQuestion('Perfecto, gracias.', '¿Cuál de los dos modelos deseas?'), false);
  assert.equal(sameQuestion('', ''), false);
});

test('el freno anti-bucle reconoce "elige entre los mismos modelos" con palabras distintas', () => {
  const nombres = ['VELA DE LEONCITO', 'VELA DE LEON EN FRASCO DE VIDRIO'];
  const a = '¿Te cotizo *VELA DE LEONCITO* o *VELA DE LEON EN FRASCO DE VIDRIO* con ese cambio?';
  const b = '¿Con cuál de las dos velitas quieres la cotización?';
  const c = 'Para darte el valor exacto, ¿cuál de las dos quieres: *VELA DE LEONCITO* o *VELA DE LEON EN FRASCO DE VIDRIO*?';
  assert.equal(sameQuestion(c, a, nombres), true);
  assert.equal(sameQuestion('¿A qué ciudad va el pedido?', a, nombres), false);
  assert.equal(sameQuestion('¿Prefieres pagar por transferencia o con tarjeta?', a, nombres), false);
  assert.equal(sameQuestion(b, a, nombres), true, 'también es pedir elegir entre los mismos modelos');
  assert.equal(sameQuestion('¿Qué modelo prefieres?', a, nombres), true);
});

test('"solo la vela" nunca queda anotado como personalización', () => {
  const pedido = computeOrderTotal(
    [{ name: 'Vela con caja', quantity: 2, packaging: 'Solo la vela', personalization: 'solo la vela' }],
    'Quito', catalogoSoloVela, conSoloVela);
  assert.equal(pedido.items[0].personalization, '');
  const conColor = computeOrderTotal(
    [{ name: 'Vela con caja', quantity: 2, packaging: 'Solo la vela', personalization: 'color celeste, solo la vela' }],
    'Quito', catalogoSoloVela, conSoloVela);
  assert.equal(conColor.items[0].personalization, 'color celeste');
});

// ---------- Red de seguridad: nunca un total que el sistema no calculó ----------

test('quita el total, el anticipo y la pregunta de pago cuando el sistema no pudo calcular el total (caso $184)', () => {
  const respuesta = [
    'Ya con envío a *Guayaquil* te queda así 🤍',
    '🕯️ *Modelo:* VELA DE LEON EN FRASCO DE VIDRIO',
    '📦 *Cantidad:* 4 docenas',
    '💰 *Total:* $184.00',
    '💳 *Anticipo 50%:* $92.00',
    '¿Prefieres pagar por transferencia o con tarjeta?'
  ].join('\n');
  const limpio = removeUnverifiedTotals(respuesta);
  assert.equal(limpio.removed, true);
  assert.ok(!limpio.text.includes('184'));
  assert.ok(!limpio.text.includes('92'));
  assert.ok(!/transferencia/.test(limpio.text));
  assert.ok(limpio.text.includes('*Modelo:*'));
  assert.ok(limpio.text.includes('*Cantidad:* 4 docenas'));
});

test('no toca los precios de catálogo ni las respuestas sin totales', () => {
  const precio = 'La *VELA DE LEONCITO* cuesta $30.00 la docena 🤍\n¿Cuántas docenas necesitas?';
  const limpio = removeUnverifiedTotals(precio);
  assert.equal(limpio.removed, false);
  assert.equal(limpio.text, precio);
});

test('quita la línea "Personalización: solo la vela" del resumen y conserva el resto', () => {
  const resumen = [
    'Perfecto 🤍',
    '🕯️ *Modelo:* VELA DE LEONCITO',
    '📦 *Cantidad:* 4 docenas',
    '🎨 *Personalización:* solo la vela',
    '📦 *Empaque:* Solo la vela',
    '💰 *Total:* $116.00'
  ].join('\n');
  const limpio = removeBareFromPersonalization(resumen, conSoloVela);
  assert.ok(!/Personalizaci/.test(limpio));
  assert.ok(limpio.includes('*Empaque:* Solo la vela'));
  assert.ok(limpio.includes('*Total:* $116.00'));
});

test('no toca una personalización real, ni a los negocios sin empaque "solo el producto"', () => {
  const conColor = '🎨 *Personalización:* color celeste y nombre Emma\n📦 *Cantidad:* 2 docenas';
  assert.equal(removeBareFromPersonalization(conColor, conSoloVela), conColor);
  const otra = '🎨 *Personalización:* solo la vela';
  assert.equal(removeBareFromPersonalization(otra, conEmpaques), otra);
});

test('si se cambió el empaque y el resumen no lo dice, se agrega su línea debajo de la cantidad', () => {
  const resumen = 'Claro 🤍\n\n🕯️ *Modelo:* VELA DE LEONCITO\n📦 *Cantidad:* 4 docenas\n💰 *Total:* $116.00';
  const con = ensurePackagingLine(resumen, [{ packaging: 'Solo la vela', packagingChanged: true }]);
  assert.ok(con.includes('*Cantidad:* 4 docenas\n📦 *Empaque:* Solo la vela\n💰'));
});

test('no agrega nada si ya lo dice, si no hubo cambio o si no hay resumen', () => {
  const yaLoDice = '📦 *Cantidad:* 4 docenas\n🎀 *Empaque:* Solo la vela';
  assert.equal(ensurePackagingLine(yaLoDice, [{ packaging: 'Solo la vela', packagingChanged: true }]), yaLoDice);
  const sinCambio = '📦 *Cantidad:* 4 docenas';
  assert.equal(ensurePackagingLine(sinCambio, [{ packaging: 'Tul', packagingChanged: false }]), sinCambio);
  assert.equal(ensurePackagingLine('Hola 🤍', [{ packaging: 'Solo la vela', packagingChanged: true }]), 'Hola 🤍');
});

// ---------- Cada modelo dice su precio de "solo la vela" ----------

test('un modelo con caja muestra su precio de "solo la vela" con el descuento ya aplicado', () => {
  assert.equal(bareOffer({ price: 30, description: 'Caja lazo personalizable' }, conSoloVela), ' · solo la vela: $28.00');
});

test('un modelo en frasco muestra "precio por confirmar", nunca un descuento inventado', () => {
  assert.equal(bareOffer({ price: 45, description: 'Sin empaque' }, conSoloVela), ' · solo la vela: precio por confirmar');
});

test('no ofrece "solo la vela" donde no aplica', () => {
  assert.equal(bareOffer({ price: 30, description: 'Solo la vela' }, conSoloVela), '');
  assert.equal(bareOffer({ price: 30, description: '' }, conSoloVela), '');
  assert.equal(bareOffer({ price: 30, description: 'Caja lazo personalizable' }, conEmpaques), '');
});

test('el catálogo que ve la IA lleva el precio de "solo la vela" de cada modelo', () => {
  const prompt = buildSystemPrompt(catalogoSoloVela, undefined, conSoloVela);
  assert.ok(prompt.includes('Vela con caja: $30.00 por docena · empaque: Caja lazo personalizable · solo la vela: $28.00'));
  assert.ok(prompt.includes('Vela en frasco: $45.00 por docena · empaque: Sin empaque · solo la vela: precio por confirmar'));
  assert.ok(/NO menciones ningún monto ni descuento/.test(prompt));
});

test('un precio por docena en una sola línea NO se borra como si fuera un total (causa de la respuesta vacía)', () => {
  const soloPrecio = 'Claro que sí 🤍 ¿Entonces la deseas solo la vela, sin empaque? Así te queda en $28.00 la docena.';
  const limpio = removeUnverifiedTotals(soloPrecio);
  assert.equal(limpio.removed, false);
  assert.equal(limpio.text, soloPrecio);
});

test('sigue quitando un total escrito en una frase corrida', () => {
  const limpio = removeUnverifiedTotals('Para 4 docenas en Guayaquil el total es $184.00');
  assert.equal(limpio.removed, true);
  assert.equal(limpio.text, '');
});

// ---------- Fotos del cliente: descripción detallada ----------

test('la petición a la IA de imágenes pide figura, colores, empaque, textos y no copiar datos personales', () => {
  const pedido = buildImagePrompt(conEmpaques);
  for (const etiqueta of ['Tipo:', 'Figura:', 'Colores:', 'Presentación:', 'Detalles:']) assert.ok(pedido.includes(etiqueta), etiqueta);
  assert.ok(/comprobante de pago/.test(pedido));
  assert.ok(/NO copies datos personales/.test(pedido));
  assert.ok(/no inventes lo que no se ve/.test(pedido));
  assert.ok(!/breve/i.test(pedido), 'ya no se pide una descripción breve');
});

test('las instrucciones del asistente le piden usar los detalles de la foto sin inventar y sin repetir nombres de ejemplo', () => {
  const prompt = buildSystemPrompt([{ name: 'Vela', price: 30, category: 'EVENTOS' }], undefined, conEmpaques);
  assert.ok(/FOTOS QUE ENVÍA EL CLIENTE/.test(prompt));
  assert.ok(/NUNCA inventes lo que no diga/.test(prompt));
  assert.ok(/ni pidas lo que ya se ve/.test(prompt));
  assert.ok(/son de EJEMPLO/.test(prompt));
  assert.ok(/coincide CLARAMENTE/.test(prompt));
});

test('el modelo para mirar fotos es aparte del de conversar y se puede cambiar por negocio', () => {
  assert.equal(getOpenAIVisionModel(conEmpaques), 'gpt-5.4');
  const propio = normalizeProfile({ ...PROFILE_PRESETS.eventos.profile, ai: { model: 'gpt-5.4-mini', visionModel: 'gpt-4.1' } });
  assert.equal(getOpenAIVisionModel(propio), 'gpt-4.1');
  assert.equal(getOpenAIModel(propio), 'gpt-5.4-mini');
});
