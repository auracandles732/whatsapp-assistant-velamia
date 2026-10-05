/**
 * Las fotos y videos de la biblioteca entran solos en la planificación, también cuando solo se publican historias y
 * aunque no estén marcados con un producto (caso real de VELAMIA: 135 fotos y 14 videos sin marcar, solo historias).
 */
import './entorno';

import test from 'node:test';
import assert from 'node:assert/strict';
import { libraryTandas } from '../src/social/planner';
import { DEFAULT_SETTINGS, PublishingSettings, LibraryItem, zonedTime, localParts, localDay, normalizeSettings, catalogPhotosOf } from '../src/social/posts';
import { PlannedPost } from '../src/social/brain';

const TZ = 'America/Guayaquil';
const historias: PublishingSettings = { ...DEFAULT_SETTINGS, hour: '08:00', channels: ['instagram_story', 'facebook_story'], libraryPerDay: 4 };
const feed: PublishingSettings = { ...DEFAULT_SETTINGS, hour: '19:00', channels: ['instagram_feed', 'facebook'], libraryPerDay: 4 };
const now = zonedTime(2026, 10, 5, 7, 0, TZ);
const at = (day: number, hour: number) => zonedTime(2026, 10, day, hour, 0, TZ);
const DAYS = ['2026-10-05', '2026-10-06', '2026-10-07'];
const foto = (id: string, extra: Partial<LibraryItem> = {}): LibraryItem => ({ id, kind: 'image', url: `https://x/${id}.jpg`, product_name: null, used_count: 0, title: id, width: 736, height: 981, ...extra });
const video = (id: string, extra: Partial<LibraryItem> = {}): LibraryItem => ({ id, kind: 'video', url: `https://x/${id}.mp4`, product_name: null, used_count: 0, title: id, width: 720, height: 1280, ...extra });
const catalogo = (day: number, hour: number): PlannedPost => ({ theme: 'Halloween', products: [{ name: 'CALABAZA', price: 3, image_url: 'x' }], at: at(day, hour), format: 'historia', reason: '' });
const fotos = (n: number, prefix = 'f') => Array.from({ length: n }, (_, i) => foto(`${prefix}${i + 1}`));

test('solo historias: cada día una tanda que abre con un video y sigue con fotos sin marcar', () => {
  const tandas = libraryTandas([catalogo(5, 8), catalogo(5, 11)], [...fotos(10), video('v1'), video('v2')], [], historias, now, TZ, DAYS);
  assert.equal(tandas.length, 3);
  assert.ok(tandas.every(t => t.format === 'historia' && t.library!.length === 4));
  assert.deepEqual(tandas.map(t => t.library![0].kind), ['video', 'video', 'image']);
  // Los tres días distintos y sin repetir nada.
  assert.deepEqual(tandas.map(t => localDay(t.at.toISOString(), TZ)), DAYS);
  const ids = tandas.flatMap(t => t.library!.map(a => a.id));
  assert.equal(new Set(ids).size, ids.length);
  // A una hora libre: lejos de las 08:00 y las 11:00 del Catálogo.
  assert.equal(localParts(tandas[0].at, TZ).hour, 9);
});

test('con publicaciones en el feed la tanda lleva fotos (los videos salen como reels)', () => {
  const [tanda] = libraryTandas([], [...fotos(5), video('v1')], [], feed, now, TZ, ['2026-10-05']);
  assert.equal(tanda.format, 'carrusel');
  assert.ok(tanda.library!.every(a => a.kind === 'image'));
});

test('primero lo que nunca salió y luego lo que hace más tiempo no sale', () => {
  const library = [
    foto('reciente', { used_count: 2, last_used_at: '2026-09-20T12:00:00Z' }),
    foto('viejo', { used_count: 5, last_used_at: '2026-08-01T12:00:00Z' }),
    foto('nueva1'), foto('nueva2')
  ];
  const [tanda] = libraryTandas([], library, [], { ...historias, libraryPerDay: 3 }, now, TZ, ['2026-10-05']);
  assert.deepEqual(tanda.library!.map(a => a.id), ['nueva1', 'nueva2', 'viejo']);
  assert.match(tanda.reason, /todavía no se publican/);
});

