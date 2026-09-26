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
    if (url.endsWith('/videos')) return { data: { id: 'video_1' } };
    return { data: {} };
  }
};
mock.method(axios, 'create', () => fakeGraph);

const socialPosts = require('../src/social/posts') as typeof import('../src/social/posts');
const socialImages = require('../src/social/images') as typeof import('../src/social/images');
const metaChannels = require('../src/services/metaChannels') as typeof import('../src/services/metaChannels');
const publisher = require('../src/social/publisher') as typeof import('../src/social/publisher');
const { normalizeProfile, VELAMIA_PROFILE } = require('../src/config/businessProfile') as typeof import('../src/config/businessProfile');

const TZ = 'America/Guayaquil';

test('la configuración se limpia: días, hora, redes y fotos por publicación válidos', () => {
  const s = socialPosts.normalizeSettings({ days: [5, 1, 9, 1, 'x'], hour: '25:00', channels: ['facebook', 'tiktok'], photosPerPost: 30, notes: '  tono cálido  ' });
  assert.deepEqual(s.days, [1, 5]);
  assert.equal(s.hour, '19:00');
  assert.deepEqual(s.channels, ['facebook']);
  assert.equal(s.photosPerPost, 10);
  assert.equal(s.notes, 'tono cálido');
  assert.equal(s.autoApprove, true, 'lo programado sale sin aprobación');
  assert.equal(s.autoPlan, false, 'el modo automático con IA se enciende a propósito');
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

test('modo automático: los videos de la biblioteca de esos productos se suman al carrusel, sin pasar de 10', () => {
  const producto = (n: number) => ({ name: `VELA ${n}`, image_url: `https://x/vela${n}.png`, price: 35 });
  const biblioteca = [
    { id: 'f1', kind: 'image' as const, url: 'https://x/f1.jpg', product_name: 'vela 1', used_count: 3 },
    { id: 'v1', kind: 'video' as const, url: 'https://x/v1.mp4', product_name: 'VELA 1', used_count: 5 },
    { id: 'v2', kind: 'video' as const, url: 'https://x/v2.mp4', product_name: 'VELA 2', used_count: 0 },
    { id: 'otro', kind: 'video' as const, url: 'https://x/otro.mp4', product_name: 'OTRA COSA', used_count: 0 }
  ];
  const usados = new Set<string>();
  const uno = socialPosts.withLibraryMedia([producto(1), producto(2)], biblioteca, usados);
  // Cada foto del Catálogo seguida de lo suyo: primero el video.
  assert.deepEqual(uno.media.map(m => m.url), ['https://x/vela1.png', 'https://x/v1.mp4', 'https://x/f1.jpg', 'https://x/vela2.png', 'https://x/v2.mp4']);
  assert.equal(uno.media[1].type, 'video');
  assert.deepEqual([...usados].sort(), ['f1', 'v1', 'v2']);

  // En la misma tanda un archivo no se repite: la siguiente publicación va solo con fotos del Catálogo.
  const dos = socialPosts.withLibraryMedia([producto(1)], biblioteca, usados);
  assert.deepEqual(dos.media, []);

  // Diez productos con videos: se corta en 10 y lo que no entra tampoco se nombra en el texto.
  const muchos = Array.from({ length: 10 }, (_, i) => producto(i + 1));
  const conVideos = muchos.map((p, i) => ({ id: `v${i}`, kind: 'video' as const, url: `https://x/v${i}.mp4`, product_name: p.name }));
  const lleno = socialPosts.withLibraryMedia(muchos, conVideos, new Set());
  assert.equal(lleno.media.length, 10);
  assert.equal(lleno.products.length, 5);
});

test('varias publicaciones por día: la hora elegida y cada 3 horas antes; "la IA decide" es lo normal', () => {
  assert.deepEqual(socialPosts.dayHours('19:00', 3), ['13:00', '16:00', '19:00']);
  assert.deepEqual(socialPosts.dayHours('09:00', 2), ['08:00', '09:00']);
  const settings = socialPosts.normalizeSettings({ days: [1], hour: '19:00', postsPerDay: 2 });
  const slots = socialPosts.publishingSlots(settings, new Date('2026-09-21T15:00:00Z'), 7, TZ, settings.postsPerDay);
  assert.deepEqual(slots.map(s => s.toISOString()), ['2026-09-21T21:00:00.000Z', '2026-09-22T00:00:00.000Z']);
  assert.equal(socialPosts.normalizeSettings({}).postsPerDay, 0, 'por defecto decide la IA');
  assert.equal(socialPosts.normalizeSettings({ postsPerDay: 9 }).postsPerDay, 0);
});

test('las tandas del día llegan a la meta de fotos contando lo ya programado, sin chocar horas', () => {
  const settings = socialPosts.normalizeSettings({ days: [1, 2, 3, 4, 5, 6, 0], hour: '15:00', channels: ['instagram_story'], photosPerPost: 5, photosPerDay: 10 });
  const now = new Date('2026-09-21T12:00:00Z');
  // 22-sep: vacío → 2 tandas de 5 historias. 23-sep: ya tiene 4 fotos a las 12:00 → falta 6 (2 tandas de 3), sin chocar. 24-sep: ya tiene 10.
  const slots = socialPosts.daySlots(settings, ['2026-09-22', '2026-09-23', '2026-09-24'], [
    { day: '2026-09-23', minutes: 12 * 60, photos: 4 }, { day: '2026-09-24', minutes: 15 * 60, photos: 10 }
  ], now, TZ);
  assert.deepEqual(slots.map(s => [s.day, s.kind, s.count]), [['2026-09-22', 'story', 5], ['2026-09-22', 'story', 5], ['2026-09-23', 'story', 3], ['2026-09-23', 'story', 3]]);
  assert.equal(slots[0].at.toISOString(), '2026-09-22T17:00:00.000Z', '12:00 hora de Ecuador');
  assert.equal(slots[1].at.toISOString(), '2026-09-22T20:00:00.000Z', '15:00, la hora elegida');
  assert.equal(slots[2].at.toISOString(), '2026-09-23T18:00:00.000Z', 'a las 12:00 ya había algo: se corre a las 13:00');
  const ambos = socialPosts.normalizeSettings({ ...settings, channels: ['instagram_feed', 'instagram_story', 'facebook'] });
  assert.deepEqual(socialPosts.daySlots(ambos, ['2026-09-22'], [], now, TZ).map(s => s.kind), ['feed', 'story'], 'se turnan publicación e historias');
  assert.equal(socialPosts.normalizeSettings({}).photosPerDay, 10, 'por defecto, 10 fotos al día');
  assert.equal(socialPosts.normalizeSettings({ photosPerDay: 99 }).photosPerDay, socialPosts.MAX_PHOTOS_PER_DAY);
});

test('la IA solo elige la categoría de cada tanda: una categoría por tanda y productos reales del Catálogo', () => {
  const brain = require('../src/social/brain') as typeof import('../src/social/brain');
  const settings = socialPosts.normalizeSettings({ days: [2], hour: '19:00', channels: ['instagram_feed', 'instagram_story', 'facebook'], photosPerDay: 6, photosPerPost: 3 });
  const now = new Date('2026-09-21T15:00:00Z');
  const slots = socialPosts.daySlots(settings, ['2026-09-22'], [], now, TZ);
  const input = { slots, catalog: catalogo, recent: ['OSITO NUBE'], recentThemes: [], library: [], settings, month: 9, now, timeZone: TZ, profile: VELAMIA_PROFILE };
  const posts = brain.resolveAiPlan([
    { n: 1, categoria: 'baby shower', motivo: 'porque sí' },
    { n: 2, categoria: 'INVENTADA', motivo: 'no existe' }
  ], input);
  assert.equal(posts.length, 2);
  assert.deepEqual(posts[0].products.map(p => p.name), ['OSITO MIEL', 'OSITO NUBE'], 'primero lo que hace más tiempo no sale');
  assert.equal(posts[0].format, 'carrusel');
  assert.equal(posts[0].reason, 'porque sí');
  assert.equal(posts[1].format, 'historia');
  const cats = new Set(posts[1].products.map(p => p.category));
  assert.equal(cats.size, 1, 'nunca mezcla categorías en una tanda');
  assert.ok(!posts[1].products.some(p => p.category === 'BABY SHOWER'), 'no repite lo de la otra tanda');
});

test('con reglas también se llena cada tanda con una sola categoría', async () => {
  const brain = require('../src/social/brain') as typeof import('../src/social/brain');
  const settings = socialPosts.normalizeSettings({ days: [2], hour: '19:00', channels: ['instagram_story'], photosPerDay: 6, photosPerPost: 3 });
  const now = new Date('2026-09-21T15:00:00Z');
  const slots = socialPosts.daySlots(settings, ['2026-09-22'], [], now, TZ);
  const plan = await brain.ruleBrain.plan({ slots, catalog: catalogo, recent: [], recentThemes: [], library: [], settings, month: 9, now, timeZone: TZ, profile: VELAMIA_PROFILE });
  assert.equal(plan.posts.length, 2);
  for (const p of plan.posts) {
    assert.equal(p.format, 'historia');
    assert.equal(p.products.length, 2);
    assert.equal(new Set(p.products.map(x => x.category)).size, 1);
  }
  assert.match(plan.summary, /4 fotos/);
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

const color = (img: any, x: number, y: number) => Array.from(img.data.slice((y * img.width + x) * 4, (y * img.width + x) * 4 + 3)) as number[];

test('la publicación va en 4:5 con la foto completa dentro de lo que muestra la cuadrícula del perfil', () => {
  const img = jpeg.decode(socialImages.toInstagramJpeg(pngDe(300, 300, [255, 0, 0, 255])), { useTArray: true });
  assert.equal(img.width, 1080);
  assert.equal(img.height, 1350);
  assert.ok(color(img, 540, 675)[1] < 40, 'al centro va la foto');
  assert.ok(color(img, 45, 675)[1] < 40, 'la foto llega hasta el borde de lo visible en la cuadrícula (3:4)');
  assert.ok(color(img, 20, 675)[1] > 50, 'afuera va el fondo difuminado y aclarado, no la foto recortada');
  assert.ok(color(img, 540, 60)[1] > 50, 'arriba y abajo también es fondo');
});

test('la historia va en 9:16 con la foto completa al centro (Instagram ya no la acerca ni la recorta)', () => {
  const img = jpeg.decode(socialImages.toInstagramJpeg(pngDe(400, 500, [0, 0, 255, 255]), 'story'), { useTArray: true });
  assert.equal(img.width, 1080);
  assert.equal(img.height, 1920);
  assert.ok(color(img, 540, 960)[0] < 40, 'al centro va la foto');
  assert.ok(color(img, 540, 120)[0] > 50, 'arriba queda libre para el nombre de la cuenta');
  const clear = jpeg.decode(socialImages.toInstagramJpeg(pngDe(200, 200, [255, 0, 0, 0]), 'story'), { useTArray: true });
  assert.ok(color(clear, 540, 960).every(v => v > 240), 'lo transparente queda blanco');
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

test('historias: cada foto sale como una historia, en orden y en formato de historia (antes salía solo la primera)', async () => {
  const kinds: string[] = [];
  calls.length = 0;
  const r = await publisher.publishToChannels(conexion, ['instagram_content_publish'], post(3, ['instagram_story']), { waitMs: 0, prepareImage: async (url: string, kind: string) => { kinds.push(kind); return `${url}.${kind}.jpg`; } });
  assert.equal(r.status, 'published');
  const media = calls.filter(c => c.url.endsWith('/ig/media'));
  assert.equal(media.length, 3);
  assert.ok(media.every(m => m.body.media_type === 'STORIES'));
  assert.deepEqual(kinds, ['story', 'story', 'story']);
  assert.deepEqual(media.map(m => m.body.image_url), ['https://x/1.png.story.jpg', 'https://x/2.png.story.jpg', 'https://x/3.png.story.jpg']);
  assert.equal(calls.filter(c => c.url.endsWith('/media_publish')).length, 3);
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

test('un video de la biblioteca sale como reel en Instagram, como video en Facebook y en la historia', async () => {
  const conVideo = { ...post(1, ['instagram_feed', 'instagram_story', 'facebook']), media: [{ type: 'video', url: 'https://x/video.mp4', asset_id: 'a1' }] };
  const r = await publicar(['instagram_content_publish', 'pages_manage_posts'], conVideo);
  assert.equal(r.status, 'published');
  const media = calls.filter(c => c.url.endsWith('/ig/media'));
  assert.equal(media.find(c => c.body.media_type === 'REELS')!.body.video_url, 'https://x/video.mp4');
  assert.equal(media.find(c => c.body.media_type === 'STORIES')!.body.video_url, 'https://x/video.mp4');
  const fb = calls.find(c => c.url.endsWith('/pagina/videos'))!;
  assert.equal(fb.body.file_url, 'https://x/video.mp4');
  assert.ok(!calls.some(c => c.url.endsWith('/pagina/photos')), 'no publica las fotos de los productos si lleva video');
});

// ---------- Revisión 25-sep: Facebook con fotos y videos, y reintentar lo que faltó ----------

test('Facebook no mezcla fotos y videos: con fotos salen todas las fotos; solo videos, el primero', () => {
  const foto = (n: number) => ({ type: 'image' as const, url: `https://x/${n}.jpg` });
  const video = (n: number) => ({ type: 'video' as const, url: `https://x/${n}.mp4` });
  assert.deepEqual(publisher.facebookItems([video(1), foto(2), foto(3)]).map(i => i.url), ['https://x/2.jpg', 'https://x/3.jpg']);
  assert.deepEqual(publisher.facebookItems([video(1), video(2)]).map(i => i.url), ['https://x/1.mp4']);
  assert.deepEqual(publisher.facebookItems([foto(1)]).map(i => i.url), ['https://x/1.jpg']);
});

test('carrusel mezclado: Instagram lleva todo y Facebook las fotos (antes mandaba solo el video)', async () => {
  const mezcla = { ...post(0, ['instagram_feed', 'facebook']), media: [
    { type: 'video', url: 'https://x/v.mp4', asset_id: 'a1' }, { type: 'image', url: 'https://x/f1.png', asset_id: 'a2' }, { type: 'image', url: 'https://x/f2.png', asset_id: 'a3' }
  ] };
  const r = await publicar(['instagram_content_publish', 'pages_manage_posts'], mezcla);
  assert.equal(r.status, 'published');
  assert.equal(calls.filter(c => c.url.endsWith('/ig/media') && c.body.is_carousel_item).length, 3);
  assert.ok(!calls.some(c => c.url.endsWith('/pagina/videos')));
  assert.equal(calls.find(c => c.url.endsWith('/pagina/feed'))!.body.attached_media.length, 2);
});

test('reintentar una publicación en parte: solo va a la red que falló y conserva la que ya salió', async () => {
  const enParte = { ...post(1, ['instagram_feed', 'facebook']), status: 'partial', results: { instagram_feed: { id: 'ig_ya', permalink: 'https://www.instagram.com/p/ya/' }, facebook: { error: 'Falta permiso' } } };
  const r = await publicar(['instagram_content_publish', 'pages_manage_posts'], enParte);
  assert.equal(r.status, 'published');
  assert.equal(r.results.instagram_feed.id, 'ig_ya');
  assert.ok(!calls.some(c => c.url.includes('/ig/')), 'no vuelve a publicar en Instagram');
  assert.equal(r.results.facebook.id, 'pagina_1');
});

test('la misma publicación confirmada dos veces tiene la misma huella; otra hora, texto o foto no', () => {
  const base = { scheduled_at: '2026-09-26T00:00:00.000Z', channels: ['facebook', 'instagram_feed'], caption: 'Hola ', products: [{ image_url: 'https://x/1.png' }] };
  assert.equal(socialPosts.postFingerprint(base), socialPosts.postFingerprint({ ...base, scheduled_at: '2026-09-26T00:00:00+00:00', channels: ['instagram_feed', 'facebook'], caption: 'Hola' }));
  assert.notEqual(socialPosts.postFingerprint(base), socialPosts.postFingerprint({ ...base, scheduled_at: '2026-09-26T03:00:00.000Z' }));
  assert.notEqual(socialPosts.postFingerprint(base), socialPosts.postFingerprint({ ...base, caption: 'Otro' }));
  assert.notEqual(socialPosts.postFingerprint(base), socialPosts.postFingerprint({ ...base, products: [{ image_url: 'https://x/2.png' }] }));
  assert.notEqual(socialPosts.postFingerprint({ ...base, channels: ['instagram_story'], caption: '' }), socialPosts.postFingerprint({ ...base, channels: ['instagram_story'], caption: '', media: [{ url: 'https://x/v.mp4' }] }));
});

test('reintentar sin conexión no borra lo que ya salió (si no, se publicaría dos veces)', async () => {
  const enParte: any = { ...post(1, ['instagram_feed', 'facebook']), status: 'partial', results: { instagram_feed: { id: 'ig_ya' }, facebook: { error: 'Falta permiso' } } };
  const r = publisher.withEarlierResults(enParte, await publisher.publishNow(enParte));
  assert.equal(r.status, 'partial');
  assert.equal(r.results.instagram_feed.id, 'ig_ya');
  assert.match(r.error!, /no están conectados/);
  const nueva: any = post(1, ['instagram_feed']);
  const fallida = await publisher.publishNow(nueva);
  assert.deepEqual(publisher.withEarlierResults(nueva, fallida), fallida, 'sin nada publicado antes, no cambia');
});

// ---------- Planificación para aprobar (26-sep) ----------

test('nunca tandas sueltas de 1 o 2 fotos para completar el día', () => {
  const settings = socialPosts.normalizeSettings({ days: [2], hour: '15:00', channels: ['instagram_story'], photosPerPost: 5, photosPerDay: 10 });
  const now = new Date('2026-09-21T12:00:00Z');
  assert.deepEqual(socialPosts.daySlots(settings, ['2026-09-22'], [{ day: '2026-09-22', minutes: 12 * 60, photos: 9 }], now, TZ), [], 'faltaba 1: no se agrega nada');
  const siete = socialPosts.daySlots(settings, ['2026-09-22'], [{ day: '2026-09-22', minutes: 12 * 60, photos: 3 }], now, TZ);
  assert.ok(siete.every(s => s.count >= 3), JSON.stringify(siete.map(s => s.count)));
});

test('historias de Instagram y de Facebook: la tanda va a las dos', () => {
  const settings = socialPosts.normalizeSettings({ days: [2], hour: '15:00', channels: ['instagram_story', 'facebook_story'], photosPerDay: 5, photosPerPost: 5 });
  assert.deepEqual(settings.channels, ['instagram_story', 'facebook_story']);
  const slots = socialPosts.daySlots(settings, ['2026-09-22'], [], new Date('2026-09-21T12:00:00Z'), TZ);
  assert.equal(slots.length, 1);
  assert.equal(slots[0].kind, 'story');
  assert.ok(socialPosts.isStoryChannel('facebook_story'));
});

test('historias de Facebook: cada foto se sube sin publicar y sale como historia de la página', async () => {
  calls.length = 0;
  const r = await publisher.publishToChannels(conexion, ['pages_manage_posts'], post(2, ['facebook_story']), listo);
  assert.equal(r.status, 'published');
  const fotos = calls.filter(c => c.url.endsWith('/pagina/photos'));
  assert.equal(fotos.length, 2);
  assert.ok(fotos.every(f => f.body.published === false));
  assert.equal(fotos[0].body.url, 'https://x/1.png.jpg', 'la foto armada en 9:16');
  assert.equal(calls.filter(c => c.url.endsWith('/pagina/photo_stories')).length, 2);
});

test('el modo de trabajo del agente: lo guardado antes se respeta', () => {
  assert.equal(socialPosts.normalizeSettings({ autoPlan: true }).planMode, 'automatico');
  assert.equal(socialPosts.normalizeSettings({ autoPlan: false }).planMode, 'manual');
  const semanal = socialPosts.normalizeSettings({ planMode: 'semanal', autoPlan: true });
  assert.equal(semanal.planMode, 'semanal');
  assert.equal(semanal.autoPlan, false, 'con reporte no publica solo');
});

test('el reporte se manda: diario desde las 18:00; semanal el sábado; y si falta contenido pronto', () => {
  const sab10 = new Date('2026-09-26T15:30:00Z'); // sábado 10:30 en Ecuador
  assert.equal(publisher.reportDue('semanal', sab10, TZ, '2026-09-19T15:00:00Z', false), true);
  assert.equal(publisher.reportDue('semanal', sab10, TZ, '2026-09-26T15:00:00Z', false), false, 'ya se mandó hoy');
  const mar = new Date('2026-09-22T15:00:00Z');
  assert.equal(publisher.reportDue('semanal', mar, TZ, '2026-09-19T15:00:00Z', false), false, 'martes: espera al sábado');
  assert.equal(publisher.reportDue('semanal', mar, TZ, '2026-09-19T15:00:00Z', true), true, 'pero si falta contenido en 2 días, se manda');
  assert.equal(publisher.reportDue('diario', new Date('2026-09-22T23:30:00Z'), TZ, '2026-09-21T23:30:00Z', false), true, '18:30: el de mañana');
  assert.equal(publisher.reportDue('diario', new Date('2026-09-22T20:00:00Z'), TZ, '2026-09-21T23:30:00Z', false), false, '15:00: todavía no');
  assert.equal(publisher.reportDue('automatico', sab10, TZ, null, true), false);
});

test('el reporte de WhatsApp explica día por día qué sale, a qué hora y por qué', () => {
  const planner = require('../src/social/planner') as typeof import('../src/social/planner');
  const posts = [
    { id: 'a', scheduled_at: '2026-09-29T17:00:00Z', theme: 'Halloween', products: [1, 2, 3, 4, 5].map(i => ({ name: `H${i}`, image_url: 'x', price: 35 })), media: [], channels: ['instagram_story', 'facebook_story'] as any },
    { id: 'b', scheduled_at: '2026-09-29T20:00:00Z', theme: 'Bautizo', products: [1, 2, 3].map(i => ({ name: `B${i}`, image_url: 'x', price: 35 })), media: [], channels: ['instagram_story'] as any }
  ];
  const text = planner.planReportText(posts, 'Halloween es la temporada.', { a: 'Halloween es la temporada: sale todos los días', b: 'Bautizo no se publica desde hace 6 días' }, TZ, 'https://crm/x');
  assert.match(text, /\*mar 29 sep\*/);
  assert.match(text, /• 12:00 Halloween · 5 fotos en historias — Halloween es la temporada/);
  assert.match(text, /• 15:00 Bautizo · 3 fotos en historias — Bautizo no se publica desde hace 6 días/);
  assert.match(text, /8 fotos/);
  assert.match(text, /https:\/\/crm\/x/);
  assert.match(text, /no se publica nada/);
});

test('temporada primero y las demás se turnan: no gana siempre la categoría más grande', () => {
  const muchos = [
    ...Array.from({ length: 30 }, (_, i) => ({ name: `ANIMAL ${i}`, category: 'ANIMALES', price: 38, image_url: `https://x/a${i}.png` })),
    ...Array.from({ length: 6 }, (_, i) => ({ name: `HALLOW ${i}`, category: 'HALLOWEEN', price: 35, image_url: `https://x/h${i}.png` })),
    ...Array.from({ length: 6 }, (_, i) => ({ name: `BAUT ${i}`, category: 'BAUTIZO', price: 35, image_url: `https://x/b${i}.png` }))
  ];
  const picks = socialPosts.pickProducts(muchos, [], 4, [3, 3, 3, 3], 10, { recentCategories: ['Animales'], slotDays: ['d1', 'd1', 'd2', 'd2'] });
  assert.equal(picks[0].theme, 'Halloween', 'en octubre, Halloween primero');
  assert.notEqual(picks[1].theme, 'Halloween', 'no dos veces el mismo día');
  assert.equal(picks[1].theme, 'Bautizo', 'Animales salió hace poco: espera su turno');
  assert.equal(picks[2].theme, 'Halloween');
});
