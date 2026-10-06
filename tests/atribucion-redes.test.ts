/**
 * Agente de redes comercial: códigos por publicación, llamados a la acción, texto sobre las historias, enlace de WhatsApp
 * en Facebook, atribución (exacta y estimada) y recomendaciones solo con datos.
 */
import './entorno';

import test from 'node:test';
import assert from 'node:assert/strict';
import { codesIn, codePrefix, formatCode, estimateFor, byCategory, recommendations, ContentResult } from '../src/social/tracking';
import { ctaWithCode, piecesFor, withCta } from '../src/social/planner';
import { storyTexts, withWhatsAppLink } from '../src/social/publisher';
import { wrapText } from '../src/social/images';
import { paletteFor } from '../src/social/posters';

test('el código sale de la categoría (sin tildes ni palabras de relleno) y se entiende como sea que lo escriban', () => {
  assert.equal(codePrefix('Bautizo', 'VELAMIA'), 'BAUTIZO');
  assert.equal(codePrefix('Vela de comunión', 'VELAMIA'), 'COMUNION');
  assert.equal(codePrefix('Baby shower', 'VELAMIA'), 'BABY');
  assert.equal(codePrefix('Nuestros productos', 'VELAMIA'), 'VELAMIA');
  assert.equal(formatCode('BAUTIZO', 7), 'BAUTIZO07');
  assert.deepEqual(codesIn('Hola! vi BAUTIZO07'), ['BAUTIZO07']);
  assert.deepEqual(codesIn('bautizo 7 por fa'), ['BAUTIZO07']);
  assert.deepEqual(codesIn('Bautizo-07'), ['BAUTIZO07']);
  assert.ok(!codesIn('es para un bautizo 15 de noviembre').includes('BAUTIZO15'), 'una fecha no es un código');
  assert.ok(!codesIn('bautizo 15/11').includes('BAUTIZO15'));
});

test('el llamado a la acción lleva el código (o queda sin él si todavía no hay medición)', () => {
  assert.equal(ctaWithCode('¿Cuántas necesitas? Escríbenos {CODIGO} y te cotizamos', 'BAUTIZO07'), '¿Cuántas necesitas? Escríbenos BAUTIZO07 y te cotizamos');
  assert.equal(ctaWithCode('Cuéntanos tu evento', 'BODA02'), 'Cuéntanos tu evento · Escríbenos BODA02');
  assert.equal(ctaWithCode('Escríbenos {CODIGO} y te mostramos opciones', ''), 'Escríbenos y te mostramos opciones');
  assert.equal(ctaWithCode('Cuéntanos tu evento: escríbenos {CODIGO}', ''), 'Cuéntanos tu evento: escríbenos');
});

test('objetivo, frase y CTA variados cuando la IA no los da; no repite los CTA recientes', () => {
  const pieces = piecesFor([{}, {}, {}], ['¿Cuántas necesitas? Escríbenos BAUTIZO03 y te cotizamos']);
  assert.equal(new Set(pieces.map(p => p.goal)).size, 3);
  assert.ok(pieces.every(p => p.cta.includes('{CODIGO}') && p.phrase));
  assert.ok(!pieces.some(p => p.cta === '¿Cuántas necesitas? Escríbenos {CODIGO} y te cotizamos'));
  assert.deepEqual(piecesFor([{ goal: 'venta', phrase: 'Reserva tu fecha', cta: 'Escríbenos {CODIGO}' }]), [{ goal: 'venta', phrase: 'Reserva tu fecha', cta: 'Escríbenos {CODIGO}' }]);
});

test('el texto del feed termina con el CTA antes de los hashtags (si la IA no lo puso)', () => {
  assert.equal(withCta('Velas para tu bautizo ✨\n\n#bautizo #velas', 'Escríbenos BAUTIZO07'), 'Velas para tu bautizo ✨\nEscríbenos BAUTIZO07\n\n#bautizo #velas');
  assert.equal(withCta('Escríbenos BAUTIZO07 y listo', 'Escríbenos BAUTIZO07 y te cotizamos'), 'Escríbenos BAUTIZO07 y listo');
});

