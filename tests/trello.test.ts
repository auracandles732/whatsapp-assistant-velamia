/**
 * Tablero de producción en Trello (10-oct-2026): el CRM crea la tarjeta del pedido con el mismo formato que usa Aura
 * (el inventario la lee), muestra el tablero con sus listas y mueve tarjetas; producción sigue recibiendo los correos
 * de Trello. Ver docs/ARREGLOS.md.
 */
import './entorno';

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';
import { cardFromOrder, statusForList } from '../src/services/trello';
import { describeOrder } from '../src/controllers/messageController';
import { normalizeProfile, VELAMIA_PROFILE } from '../src/config/businessProfile';

const perfil = normalizeProfile(VELAMIA_PROFILE, VELAMIA_PROFILE);

test('trello: la tarjeta lleva el formato de Aura (CANTIDAD-CLIENTA-FECHA) con instrucciones, fecha y fotos', () => {
  const card = cardFromOrder({
    id: '5ffd053b-0000-4000-8000-000000000000', customer_name: 'Dra. Sadys Rendón 👩🏻‍⚕️🎗️🩸', status: 'confirmed', total_amount: 45.98, delivery_date: '2026-10-19', customer_address: 'Quito, Pichincha',
    products: [
      { name: 'VELA OSITO EN NUBE', price: 19.99, quantity: 2, personalization: 'osito beige, lazo azul', packaging: 'Caja lazo personalizable' },
      { type: 'delivery', name: 'Entrega', date: '2026-10-19' },
      { type: 'note', name: 'Notas', text: 'nombre Cesar Alejandro', image: 'https://x.supabase.co/diseno.jpg' }
    ]
  }, [{ name: 'VELA OSITO EN NUBE', image_url: 'https://x.supabase.co/osito.png' }], perfil);
  assert.equal(card.name, '2 DOCENAS-DRA. SADYS RENDÓN-19 OCTUBRE');
  assert.match(card.desc, /^PRODUCTO: VELA OSITO EN NUBE · 2 DOCENAS$/m, 'el inventario lee "PRODUCTO:"');
  assert.match(card.desc, /PERSONALIZACIÓN: osito beige, lazo azul/);
  assert.match(card.desc, /NOTAS: nombre Cesar Alejandro/);
  assert.match(card.desc, /ENTREGA: 19\/10\/2026 · envío a Quito, Pichincha/);
  assert.match(card.desc, /TOTAL: \$45\.98 · PAGADO/);
  assert.equal(card.due, '2026-10-19T14:00:00.000Z');
  assert.deepEqual(card.images, ['https://x.supabase.co/diseno.jpg', 'https://x.supabase.co/osito.png']);
  const unidades = cardFromOrder({ id: 'x', customer_name: 'Ana', status: 'pending', total_amount: 110, products: [{ name: 'CRUZ', quantity: 40 / 12 }] }, [], perfil);
  assert.equal(unidades.name, '40 UNIDADES-ANA-SIN FECHA');
  assert.match(unidades.desc, /PENDIENTE DE PAGO/);
});

test('trello: mover a "Enviado" o "Entregado" cambia el estado del pedido; el asistente sabe la etapa', () => {
  assert.equal(statusForList('Enviado'), 'shipped');
  assert.equal(statusForList('ENTREGADO'), 'delivered');
  assert.equal(statusForList('EN PRODUCCIÓN'), null);
  assert.match(describeOrder({ id: 'abc', status: 'confirmed', total_amount: 10, stage: 'EN PRODUCCIÓN', products: [] }), /etapa de producción: EN PRODUCCIÓN/);
});

test('trello: el CRM muestra el tablero, envía pedidos a producción y mueve tarjetas', () => {
  const server = readFileSync('src/index.ts', 'utf8');
  assert.ok(server.includes('app.use(trelloRouter());') && server.includes('startTrelloSync();'));
  const routes = readFileSync('src/services/trelloRoutes.ts', 'utf8');
  for (const route of ["router.get('/api/trello/board'", "router.post('/api/trello/orders/:orderId'", "router.put('/api/trello/cards/:cardId'", "router.get('/api/trello/attachment/:cardId/:attachmentId'"]) assert.ok(routes.includes(route), route);
  const html = readFileSync('dashboard/index.html', 'utf8');
  assert.ok(html.includes('function TrelloBoard({ canEdit, onChanged })'));
  assert.ok(html.includes('🗂️ Tablero de producción</button>'));
  assert.ok(html.includes("'📤 Enviar a producción'"));
  assert.ok(readFileSync('src/services/trello.ts', 'utf8').includes("idMembers: s.memberIds.join(',')"), 'los miembros de producción reciben el correo de Trello');
});
