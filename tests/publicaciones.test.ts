/**
 * Publicaciones en redes: calendario, qué productos salen, texto de respaldo, fotos para Instagram y el envío a Meta
 * (con Meta simulado: estas pruebas nunca publican nada de verdad).
 */
import './entorno';

import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import axios from 'axios';
import { PNG } from 'pngjs';
import jpeg from 'jpeg-js';

// Meta simulado: se instala antes de cargar los módulos que crean su cliente HTTP.
const calls: { method: string; url: string; body?: any }[] = [];
let counter = 0;
const fakeGraph = {
  get: async (url: string, config: any) => {
    calls.push({ method: 'GET', url });
    if (config?.params?.fields === 'status_code') return { data: { status_code: 'FINISHED' } };
    if (config?.params?.fields === 'permalink') return { data: { permalink: 'https://www.instagram.com/p/prueba/' } };
    return { data: {} };
  },
  post: async (url: string, body: any) => {
    calls.push({ method: 'POST', url, body });
    if (url.endsWith('/media')) return { data: { id: `contenedor${++counter}` } };
    if (url.endsWith('/media_publish')) return { data: { id: 'ig_publicado' } };
    if (url.endsWith('/photos')) return { data: body.published === false ? { id: `foto${++counter}` } : { id: 'foto', post_id: 'pagina_1' } };
    if (url.endsWith('/feed')) return { data: { id: 'pagina_2' } };
    return { data: {} };
  }
};
mock.method(axios, 'create', () => fakeGraph);

const socialPosts = require('../src/services/socialPosts') as typeof import('../src/services/socialPosts');
const socialImages = require('../src/services/socialImages') as typeof import('../src/services/socialImages');
const metaChannels = require('../src/services/metaChannels') as typeof import('../src/services/metaChannels');
const publisher = require('../src/services/socialPublisher') as typeof import('../src/services/socialPublisher');
const { normalizeProfile, VELAMIA_PROFILE } = require('../src/config/businessProfile') as typeof import('../src/config/businessProfile');

const TZ = 'America/Guayaquil';

test('la configuración se limpia: días, hora, redes y fotos por publicación válidos', () => {
  const s = socialPosts.normalizeSettings({ days: [5, 1, 9, 1, 'x'], hour: '25:00', channels: ['facebook', 'tiktok'], photosPerPost: 30, notes: '  tono cálido  ' });
  assert.deepEqual(s.days, [1, 5]);
  assert.equal(s.hour, '19:00');
  assert.deepEqual(s.channels, ['facebook']);
  assert.equal(s.photosPerPost, 10);
  assert.equal(s.notes, 'tono cálido');
  assert.equal(s.autoApprove, false, 'por defecto todo pasa por aprobación');
});

test('el calendario usa la hora del negocio y deja margen para revisar', () => {
  const settings = socialPosts.normalizeSettings({ days: [1, 3, 5], hour: '19:00' });
  // Lunes 21-sep-2026, 10:00 en Guayaquil (15:00 UTC).
  const slots = socialPosts.publishingSlots(settings, new Date('2026-09-21T15:00:00Z'), 7, TZ);
  assert.deepEqual(slots.map(s => s.toISOString()), ['2026-09-22T00:00:00.000Z', '2026-09-24T00:00:00.000Z', '2026-09-26T00:00:00.000Z']);
  // A las 18:30 del lunes ya no alcanza para el lunes: empieza el miércoles.
  const late = socialPosts.publishingSlots(settings, new Date('2026-09-21T23:30:00Z'), 7, TZ);
  assert.equal(late[0].toISOString(), '2026-09-24T00:00:00.000Z');
});

