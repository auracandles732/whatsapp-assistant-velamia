/**
 * Pedidos a mano (10-oct-2026): Aura necesita crear, EDITAR y eliminar pedidos y cotizaciones con las modificaciones de
 * cada clienta (notas), y que el asistente sepa qué compró cada una. Ver docs/ARREGLOS.md.
 */
import './entorno';

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';
import { buildSale, quotationMessage } from '../src/services/manualSales';
import { describeOrder } from '../src/controllers/messageController';
import { normalizeProfile, VELAMIA_PROFILE } from '../src/config/businessProfile';

const perfil = normalizeProfile(VELAMIA_PROFILE, VELAMIA_PROFILE);

test('pedidos a mano: las notas y modificaciones de la clienta se guardan con el pedido y no van en el mensaje a la clienta', () => {
  const venta = buildSale({ items: [{ name: 'VELA BUBBLE', quantity: 3 }], note: 'Tarjetita con el diseño que envió la clienta' }, [{ name: 'VELA BUBBLE', price: 30, category: 'BAUTIZO' }], perfil);
  assert.deepEqual(venta.products.find(p => p.type === 'note'), { type: 'note', name: 'Notas', text: 'Tarjetita con el diseño que envió la clienta' });
  assert.ok(!quotationMessage(venta.products, venta.total, perfil).includes('Tarjetita'), 'las notas son solo para el equipo');
  assert.equal(buildSale({ items: [{ name: 'VELA BUBBLE', quantity: 3 }], note: '   ' }, [{ name: 'VELA BUBBLE', price: 30, category: 'BAUTIZO' }], perfil).products.some(p => p.type === 'note'), false);
});

test('pedidos a mano: el asistente sabe qué compró la clienta, con sus cambios y notas', () => {
  const texto = describeOrder({
    id: '5b7311cb-0000-4000-8000-000000000000', status: 'confirmed', total_amount: 31.5, delivery_date: '2026-10-17',
    products: [{ name: 'MINI BUBBLE PROMOCIÓN', price: 10.5, quantity: 3, personalization: 'bubble blancos' }, { type: 'delivery', name: 'Entrega', date: '2026-10-17' }, { type: 'note', name: 'Notas', text: 'tarjetita con osito' }]
  });
  assert.match(texto, /compró: 3 MINI BUBBLE PROMOCIÓN \(bubble blancos\)/);
  assert.match(texto, /notas: tarjetita con osito/);
});

test('pedidos a mano: se pueden crear, editar y eliminar pedidos y cotizaciones desde el CRM', () => {
  const server = readFileSync('src/index.ts', 'utf8');
  assert.ok(server.includes("app.post('/api/orders'"));
  assert.ok(server.includes("app.put('/api/orders/:id'"), 'falta editar pedidos');
  assert.ok(server.includes("app.delete('/api/orders/:id'"), 'falta eliminar pedidos');
  assert.ok(server.includes("app.post('/api/quotations'") && server.includes("app.put('/api/quotations/:id'"));
  const html = readFileSync('dashboard/index.html', 'utf8');
  assert.ok(html.includes("onClick={() => setComposer({ mode: 'edit-order', order: o })}>✏️ Editar</button>"), 'botón Editar en pedidos');
  assert.ok(html.includes("onClick={() => removeOrder(o, customer)}>🗑️ Eliminar</button>"), 'botón Eliminar en pedidos');
  assert.ok(html.includes("await api('/api/orders/' + order.id, { method: 'PUT', body: JSON.stringify(body) });"));
  assert.ok(html.includes('<span className="l">Notas y modificaciones (opcional)</span>'), 'campo de notas en el formulario');
  assert.ok(html.includes("item.type === 'note' ? ("), 'las notas se ven en pedidos y cotizaciones');
  assert.ok(html.includes("{activeTab === 'pedidos' && canEdit && <button type=\"button\" className=\"nx-hero-btn\" onClick={() => setComposer({ mode: 'order' })}>"), 'botón Crear pedido');
  assert.ok(html.includes("{activeTab === 'cotizaciones' && canEdit && <button type=\"button\" className=\"nx-hero-btn\" onClick={() => setComposer({ mode: 'quote' })}>"), 'botón Nueva cotización');
});