test('no repite lo programado ni lo que salió hace menos de una semana, ni la misma foto subida dos veces', () => {
  const posts = [
    { scheduled_at: at(8, 9).toISOString(), status: 'approved' as const, media: [{ type: 'image' as const, url: 'https://x/f1.jpg', asset_id: 'f1' }] },
    { scheduled_at: at(2, 9).toISOString(), status: 'published' as const, media: [{ type: 'image' as const, url: 'https://x/f2.jpg', asset_id: 'f2' }] }
  ];
  const doble = foto('f3-copia', { title: 'f3' });
  const [tanda] = libraryTandas([], [...fotos(6), doble], posts, { ...historias, libraryPerDay: 5 }, now, TZ, ['2026-10-05']);
  const ids = tanda.library!.map(a => a.id);
  assert.ok(!ids.includes('f1') && !ids.includes('f2'));
  assert.ok(!(ids.includes('f3') && ids.includes('f3-copia')));
  assert.equal(ids.length, 4);
});

test('un día que ya tiene algo de la biblioteca (hecho a mano o por el agente) no lleva otra tanda', () => {
  const posts = [{ scheduled_at: at(5, 15).toISOString(), status: 'approved' as const, media: [{ type: 'video' as const, url: 'https://x/v9.mp4', asset_id: 'v9' }] }];
  const tandas = libraryTandas([], fotos(10), posts, historias, now, TZ, ['2026-10-05', '2026-10-06']);
  assert.deepEqual(tandas.map(t => localDay(t.at.toISOString(), TZ)), ['2026-10-06']);
});

test('apagado (0) o sin archivos no agrega nada, y nunca deja una tanda de 1 o 2 sueltas', () => {
  assert.deepEqual(libraryTandas([], fotos(10), [], { ...historias, libraryPerDay: 0 }, now, TZ, DAYS), []);
  assert.deepEqual(libraryTandas([], [], [], historias, now, TZ, DAYS), []);
  const pocas = libraryTandas([], fotos(5), [], historias, now, TZ, DAYS);
  assert.equal(pocas.length, 1, 'con 5 fotos alcanza para una tanda de 4; la siguiente tendría una sola');
});

test('nunca en el pasado ni a menos de una hora', () => {
  const tarde = zonedTime(2026, 10, 5, 20, 30, TZ);
  const tandas = libraryTandas([], fotos(8), [], historias, tarde, TZ, ['2026-10-05', '2026-10-06']);
  assert.ok(tandas.every(t => t.at.getTime() >= tarde.getTime() + 60 * 60 * 1000));
});

test('la biblioteca tiene su propia meta: no le quita fotos al Catálogo', () => {
  assert.equal(catalogPhotosOf({ products: [], media: [{ type: 'image', url: 'a', asset_id: 'a' }, { type: 'video', url: 'b', asset_id: 'b' }] }), 0);
  assert.equal(catalogPhotosOf({ products: [{ name: 'A', price: 1, image_url: 'a' }], media: [{ type: 'image', url: 'a' }, { type: 'video', url: 'b', asset_id: 'b' }] }), 1);
  assert.equal(catalogPhotosOf({ products: [{ name: 'A', price: 1, image_url: 'a' }, { name: 'B', price: 1, image_url: 'b' }], media: [] }), 2);
});

test('la configuración guardada antes de esta opción usa 4 por día; se puede apagar con 0', () => {
  assert.equal(normalizeSettings({ channels: ['instagram_story'] }).libraryPerDay, 4);
  assert.equal(normalizeSettings({ libraryPerDay: 0 }).libraryPerDay, 0);
  assert.equal(normalizeSettings({ libraryPerDay: 40 }).libraryPerDay, 10);
});
