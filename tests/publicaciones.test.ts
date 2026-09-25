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

test('la planificación de la IA se ajusta a la realidad: días libres, horas futuras, topes y productos del Catálogo', () => {
  const brain = require('../src/social/brain') as typeof import('../src/social/brain');
  const settings = socialPosts.normalizeSettings({ days: [1, 2, 3, 4, 5, 6, 0], hour: '19:00', channels: ['instagram_feed', 'instagram_story', 'facebook'] });
  const input = {
    slots: [], days: ['2026-09-22', '2026-09-23'], catalog: catalogo, recent: ['OSITO NUBE'], recentThemes: [],
    library: [{ id: 'v1', kind: 'video' as const, url: 'https://x/v1.mp4', product_name: 'ARBOLITO' }],
    settings, month: 9, now: new Date('2026-09-21T15:00:00Z'), timeZone: TZ, profile: VELAMIA_PROFILE
  };
  const item = (dia: string, hora: string, formato: string, categoria: string, cantidad = 1, video = '') => ({ dia, hora, formato, categoria, cantidad, video, motivo: 'porque sí' });
  const posts = brain.resolveAiPlan([
    item('2026-09-22', '19:00', 'carrusel', 'baby shower', 5),
    item('2026-09-22', '19:00', 'foto', 'BABY SHOWER'),        // ya no quedan productos de esa categoría
    item('2026-09-22', '19:30', 'historia', 'NAVIDAD'),       // choca de hora: se corre una hora
    item('2026-09-23', '12:00', 'reel', 'NAVIDAD', 1, 'v1'),
    item('2026-09-23', '13:00', 'reel', 'NAVIDAD', 1, 'v9'),  // video que no existe: pasa a foto
    item('2026-09-24', '19:00', 'foto', 'BAUTIZO'),           // día que no está libre
    item('2026-09-23', '19:00', 'foto', 'INVENTADA')          // categoría que no existe
  ], input);
  assert.equal(posts.length, 4);
  assert.deepEqual(posts[0].products.map(p => p.name), ['OSITO MIEL', 'OSITO NUBE'], 'primero lo que hace más tiempo no sale');
  assert.equal(posts[0].format, 'carrusel');
  assert.equal(posts[0].theme, 'Baby shower');
  const story = posts.find(p => p.format === 'historia')!;
  assert.equal(story.at.toISOString(), '2026-09-23T01:30:00.000Z', 'la historia se movió a las 20:30');
  const reel = posts.find(p => p.format === 'reel')!;
  assert.equal(reel.video?.id, 'v1');
  assert.deepEqual(reel.products.map(p => p.name), ['ARBOLITO']);
  const converted = posts.find(p => p.at.toISOString() === '2026-09-23T18:00:00.000Z')!;
  assert.equal(converted.format, 'foto');
  assert.equal(converted.products[0].name, 'ESTRELLA', 'no repite el producto del reel');
  assert.equal(posts[0].reason, 'porque sí');
});

test('la IA no pasa del tope por día', () => {
  const brain = require('../src/social/brain') as typeof import('../src/social/brain');
  const settings = socialPosts.normalizeSettings({ days: [2], hour: '19:00' });
  const many = Array.from({ length: 6 }, (_, i) => ({ dia: '2026-09-22', hora: `${String(8 + i * 2).padStart(2, '0')}:00`, formato: 'foto', categoria: i % 2 ? 'NAVIDAD' : 'BABY SHOWER', cantidad: 1, video: '', motivo: '' }));
  const posts = brain.resolveAiPlan(many, {
    slots: [], days: ['2026-09-22'], catalog: catalogo, recent: [], recentThemes: [], library: [],
    settings, month: 9, now: new Date('2026-09-21T15:00:00Z'), timeZone: TZ, profile: VELAMIA_PROFILE
  });
  assert.equal(posts.length, socialPosts.MAX_POSTS_PER_DAY);
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

test('la historia de Instagram va con la primera foto, armada en formato de historia', async () => {
  const kinds: string[] = [];
  calls.length = 0;
  const r = await publisher.publishToChannels(conexion, ['instagram_content_publish'], post(2, ['instagram_story']), { waitMs: 0, prepareImage: async (url: string, kind: string) => { kinds.push(kind); return `${url}.${kind}.jpg`; } });
  assert.equal(r.status, 'published');
  const media = calls.filter(c => c.url.endsWith('/ig/media'));
  assert.equal(media.length, 1);
  assert.equal(media[0].body.media_type, 'STORIES');
  assert.deepEqual(kinds, ['story']);
  assert.equal(media[0].body.image_url, 'https://x/1.png.story.jpg');
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
