/**
 * Catálogo de la página web: el CRM manda (precio y foto), cada producto tiene su versión para la web y las diferencias de
 * precio se revisan antes de activar.
 */
import './entorno';

import test from 'node:test';
import assert from 'node:assert/strict';
import { titleCase, slugOf, slugMapFrom, toWebProduct, priceConflict, normalizeWebUrl, webDisplayName, webNameFollowsCrm, callWeb, webRetry } from '../src/services/webCatalog';

const web = (over: any = {}) => ({ id: 12, visible: true, name: 'Leon Baby Shower Cajita', description: 'Con cajita y lazo', category: 'baby-shower', images: ['https://web/leon.webp'], baseImage: 'https://crm/leon.jpeg', price: 30, priceOk: true, ...over });

test('el nombre del CRM se ve bien en la web y la categoría sale de la que ya usan sus productos', () => {
  assert.equal(titleCase('VELA DE ANGELITO REZANDO CON ROSARIO'), 'Vela de Angelito Rezando con Rosario');
  const slugs = slugMapFrom([{ category: 'QUINCEAÑERA', web: web({ category: 'xv-anos' }) as any }, { category: 'QUINCEAÑERA', web: web({ category: 'xv-anos' }) as any }, { category: 'BABY SHOWER', web: web() as any }]);
  assert.equal(slugOf('QUINCEAÑERA', slugs), 'xv-anos');
  assert.equal(slugOf('Día de la Madre'), 'dia-de-la-madre');
  assert.equal(slugOf('HALLOWEEN', slugs), 'halloween');
});

test('a la web va el precio del CRM; las fotos de la web se quedan hasta que cambie la foto del CRM', () => {
  const p = { id: '9a06d362-a251-4bc0-9dc9-a08f0d45e585', name: 'VELA DE LEONCITO', price: 32, category: 'BABY SHOWER', image_url: 'https://crm/leon.jpeg', sale_unit: null, web: web() };
  const out = toWebProduct(p, new Map());
  assert.deepEqual(out, { crm_id: p.id, id: 12, nombre: 'Leon Baby Shower Cajita', descripcion: 'Con cajita y lazo', precio: 32, categoria: 'baby-shower', unidad: 'docena', imagenes: ['https://web/leon.webp'], oculto: false });
  assert.deepEqual(toWebProduct({ ...p, image_url: 'https://crm/leon-nueva.jpeg' }, new Map()).imagenes, ['https://crm/leon-nueva.jpeg'], 'cambió la foto en el CRM');
  const nuevo = toWebProduct({ ...p, web: { id: null, visible: false, name: '', description: '', category: '', images: [], baseImage: '', price: null, priceOk: true }, sale_unit: 'unidad' }, new Map([['baby shower', 'baby-shower']]));
  assert.equal(nuevo.nombre, 'Vela de Leoncito');
  assert.equal(nuevo.id, null);
  assert.equal(nuevo.unidad, 'unidad');
  assert.equal(nuevo.oculto, true);
  assert.deepEqual(nuevo.imagenes, ['https://crm/leon.jpeg']);
});

test('un precio distinto queda por revisar hasta que se elige cuál vale', () => {
  assert.equal(priceConflict({ price: 35, web: web({ price: 32, priceOk: false }) }), true);
  assert.equal(priceConflict({ price: 35, web: web({ price: 32, priceOk: true }) }), false);
  assert.equal(priceConflict({ price: 30, web: web({ price: 30, priceOk: false }) }), false);
  assert.equal(priceConflict({ price: 30, web: null }), false);
});

test('la web se conecta solo con https', () => {
  assert.equal(normalizeWebUrl('https://velamia-admin-cms.onrender.com/'), 'https://velamia-admin-cms.onrender.com');
  assert.equal(normalizeWebUrl('http://otra.com'), '');
  assert.equal(normalizeWebUrl('panel'), '');
  assert.equal(normalizeWebUrl('http://localhost:3005'), 'http://localhost:3005');
});

test('el nombre de la web: escrito todo en mayúsculas se ve como el resto de la tienda; si era copia del CRM, sigue al nombre nuevo', () => {
  assert.equal(webDisplayName({ name: 'VELA LOLA BUNNY', web: { name: 'VELA LOLA BUNNY' } }), 'Vela Lola Bunny');
  assert.equal(webDisplayName({ name: 'OSITO PROMOCIÓN 2X1', web: { name: '' } }), 'Osito Promoción 2X1');
  assert.equal(webDisplayName({ name: 'VELA COPA XV FLORAL', web: null }), 'Vela Copa XV Floral');
  assert.equal(webDisplayName({ name: 'VELA BUBBLE', web: { name: 'Paloma en Cajita Mi Bautismo' } }), 'Paloma en Cajita Mi Bautismo', 'un nombre propio de la web no se toca');
  assert.equal(webNameFollowsCrm({ name: 'Demonio de Tasmania en Frasco' }, 'DEMONIO DE TASMANIA EN FRASCO'), true);
  assert.equal(webNameFollowsCrm({ name: 'Leon Baby Shower Cajita' }, 'VELA DE LEONCITO'), false);
  assert.equal(webNameFollowsCrm({ name: '' }, 'VELA DE LEONCITO'), false);
});

test('si la web está despertando (502 de Render) se espera y se repite; un error del panel no se repite', async () => {
  const original = globalThis.fetch;
  const waits = webRetry.waitsMs;
  webRetry.waitsMs = [1, 1];
  const s = { url: 'https://panel.test', key: 'llave', enabled: true, lastSyncAt: '', lastError: '', lastCount: 0 };
  try {
    let calls = 0;
    globalThis.fetch = (async () => (++calls < 3 ? new Response('<html>Bad Gateway</html>', { status: 502 }) : Response.json({ ok: true, ids: {} }))) as any;
    assert.deepEqual(await callWeb(s, 'PUT', { productos: [] }), { ok: true, ids: {} });
    assert.equal(calls, 3);
    calls = 0;
    globalThis.fetch = (async () => { calls++; return new Response('Bad Gateway', { status: 502 }); }) as any;
    await assert.rejects(callWeb(s, 'PUT', { productos: [] }), /La web respondió 502/);
    assert.equal(calls, 3, 'tres intentos y se rinde');
    calls = 0;
    globalThis.fetch = (async () => { calls++; return Response.json({ error: 'La sincronización con el CRM no está configurada' }, { status: 503 }); }) as any;
    await assert.rejects(callWeb(s, 'GET'), /CRM_SYNC_KEY/);
    assert.equal(calls, 1);
  } finally {
    globalThis.fetch = original;
    webRetry.waitsMs = waits;
  }
});