const catalogo = [
  { name: 'OSITO NUBE', category: 'BABY SHOWER', price: 30, image_url: 'https://x/1.png' },
  { name: 'OSITO MIEL', category: 'BABY SHOWER', price: 28, image_url: 'https://x/2.png' },
  { name: 'ARBOLITO', category: 'NAVIDAD', price: 25, image_url: 'https://x/3.png' },
  { name: 'ESTRELLA', category: 'NAVIDAD', price: 26, image_url: 'https://x/4.png' },
  { name: 'CRUZ', category: 'BAUTIZO', price: 27, image_url: 'https://x/5.png' },
  { name: 'SIN FOTO', category: 'BAUTIZO', price: 20, image_url: null }
];

test('elige productos con foto, sin repetir, variando la categoría y con la temporada primero', () => {
  const picks = socialPosts.pickProducts(catalogo, [], 3, 1, 11);
  assert.equal(picks[0].theme, 'Navidad', 'en noviembre sale primero Navidad');
  const names = picks.flatMap(p => p.products.map(x => x.name));
  assert.equal(new Set(names).size, names.length, 'sin repetir');
  assert.ok(!names.includes('SIN FOTO'));
  assert.notEqual(picks[0].theme, picks[1].theme, 'no dos seguidas de la misma categoría');
});

test('fuera de temporada todas las categorías salen antes de repetir una', () => {
  const picks = socialPosts.pickProducts(catalogo, [], 3, 1, 3);
  assert.equal(new Set(picks.map(p => p.theme)).size, 3);
});

test('en temporada, la categoría de la fecha sale una publicación sí y otra no', () => {
  const picks = socialPosts.pickProducts(catalogo, [], 3, 1, 12);
  assert.deepEqual(picks.map(p => p.theme === 'Navidad'), [true, false, true]);
});

test('lo que se publicó hace poco espera su turno y el carrusel junta fotos de la misma categoría', () => {
  const picks = socialPosts.pickProducts(catalogo, ['OSITO NUBE'], 1, 2, 3);
  const baby = socialPosts.pickProducts(catalogo.filter(c => c.category === 'BABY SHOWER'), ['OSITO NUBE'], 1, 1, 3);
  assert.equal(baby[0].products[0].name, 'OSITO MIEL');
  assert.equal(picks[0].products.length, 2);
  assert.equal(new Set(picks[0].products.map(p => p.category)).size, 1);
});

