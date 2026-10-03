/**
 * Los videos de la biblioteca entran solos en la planificación del agente (como reels), sin programarlos a mano.
 */
import './entorno';

import test from 'node:test';
import assert from 'node:assert/strict';
import { libraryReels } from '../src/social/planner';
import { DEFAULT_SETTINGS, PublishingSettings, LibraryItem, zonedTime, localParts } from '../src/social/posts';
import { PlannedPost } from '../src/social/brain';

const TZ = 'America/Guayaquil';
const settings: PublishingSettings = { ...DEFAULT_SETTINGS, hour: '19:00', channels: ['instagram_feed', 'facebook'] };
const now = zonedTime(2026, 10, 3, 9, 0, TZ);
const at = (day: number, hour: number) => zonedTime(2026, 10, day, hour, 0, TZ);
const foto = (day: number, hour: number): PlannedPost => ({ theme: 'Bautizo', products: [{ name: 'CRUZ', price: 32, image_url: 'x' }], at: at(day, hour), format: 'carrusel', reason: '' });
const video = (id: string, used = 0, product: string | null = null): LibraryItem => ({ id, kind: 'video', url: `https://x/${id}.mp4`, product_name: product, used_count: used, title: `Video ${id}` });
const catalog = [{ name: 'VELA ANGELITO', category: 'BAUTIZO', price: 35, image_url: 'https://x/a.png' }];
const hourOf = (d: Date) => localParts(d, TZ).hour;

test('un reel por día de publicación, con el video que menos ha salido y a una hora libre', () => {
  const reels = libraryReels([foto(5, 19)], [video('a', 3), video('b', 0), video('c', 1)], [], catalog, settings, now, TZ, ['2026-10-05', '2026-10-07']);
  assert.equal(reels.length, 2);
  assert.deepEqual(reels.map(r => r.video!.id), ['b', 'c']);
  assert.ok(reels.every(r => r.format === 'reel'));
  // Dos horas antes de la hora elegida, lejos de la tanda de fotos de las 19:00.
  assert.equal(hourOf(reels[0].at), 17);
});

test('el reel habla del producto que tiene marcado el video; si no tiene, de la marca', () => {
  const [conProducto, sinProducto] = libraryReels([], [video('a', 0, 'Vela Angelito'), video('b', 1)], [], catalog, settings, now, TZ, ['2026-10-05', '2026-10-07']);
  assert.equal(conProducto.theme, 'Bautizo');
  assert.equal(conProducto.products[0].name, 'VELA ANGELITO');
  assert.equal(sinProducto.theme, 'Video b');
  assert.equal(sinProducto.products.length, 0);
});

test('no repite un video que ya está en una publicación pendiente ni pone dos videos el mismo día', () => {
  const existing = [
    { scheduled_at: at(5, 12).toISOString(), status: 'approved' as const, media: [{ type: 'video' as const, url: 'https://x/a.mp4', asset_id: 'a' }] }
  ];
  const reels = libraryReels([], [video('a'), video('b')], existing, catalog, settings, now, TZ, ['2026-10-05', '2026-10-07']);
  assert.equal(reels.length, 1);
  assert.equal(reels[0].video!.id, 'b');
  assert.equal(localParts(reels[0].at, TZ).day, 7);
});

test('sin videos, o si solo se publican historias, no agrega reels', () => {
  assert.deepEqual(libraryReels([foto(5, 19)], [], [], catalog, settings, now, TZ, ['2026-10-05']), []);
  const soloHistorias = { ...settings, channels: ['instagram_story' as const] };
  assert.deepEqual(libraryReels([], [video('a')], [], catalog, soloHistorias, now, TZ, ['2026-10-05']), []);
});

test('nunca en el pasado ni a menos de una hora', () => {
  const tarde = zonedTime(2026, 10, 5, 18, 30, TZ);
  const reels = libraryReels([], [video('a')], [], catalog, settings, tarde, TZ, ['2026-10-05']);
  assert.ok(reels.every(r => r.at.getTime() >= tarde.getTime() + 60 * 60 * 1000));
});
