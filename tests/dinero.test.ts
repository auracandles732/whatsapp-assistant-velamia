/**
 * Pruebas de la matemática del dinero: totales, cajas, envíos y costo de la IA.
 * Son las cuentas que ve el cliente en WhatsApp, así que un error aquí se cobra mal.
 * Se ejecutan con `npm test`, sin tocar la base de datos ni internet.
 */
import './entorno';

import test from 'node:test';
import assert from 'node:assert/strict';

import { computeOrderTotal, normalizeQuantities } from '../src/services/openai';
import { shippingCost } from '../src/services/shippingRates';
import { costOf, priceOf } from '../src/services/aiPrices';
import { normalizeProfile, PROFILE_PRESETS } from '../src/config/businessProfile';

// ---------- Perfiles de prueba ----------

/** Tienda que vende por caja y por tubo, como MegaMundo: tarifa única y recargo por pasar de una caja. */
const tienda = normalizeProfile({
  ...PROFILE_PRESETS.tienda.profile,
  business: { ...PROFILE_PRESETS.tienda.profile.business, name: 'Tienda de prueba', city: 'Guayaquil' },
  payments: { transferEnabled: true, cardEnabled: false, depositPercent: 70, cardBrands: '' },
  shipping: {
    ...PROFILE_PRESETS.tienda.profile.shipping,
    mode: 'flat', flatRate: 15, extraCost: 10, unitsIncludedInRate: 1, pickupAvailable: false
  }
});

/** Negocio que vende por docena, como VELAMIA: tarifas por provincia. */
const docenas = normalizeProfile({
  ...PROFILE_PRESETS.eventos.profile,
  payments: { transferEnabled: true, cardEnabled: false, depositPercent: 50, cardBrands: '' },
  shipping: {
    ...PROFILE_PRESETS.eventos.profile.shipping,
    mode: 'ecuador_table', unitsIncludedInRate: 3, extraCost: 1, pickupAvailable: false
  }
});

const catalogo = [
  { name: 'Wall Panel WPC Miel Oscuro', price: 75, category: 'WALL PANEL', sale_unit: 'caja de 10', measure: '2,95 m x 0,17 m', pieces_per_unit: 10 },
  { name: 'Clavo Líquido 300ml', price: 7, category: 'ADHESIVO', sale_unit: 'tubo', measure: '300 ml', pieces_per_unit: null }
];

const catalogoDocenas = [{ name: 'Vela Corazón', price: 24, category: 'ROMÁNTICAS' }];

// ---------- Cantidades: piezas sueltas vs unidad de venta ----------

test('18 paneles se cobran como 2 cajas, no como 18 cajas', () => {
  const items = normalizeQuantities(
    [{ name: 'Wall Panel WPC Miel Oscuro', quantity: 18, quantity_in_pieces: true }],
    'la pared mide 3 x 2', tienda, catalogo
  );
  assert.equal(items[0].quantity, 2);
});

test('si ya vienen en cajas, la cantidad no se toca', () => {
  const items = normalizeQuantities(
    [{ name: 'Wall Panel WPC Miel Oscuro', quantity: 2, quantity_in_pieces: false }],
    'quiero 2 cajas', tienda, catalogo
  );
  assert.equal(items[0].quantity, 2);
});

test('los tubos se venden de a uno: 6 tubos siguen siendo 6', () => {
  const items = normalizeQuantities(
    [{ name: 'Clavo Líquido 300ml', quantity: 6, quantity_in_pieces: true }],
    'necesito 6 tubos', tienda, catalogo
  );
  assert.equal(items[0].quantity, 6);
});

test('un pedido de 48 velas son 4 docenas', () => {
  const items = normalizeQuantities(
    [{ name: 'Vela Corazón', quantity: 48 }], 'quiero 48 velas', docenas, catalogoDocenas
  );
  assert.equal(items[0].quantity, 4);
});

test('quien pide 4 docenas no termina con 4 velas', () => {
  const items = normalizeQuantities(
    [{ name: 'Vela Corazón', quantity: 4 }], 'quiero 4 docenas', docenas, catalogoDocenas
  );
  assert.equal(items[0].quantity, 4);
});

// ---------- Envíos ----------

test('tarifa única: una caja paga $15 y más de una paga el recargo', () => {
  assert.equal(shippingCost('Quito', 1, tienda)!.cost, 15);
  assert.equal(shippingCost('Quito', 2, tienda)!.cost, 25);
});

test('sin ciudad no hay envío que calcular', () => {
  assert.equal(shippingCost('', 2, tienda), null);
});

test('una ciudad que no está en la tabla de Ecuador no inventa tarifa', () => {
  assert.equal(shippingCost('Madrid', 1, docenas), null);
});

test('la tabla de Ecuador cobra distinto según la provincia', () => {
  const guayaquil = shippingCost('Guayaquil, Guayas', 1, docenas);
  const quito = shippingCost('Quito, Pichincha', 1, docenas);
  assert.ok(guayaquil && quito);
  assert.ok(guayaquil!.cost > 0 && quito!.cost > 0);
  assert.notEqual(guayaquil!.cost, quito!.cost);
});

// ---------- Totales del pedido ----------

test('2 cajas y 6 tubos a Quito suman $217 con $151,90 de anticipo', () => {
  const order = computeOrderTotal(
    [{ name: 'Wall Panel WPC Miel Oscuro', quantity: 2 }, { name: 'Clavo Líquido 300ml', quantity: 6 }],
    'Quito', catalogo, tienda
  );
  assert.equal(order.subtotal, 192);
  assert.equal(order.shipping!.cost, 25);
  assert.equal(order.total, 217);
  assert.equal(order.deposit, 151.9);
});

test('sin ciudad no se da un total', () => {
  const order = computeOrderTotal([{ name: 'Clavo Líquido 300ml', quantity: 1 }], '', catalogo, tienda);
  assert.equal(order.missing, 'place');
  assert.equal(order.total, 0);
});

test('un producto que no está en el catálogo no entra en el total', () => {
  const order = computeOrderTotal(
    [{ name: 'Piso flotante', quantity: 3 }], 'Quito', catalogo, tienda
  );
  assert.equal(order.missing, 'items');
  assert.equal(order.total, 0);
});

test('el anticipo sale del porcentaje configurado', () => {
  const order = computeOrderTotal([{ name: 'Vela Corazón', quantity: 2 }], 'Guayaquil, Guayas', catalogoDocenas, docenas);
  assert.equal(order.subtotal, 48);
  assert.equal(order.deposit, order.total / 2);
});

// ---------- Costo de la IA ----------

test('una respuesta con casi todo en caché cuesta centavos', () => {
  const cost = costOf({ model: 'gpt-5.4-mini', input_tokens: 4443, cached_tokens: 3840, output_tokens: 190 });
  assert.equal(cost.toFixed(6), '0.001595');
});

test('sin caché, la misma respuesta cuesta el triple', () => {
  const conCache = costOf({ model: 'gpt-5.4-mini', input_tokens: 4443, cached_tokens: 3840, output_tokens: 190 });
  const sinCache = costOf({ model: 'gpt-5.4-mini', input_tokens: 4443, cached_tokens: 0, output_tokens: 190 });
  assert.ok(sinCache > conCache * 2.5);
});

test('un modelo desconocido no rompe el cálculo', () => {
  assert.deepEqual(priceOf('modelo-inventado'), priceOf('gpt-5.4-mini'));
  assert.ok(costOf({ model: undefined, input_tokens: 1000, output_tokens: 10 }) > 0);
});