test('el texto de respaldo lleva el precio exacto, cómo pedir y hashtags', () => {
  const p = normalizeProfile(VELAMIA_PROFILE, VELAMIA_PROFILE);
  const text = socialPosts.fallbackCaption({ theme: 'Baby shower', products: [{ name: 'OSITO NUBE', price: 30 }] }, p);
  assert.match(text, /\$30\.00 la docena/);
  assert.match(text, /WhatsApp/);
  assert.match(text, /#velamia/);
});

function pngDe(width: number, height: number, rgba: [number, number, number, number]) {
  const png = new PNG({ width, height });
  for (let i = 0; i < width * height; i++) png.data.set(rgba, i * 4);
  return PNG.sync.write(png);
}

test('una foto PNG muy vertical se pasa a JPG 4:5 con margen blanco y la transparencia en blanco', () => {
  const jpg = socialImages.toInstagramJpeg(pngDe(300, 400, [255, 0, 0, 0]));
  const img = jpeg.decode(jpg, { useTArray: true });
  assert.equal(img.height, 400);
  assert.equal(img.width, 320, '300x400 (0.75) pasa a 320x400 (4:5)');
  assert.ok(img.data[0] > 240 && img.data[1] > 240 && img.data[2] > 240, 'lo transparente queda blanco');
  assert.deepEqual(socialImages.targetSize(1254, 1254), { canvasW: 1254, canvasH: 1254, scale: 1 });
  assert.equal(socialImages.targetSize(2000, 2000).canvasW, 1440);
});

test('solo se descargan fotos del almacenamiento propio', () => {
  assert.equal(socialImages.isOwnStorageUrl('http://localhost:54321/storage/v1/object/public/product-images/a.png'), true);
  assert.equal(socialImages.isOwnStorageUrl('https://otro.com/storage/v1/object/public/a.png'), false);
  assert.equal(socialImages.isOwnStorageUrl('http://localhost:54321/rest/v1/products'), false);
});

test('el enlace para conectar Facebook recuerda de qué empresa es', () => {
  const now = Date.now();
  const id = '11111111-2222-3333-4444-555555555555';
  assert.equal(metaChannels.readConnectState(metaChannels.createConnectState(now, id), now), id);
  assert.equal(metaChannels.readConnectState(metaChannels.createConnectState(now), now), 'velamia');
});

// ---------- Envío a Meta ----------

const conexion = { pageId: 'pagina', pageName: 'VELAMIA', pageToken: 'token', instagramId: 'ig', instagramUsername: 'velamia.ec' };
const post = (products: number, channels: any[]): any => ({
  id: 'p1', scheduled_at: new Date().toISOString(), status: 'approved', channels, caption: 'Texto de prueba', theme: 'Baby shower',
  products: catalogo.slice(0, products).map(c => ({ name: c.name, image_url: c.image_url, price: c.price })), results: {}, error: null, published_at: null
});

const listo = { waitMs: 0, prepareImage: async (url: string) => `${url}.jpg` };
const publicar = (scopes: string[], p: any) => {
  calls.length = 0;
  return publisher.publishToChannels(conexion, scopes, p, listo);
};

test('una foto: publica en Instagram (con el JPG) y en Facebook (con la foto original)', async () => {
  const r = await publicar(['instagram_content_publish', 'pages_manage_posts'], post(1, ['instagram_feed', 'facebook']));
  assert.equal(r.status, 'published');
  assert.equal(r.results.instagram_feed.permalink, 'https://www.instagram.com/p/prueba/');
  assert.equal(r.results.facebook.id, 'pagina_1');
  const media = calls.find(c => c.url.endsWith('/ig/media'))!;
  assert.equal(media.body.image_url, 'https://x/1.png.jpg');
  assert.equal(media.body.caption, 'Texto de prueba');
  assert.equal(calls.find(c => c.url.endsWith('/pagina/photos'))!.body.url, 'https://x/1.png');
});

test('varias fotos: carrusel en Instagram y publicación con varias fotos en Facebook', async () => {
  const r = await publicar(['instagram_content_publish', 'pages_manage_posts'], post(3, ['instagram_feed', 'facebook']));
  assert.equal(r.status, 'published');
  const items = calls.filter(c => c.url.endsWith('/ig/media') && c.body.is_carousel_item);
  assert.equal(items.length, 3);
  const carrusel = calls.find(c => c.url.endsWith('/ig/media') && c.body.media_type === 'CAROUSEL')!;
  assert.equal(carrusel.body.children.split(',').length, 3);
  const feed = calls.find(c => c.url.endsWith('/pagina/feed'))!;
  assert.equal(feed.body.attached_media.length, 3);
});

test('la historia de Instagram va con la primera foto', async () => {
  const r = await publicar(['instagram_content_publish'], post(2, ['instagram_story']));
  assert.equal(r.status, 'published');
  const media = calls.filter(c => c.url.endsWith('/ig/media'));
  assert.equal(media.length, 1);
  assert.equal(media[0].body.media_type, 'STORIES');
});

test('si falta el permiso de Facebook, Instagram igual sale y queda parcial con el motivo', async () => {
  const r = await publicar(['instagram_content_publish'], post(1, ['instagram_feed', 'facebook']));
  assert.equal(r.status, 'partial');
  assert.match(r.results.facebook.error!, /pages_manage_posts/);
  assert.ok(!calls.some(c => c.url.includes('/pagina/')), 'no intenta publicar en Facebook sin permiso');
});

test('sin conexión no publica y lo dice claro', async () => {
  calls.length = 0;
  const r = await publisher.publishNow(post(1, ['instagram_feed']));
  assert.equal(r.status, 'failed');
  assert.match(r.error!, /no están conectados/);
  assert.equal(calls.length, 0);
});
