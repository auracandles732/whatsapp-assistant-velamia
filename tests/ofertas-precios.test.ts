/**
 * Ofertas de la página web y precios especiales (10-oct-2026): la Dra. Sadys llegó por la oferta de $19.99 del Osito en
 * Nube y el asistente le dijo $30 y que la oferta era de otro producto; Aura cerró ventas con precios especiales que el
 * CRM no dejaba poner. Ver docs/ARREGLOS.md.
 */
import './entorno';

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';
import { offersFromSite, offersByProduct, withOffers } from '../src/services/webOffers';
import { buildSystemPrompt } from '../src/services/openai';
import { buildSale } from '../src/services/manualSales';
import { normalizeProfile, VELAMIA_PROFILE } from '../src/config/businessProfile';

const perfil = normalizeProfile(VELAMIA_PROFILE, VELAMIA_PROFILE);

const sitio = {
  productos: [
    { producto: { id: 1, pid: 74, name: 'Osito en Nube', price: 30, onSale: true, salePrice: 19.99, originalPrice: 30, saleText: 'Promocion por tiempo limitado' } },
    { producto: { id: 2, pid: 75, name: 'Osito en Base con Corazón', price: 30 } },
    { producto: { id: 3, pid: 76, name: 'Oculto en oferta', price: 30, onSale: true, salePrice: 19.99, originalPrice: 30, oculto: true } },
    { producto: { id: 62, pid: 63, name: 'Osito Promoción 2X1', price: 19.99, oferta: true } }
  ]
};

test('ofertas web: se leen de la página web y se unen al producto del CRM por su número del panel', () => {
  const byPid = offersFromSite(sitio);
  assert.deepEqual([...byPid.keys()], [74], 'solo cuenta lo que está en oferta, visible y más barato que su precio normal');
  assert.deepEqual(byPid.get(74), { price: 19.99, regular: 30, text: 'Promocion por tiempo limitado' });
  const offers = offersByProduct([{ id: 'a', name: 'VELA OSITO EN NUBE', web: { id: 74 } }, { id: 'b', name: 'OTRO', web: { id: 75 } }], byPid);
  assert.deepEqual(Object.keys(offers), ['a']);
  const [enOferta, normal] = withOffers([{ id: 'a', name: 'VELA OSITO EN NUBE', price: 30 }, { id: 'b', name: 'OTRO', price: 30 }], offers);
  assert.equal(enOferta.price, 19.99);
  assert.equal(enOferta.regular_price, 30);
  assert.equal(normal.price, 30);
  assert.equal(normal.regular_price, undefined);
});

test('ofertas web: el asistente cotiza con el precio de oferta a cualquier cliente y nunca dice que es de otro producto', () => {
  const prompt = buildSystemPrompt([{ name: 'VELA OSITO EN NUBE', price: 19.99, regular_price: 30, offer_text: 'Promocion por tiempo limitado', category: 'BABY SHOWER' }], undefined, perfil);
  assert.ok(prompt.includes('VELA OSITO EN NUBE: $19.99'), 'el precio del catálogo del asistente es el de oferta');
  assert.ok(prompt.includes('OFERTA de la página web (Promocion por tiempo limitado), precio normal $30.00'));
  assert.ok(prompt.includes('Cotiza y cobra siempre con el precio de oferta'));
  assert.ok(prompt.includes('nunca digas que la oferta es de otro producto'));
  const controller = readFileSync('src/controllers/messageController.ts', 'utf8');
  assert.match(controller, /Promise\.all\(\[\s*getSellingCatalog\(\),/, 'el asistente vende con el catálogo con ofertas');
  assert.ok(controller.includes('🔥 *Oferta* (antes ~$'), 'la foto muestra el precio de oferta y el normal tachado');
  const server = readFileSync('src/index.ts', 'utf8');
  assert.equal(server.split('buildSale(req.body || {}, await getAllProducts())').length, 1, 'pedidos y cotizaciones también usan las ofertas');
  assert.ok(server.includes('startWebOffers();'));
});

test('precios especiales: por producto o total acordado; la web nunca recibe el precio de oferta', () => {
  const catalogo = [{ name: 'VELA OSITO EN NUBE', price: 30, category: 'BABY SHOWER', description: 'Caja lazo personalizable' }];
  const especial = buildSale({ items: [{ name: 'VELA OSITO EN NUBE', quantity: 2, specialPrice: 19.99 }], place: 'Quito, Pichincha' }, catalogo, perfil);
  const item = especial.products.find(p => !p.type);
  assert.equal(item.price, 19.99);
  assert.equal(item.list_price, 30);
  assert.equal(item.special_price, true);
  const envio = especial.products.find(p => p.type === 'shipping');
  assert.equal(especial.total, Math.round((2 * 19.99 + envio.price) * 100) / 100);

  const acordado = buildSale({ items: [{ name: 'VELA OSITO EN NUBE', quantity: 3 }], agreedTotal: 110 }, catalogo, perfil);
  assert.equal(acordado.total, 110);
  assert.deepEqual(acordado.products.find(p => p.type === 'agreed_total'), { type: 'agreed_total', name: 'Total acordado', price: 110, computed: 90 });

  const html = readFileSync('dashboard/index.html', 'utf8');
  assert.ok(html.includes("placeholder={'Precio especial por '"), 'el pedido deja poner precio especial');
  assert.ok(html.includes('<span className="l">Total acordado (opcional)</span>'));
  assert.ok(html.includes("api('/api/products/selling-prices')"), 'el pedido muestra el precio de oferta de la web');
  assert.ok(!readFileSync('src/services/webCatalog.ts', 'utf8').includes('getSellingCatalog'), 'a la web se manda el precio normal, nunca el de oferta');
});