test('historias: la frase va en la primera foto y el CTA en la última; los videos no llevan texto', () => {
  const post = { caption: 'Personalizamos con nombre y fecha\nEscríbenos BAUTIZO07', channels: ['instagram_story', 'facebook_story'] as any };
  const items = [{ type: 'video', url: 'v' }, { type: 'image', url: 'a' }, { type: 'image', url: 'b' }, { type: 'image', url: 'c' }] as any;
  assert.deepEqual(storyTexts(post, items), [undefined, { phrase: 'Personalizamos con nombre y fecha' }, undefined, { cta: 'Escríbenos BAUTIZO07' }]);
  assert.deepEqual(storyTexts(post, [{ type: 'image', url: 'a' }] as any), [{ phrase: 'Personalizamos con nombre y fecha', cta: 'Escríbenos BAUTIZO07' }]);
  assert.deepEqual(storyTexts({ ...post, channels: ['instagram_feed'] as any }, items), [undefined, undefined, undefined, undefined], 'una publicación del feed no lleva texto encima');
  assert.deepEqual(wrapText('Escríbenos BAUTIZO07 y te cotizamos', 30), ['Escríbenos BAUTIZO07 y te', 'cotizamos']);
});

test('en Facebook el código va con un enlace a WhatsApp con el mensaje ya escrito', () => {
  const text = withWhatsAppLink('Velas para tu bautizo\nEscríbenos BAUTIZO07', '+593 99 732 9187', 'VELAMIA');
  assert.match(text, /https:\/\/wa\.me\/593997329187\?text=/);
  assert.match(decodeURIComponent(text), /\(BAUTIZO07\)/);
  assert.equal(withWhatsAppLink('Sin código', '593997329187', 'VELAMIA'), 'Sin código');
});

test('atribución estimada: solo si llegó hasta 24 h después y nombró la categoría o el producto', () => {
  const pub = (id: string, category: string, hoursBefore: number, product = '') => ({ id, category, product_name: product, publish_at: new Date(Date.parse('2026-10-06T15:00:00Z') - hoursBefore * 3_600_000).toISOString() });
  const started = Date.parse('2026-10-06T15:00:00Z');
  const list = [pub('a', 'Bautizo', 2), pub('b', 'Halloween', 1), pub('c', 'Bautizo', 30)];
  assert.equal(estimateFor('hola quiero velitas para el bautizo de mi hijo', started, list)!.id, 'a');
  assert.equal(estimateFor('hola precio?', started, list), null, 'sin nombrar nada no se atribuye');
  assert.equal(estimateFor('quiero la vela osito en frasco', started, [pub('d', 'Baby shower', 3, 'VELA OSITO EN FRASCO')])!.id, 'd');
});

test('recomendaciones solo con datos; si no, SIN DATOS SUFICIENTES', () => {
  const r = (category: string, chats: number, quotations: number, reach = 100): ContentResult => ({ code: category + chats, postId: 'p', category, productName: '', contentType: 'historia', goal: 'consulta', cta: '', publishAt: null, reach, views: 0, interactions: 0, chats, exactChats: chats, quotations, orders: 0, sales: 0, revenue: 0 });
  const few = [r('Bautizo', 1, 0)];
  assert.match(recommendations(byCategory(few), few)[0], /SIN DATOS SUFICIENTES/);
  const many = [r('Bautizo', 2, 1), r('Bautizo', 1, 1), r('Bautizo', 1, 0), r('Matrimonio', 0, 0, 900), r('Matrimonio', 0, 0, 800), r('Matrimonio', 1, 0, 700)];
  const recs = recommendations(byCategory(many), many);
  assert.match(recs[0], /^Bautizo es la que más/);
  assert.ok(recs.length <= 3);
});

test('los colores por categoría de las instrucciones van solo a las fotos con IA', () => {
  const prompt = 'ESTÉTICA\n\n==========\nCOLORES POR CATEGORÍA\n==========\n\nBaby shower:\nRosado pastel, celeste pastel, beige y crema.\n\nBautizo / Comunión:\nBlanco, ivory, beige y dorado suave.\n\nQuince años:\nRosado, lila y nude.\n\n==========\nPRECIOS\n==========\nNada';
  assert.equal(paletteFor(prompt, 'BAUTIZO'), 'Blanco, ivory, beige y dorado suave');
  assert.equal(paletteFor(prompt, 'Quinceañera'), 'Rosado, lila y nude');
  assert.equal(paletteFor(prompt, 'Halloween'), '');
  assert.equal(paletteFor('sin colores', 'Bautizo'), '');
});
