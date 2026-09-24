/**
 * Cotizaciones y pedidos hechos a mano desde el CRM: se calculan igual que los del asistente
 * y el mensaje a la clienta da un solo valor, como lo hace el bot.
 */
import './entorno';

import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSale, quotationMessage } from '../src/services/manualSales';
import { normalizeProfile, VELAMIA_PROFILE } from '../src/config/businessProfile';

const perfil = normalizeProfile(VELAMIA_PROFILE, VELAMIA_PROFILE);
const catalogo = [
  { name: 'OSITO EN NUBE', price: 30, category: 'BABY SHOWER', description: 'Caja lazo personalizable' },
  { name: 'VELA ANGELITO', price: 28, category: 'BAUTIZO', description: 'Acetato' }
];

test('arma la cotización con precios del catálogo, envío del tarifario y fecha de entrega', () => {
  const venta = buildSale({ items: [{ name: 'osito en nube', quantity: 5 }, { name: 'VELA ANGELITO', quantity: 2 }], place: 'Quito, Pichincha', deliveryDate: '2026-11-12' }, catalogo, perfil);
  const productos = venta.products.filter(p => !p.type);
  assert.equal(productos.length, 2);
  assert.equal(productos[0].name, 'OSITO EN NUBE');
  const envio = venta.products.find(p => p.type === 'shipping');
  assert.ok(envio && envio.price > 0);
  assert.equal(venta.total, Math.round((5 * 30 + 2 * 28 + envio.price) * 100) / 100);
  assert.deepEqual(venta.products.find(p => p.type === 'delivery'), { type: 'delivery', name: 'Entrega', date: '2026-11-12' });
});

test('sin ciudad la cotización no suma envío (queda por cotizar)', () => {
  const venta = buildSale({ items: [{ name: 'VELA ANGELITO', quantity: 3 }] }, catalogo, perfil);
  assert.equal(venta.total, 84);
  assert.equal(venta.products.some(p => p.type === 'shipping'), false);
});

test('rechaza productos que no están en el catálogo y ciudades fuera del tarifario', () => {
  assert.throws(() => buildSale({ items: [{ name: 'DINOSAURIO', quantity: 2 }] }, catalogo, perfil), /Elige al menos un producto/);
  assert.throws(() => buildSale({ items: [{ name: 'VELA ANGELITO', quantity: 2 }], place: 'Narnia' }, catalogo, perfil), /no está en el tarifario/);
});

test('el mensaje a la clienta da un solo valor con el envío incluido, el anticipo y la pregunta de pago', () => {
  const venta = buildSale({ items: [{ name: 'OSITO EN NUBE', quantity: 5 }], place: 'Quito, Pichincha' }, catalogo, perfil);
  const texto = quotationMessage(venta.products, venta.total, perfil);
  assert.match(texto, /\*OSITO EN NUBE\* · 5 docenas/);
  assert.match(texto, new RegExp(`Total: \\$${venta.total.toFixed(2)}`));
  assert.match(texto, /Envío a .* incluido/);
  assert.match(texto, /Anticipo por transferencia \(50%\)/);
  assert.match(texto, /transferencia o con tarjeta\?/);
  assert.ok(!texto.includes('$30'), 'no lista el precio por docena');
});
