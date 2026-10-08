/**
 * Creador de campañas de Meta: objetivo y destino, varios conjuntos y anuncios (foto, video o carrusel), lo que se manda a
 * Meta (formas validadas con Meta), la revisión con sus reglas, la propuesta de la IA y la memoria de estrategias.
 */
import './entorno';

import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeSettings, PickProduct } from '../src/services/adBuilder';
import {
  normalizePlan, reviewPlan, campaignParams, adsetParams, creativeParams, linkFor, campaignNames, zonedMidnight, buildCampaignProposal, fromLegacy,
  activeDailyOf, dailyTotal, LibraryItem, Uploaded, CampaignPlan
} from '../src/services/adCampaigns';
import { describeAd, resultOf, summarize, MemoryAd } from '../src/services/adMemory';

const catalog: PickProduct[] = [
  { id: '1', name: 'VELA LEONCITO', displayName: 'Vela de Leoncito', price: 30, unit: 'docena', category: 'BABY SHOWER', description: '', images: ['https://crm/leon.jpg', 'https://crm/leon-2.png'], webId: 12, webCategory: 'baby-shower' },
  { id: '2', name: 'VELA ELEFANTITO', price: 45, unit: 'docena', category: 'BABY SHOWER', description: '', images: ['https://crm/elefante.jpg'], webId: 13, webCategory: 'baby-shower' },
  { id: '3', name: 'VELA CALABAZA', price: 32, unit: 'docena', category: 'HALLOWEEN', description: '', images: ['https://crm/calabaza.jpg'], webId: null, webCategory: 'halloween' }
];
const library: LibraryItem[] = [
  { id: 'v1', kind: 'video', url: 'https://crm/social/taller.mp4', thumb: 'https://crm/social/thumbs/v1.jpg', title: 'Taller', product: '', duration: 12, usedCount: 0 },
  { id: 'i1', kind: 'image', url: 'https://crm/social/mesa.jpg', thumb: 'https://crm/social/mesa.jpg', title: 'Mesa de dulces', product: '', duration: null, usedCount: 2 }
];
const settings = normalizeSettings({ pageId: '1044219295441808', instagramId: '17841442983402082', pixelId: '1462926855313741', whatsappNumber: '593997329187', webUrl: 'https://www.velamia.shop', country: 'EC', maxDaily: 10, attributionDays: 1, audience: { ageMin: 22, ageMax: 45, gender: 'mujeres' } });
const ctx = { catalog, library, settings, today: '2026-10-08' };

const photoAd = (over: any = {}) => ({ format: 'image', name: 'Leoncito', angle: 'precio', productId: '1', media: { url: 'https://crm/leon.jpg' }, texts: ['Recuerdos para baby shower hechos a mano. Leoncito $30 la docena.', 'Otro texto'], headlines: ['Leoncito $30 la docena'], description: 'Hechas a mano', cta: 'SHOP_NOW', link: 'producto', ...over });
const videoAd = (over: any = {}) => ({ format: 'video', name: 'Taller', angle: 'hecho a mano', media: { assetId: 'v1' }, texts: ['Así hacemos cada vela, a mano.'], headlines: ['Hechas a mano'], description: '', ...over });
const carouselAd = (over: any = {}) => ({
  format: 'carousel', name: 'Colección', texts: ['Nuestra colección de baby shower.'], cards: [
    { productId: '1', media: { url: 'https://crm/leon.jpg' }, title: 'Leoncito $30', description: 'Con empaque' },
    { media: { assetId: 'v1' }, title: 'Así las hacemos', description: '' },
    { productId: '2', media: { url: 'https://crm/elefante.jpg' }, title: 'Elefantito $45', description: '' }
  ], ...over
});
const raw = (over: any = {}) => ({
  objective: 'ventas', destination: 'web', theme: 'Baby Shower', hypothesis: '¿video o foto?', adsets: [
    { name: 'Mamás', focus: 'intereses de baby shower', dailyBudget: 3, audience: { ageMin: 22, ageMax: 45, gender: 'mujeres', interests: [{ id: '6003321277514', name: 'Fiestas premamá' }], cities: [{ key: '640392', name: 'Guayaquil', radius: 30 }] }, ads: [photoAd(), videoAd(), carouselAd()] },
    { name: 'Abierto', dailyBudget: 3, audience: { ageMin: 22, ageMax: 40, gender: 'todos', advantage: true }, placements: { mode: 'manual', facebook: false, instagram: true, feed: true, stories: true, reels: false }, ads: [photoAd({ productId: '2', media: { url: 'https://crm/elefante.jpg' }, texts: ['Elefantito $45 la docena.'] })] }
  ], ...over
});
const fake: Map<string, Uploaded> = new Map([
  ['https://crm/leon.jpg', { hash: 'h-leon' }], ['https://crm/elefante.jpg', { hash: 'h-ele' }], ['https://crm/social/taller.mp4', { videoId: '777', thumbHash: 'h-thumb' }],
  ['https://crm/social/mesa.jpg', { hash: 'h-mesa' }]
]);

test('la campaña acepta varios conjuntos y anuncios con fotos del Catálogo y videos de la Biblioteca', () => {
  const { plan, errors } = normalizePlan(raw(), ctx);
  assert.deepEqual(errors, []);
  assert.equal(plan.adsets.length, 2);
  assert.equal(plan.adsets[0].ads.length, 3);
  assert.equal(plan.adsets[0].ads[1].media?.kind, 'video');
  assert.equal(plan.adsets[0].ads[2].cards.length, 3);
  assert.equal(plan.adsets[1].audience.ageMax, 65, 'con Advantage+ la edad máxima la amplía Meta');
  assert.equal(plan.attributionDays, 1, 'toma la ventana de atribución de la empresa');
  assert.equal(dailyTotal(plan), 6);
});

test('nada que no sea del Catálogo o la Biblioteca, objetivos y destinos posibles, límites y presupuesto', () => {
  const errs = (over: any) => normalizePlan(raw(over), ctx).errors.join(' | ');
  assert.match(errs({ adsets: [{ ...raw().adsets[0], ads: [photoAd({ media: { url: 'https://otro.com/foto.jpg' } })] }] }), /elige una foto/);
  assert.match(errs({ adsets: [{ ...raw().adsets[0], ads: [videoAd({ media: { assetId: 'no-existe' } })] }] }), /un video de la Biblioteca/);
  assert.match(errs({ adsets: [{ ...raw().adsets[0], ads: [carouselAd({ cards: carouselAd().cards.slice(0, 1) })] }] }), /al menos 2 tarjetas/);
  assert.match(errs({ adsets: [{ ...raw().adsets[0], ads: [carouselAd({ cards: [carouselAd().cards[0], carouselAd().cards[0]] })] }] }), /dos tarjetas/);
  assert.match(errs({ objective: 'trafico', destination: 'whatsapp' }), /no puede llevar a WhatsApp/);
  assert.match(errs({ adsets: raw().adsets.map((a: any) => ({ ...a, dailyBudget: 6 })) }), /suman \$12\.00.*tope es \$10\.00/);
  assert.match(errs({ budgetMode: 'campana', campaignBudget: 20 }), /pasa tu tope/);
  assert.equal(errs({ budgetMode: 'campana', campaignBudget: 8, adsets: raw().adsets.map((a: any) => ({ ...a, dailyBudget: 0 })) }), '', 'con presupuesto de campaña no importa el de cada conjunto');
  assert.match(errs({ adsets: Array(6).fill(raw().adsets[1]) }), /Máximo 5 conjuntos/);
  assert.match(errs({ adsets: [{ ...raw().adsets[1], ads: Array(9).fill(photoAd()) }] }), /máximo 8 anuncios/);
  assert.match(errs({ objective: 'interaccion', destination: 'anuncio', adsets: [{ ...raw().adsets[0], optimization: 'reproducciones' }] }), /todos sus anuncios tienen que ser videos/);
  assert.match(errs({ startDate: '2026-10-01' }), /ya pasó/);
  assert.match(errs({ adsets: [{ ...raw().adsets[1], placements: { mode: 'manual', facebook: true, instagram: false, feed: false, stories: false, reels: false } }] }), /al menos un lugar/);
});

test('cada objetivo y destino se manda a Meta con la forma que Meta aceptó (validada con validate_only)', () => {
  const { plan } = normalizePlan(raw(), ctx);
  const set = plan.adsets[0];
  const p = (objective: string, destination: string, over: any = {}) => adsetParams({ ...plan, objective, destination } as CampaignPlan, { ...set, ...over }, settings, 'C1', 'n', 'America/Guayaquil', '2026-10-08') as any;
  const web = p('ventas', 'web');
  assert.equal(web.optimization_goal, 'OFFSITE_CONVERSIONS');
  assert.deepEqual(web.promoted_object, { pixel_id: '1462926855313741', custom_event_type: 'ADD_TO_CART' });
  assert.deepEqual(web.attribution_spec, [{ event_type: 'CLICK_THROUGH', window_days: 1 }]);
  assert.equal(web.daily_budget, 300);
  assert.equal(web.status, 'PAUSED');
  assert.deepEqual(p('ventas', 'whatsapp').promoted_object, { page_id: '1044219295441808', whatsapp_phone_number: '593997329187' });
  assert.equal(p('ventas', 'whatsapp').destination_type, 'WHATSAPP');
  assert.equal(p('interaccion', 'whatsapp').optimization_goal, 'CONVERSATIONS');
  assert.equal(p('interaccion', 'web').promoted_object.custom_event_type, 'CONTENT_VIEW');
  assert.equal(p('interaccion', 'anuncio').optimization_goal, 'POST_ENGAGEMENT');
  assert.equal(p('interaccion', 'anuncio', { optimization: 'reproducciones' }).optimization_goal, 'THRUPLAY');
  assert.equal(p('trafico', 'web').optimization_goal, 'LANDING_PAGE_VIEWS');
  assert.equal(p('reconocimiento', 'anuncio').optimization_goal, 'REACH');
  // Público: ciudades con radio, intereses, género y ubicaciones elegidas.
  assert.deepEqual(web.targeting.geo_locations, { cities: [{ key: '640392', radius: 30, distance_unit: 'kilometer' }], location_types: ['home', 'recent'] });
  assert.deepEqual(web.targeting.flexible_spec, [{ interests: [{ id: '6003321277514', name: 'Fiestas premamá' }] }]);
  assert.deepEqual(web.targeting.genders, [2]);
  const manual = adsetParams(plan, plan.adsets[1], settings, 'C1', 'n') as any;
  assert.deepEqual(manual.targeting.publisher_platforms, ['instagram']);
  assert.deepEqual(manual.targeting.instagram_positions, ['stream', 'story']);
  assert.equal(manual.targeting.facebook_positions, undefined);
  assert.deepEqual(manual.targeting.geo_locations.countries, ['EC']);
  // Presupuesto de campaña: va en la campaña y no en los conjuntos.
  const cbo = { ...plan, budgetMode: 'campana' as const, campaignBudget: 8 };
  assert.deepEqual(campaignParams(cbo, 'x'), { name: 'x', objective: 'OUTCOME_SALES', status: 'PAUSED', special_ad_categories: [], daily_budget: 800, bid_strategy: 'LOWEST_COST_WITHOUT_CAP' });
  assert.equal((adsetParams(cbo, set, settings, 'C1', 'n') as any).daily_budget, undefined);
  assert.equal((campaignParams(plan, 'x') as any).is_adset_budget_sharing_enabled, false);
  // Fechas: medianoche de Guayaquil (UTC-5); una fecha de hoy no se manda (empieza al activar).
  assert.equal(zonedMidnight('2026-10-10', 'America/Guayaquil'), Date.parse('2026-10-10T05:00:00Z') / 1000);
  const dated = adsetParams({ ...plan, startDate: '2026-10-10', endDate: '2026-10-20' }, set, settings, 'C1', 'n', 'America/Guayaquil', '2026-10-08') as any;
  assert.equal(dated.start_time, Date.parse('2026-10-10T05:00:00Z') / 1000);
  assert.equal(dated.end_time, Date.parse('2026-10-21T04:59:59Z') / 1000);
  assert.equal((adsetParams({ ...plan, startDate: '2026-10-08' }, set, settings, 'C1', 'n', 'America/Guayaquil', '2026-10-08') as any).start_time, undefined);
});

test('el contenido de cada formato: foto con enlace y varias opciones de texto, video, carrusel con video, sin enlace', () => {
  const { plan } = normalizePlan(raw(), ctx);
  const [photo, video, carousel] = plan.adsets[0].ads;
  const c1 = creativeParams(plan, photo, settings, catalog, fake, 'n') as any;
  assert.equal(c1.object_story_spec.link_data.link, 'https://www.velamia.shop/?categoria=baby-shower&producto=12');
  assert.equal(c1.object_story_spec.link_data.image_hash, 'h-leon');
  assert.deepEqual(c1.object_story_spec.link_data.call_to_action, { type: 'SHOP_NOW', value: { link: 'https://www.velamia.shop/?categoria=baby-shower&producto=12' } });
  assert.match(c1.url_tags, /ad_id=\{\{ad\.id\}\}/);
  assert.equal(c1.asset_feed_spec.bodies.length, 2);
  assert.equal(c1.object_story_spec.instagram_user_id, '17841442983402082');
  const c2 = creativeParams(plan, video, settings, catalog, fake, 'n') as any;
  assert.equal(c2.object_story_spec.video_data.video_id, '777');
  assert.equal(c2.object_story_spec.video_data.image_hash, 'h-thumb');
  assert.equal(c2.object_story_spec.video_data.call_to_action.value.link, 'https://www.velamia.shop/');
  const c3 = creativeParams(plan, carousel, settings, catalog, fake, 'n') as any;
  const cards = c3.object_story_spec.link_data.child_attachments;
  assert.deepEqual(cards.map((c: any) => c.video_id || c.image_hash), ['h-leon', '777', 'h-ele']);
  assert.equal(cards[1].image_hash, 'h-thumb', 'la tarjeta de video lleva su portada');
  assert.equal(cards[0].link, 'https://www.velamia.shop/?categoria=baby-shower&producto=12');
  assert.equal(c3.asset_feed_spec, undefined, 'el carrusel lleva un solo texto');
  // A WhatsApp: botón de WhatsApp, sin etiquetas de la web.
  const wa = { ...plan, destination: 'whatsapp' as const };
  const c4 = creativeParams(wa, video, settings, catalog, fake, 'n') as any;
  assert.deepEqual(c4.object_story_spec.video_data.call_to_action, { type: 'WHATSAPP_MESSAGE', value: { app_destination: 'WHATSAPP' } });
  assert.equal(c4.url_tags, undefined);
  assert.equal(linkFor(wa, settings, catalog, 'producto', ['1']), 'https://wa.me/593997329187');
  // En el anuncio y sin web: la foto va sin enlace.
  const noWeb = normalizeSettings({ ...settings, webUrl: '' });
  const c5 = creativeParams({ ...plan, objective: 'interaccion', destination: 'anuncio' }, photo, noWeb, catalog, fake, 'n') as any;
  assert.deepEqual(c5.object_story_spec.photo_data, { image_hash: 'h-leon', caption: photo.texts[0] });
  assert.equal(linkFor(plan, settings, catalog, 'categoria', ['1', '2']), 'https://www.velamia.shop/?categoria=baby-shower');
  assert.equal(linkFor(plan, settings, catalog, 'inicio', ['1']), 'https://www.velamia.shop/');
  const names = campaignNames(plan, 'VELAMIA', 'EC', new Date('2026-10-08T15:00:00Z'));
  assert.equal(names.campaign, 'VELAMIA | Baby Shower | Ventas Web | Oct2026 | CRM');
  assert.equal(names.adsets[0], 'Mamás | Mujeres 22-45 | Guayaquil | Oct2026');
  assert.equal(names.ads[0][1], 'VELAMIA | Taller | Video | Mamás Oct2026');
});

test('la revisión marca cada problema en su conjunto y anuncio', () => {
  const { plan } = normalizePlan(raw({ adsets: [{ ...raw().adsets[0], ads: [photoAd({ texts: ['¿Estás embarazada? Leoncito a $25.'] }), videoAd({ texts: ['Escríbenos por WhatsApp'] })] }] }), ctx);
  const issues = reviewPlan(plan, catalog);
  const errors = issues.filter(i => i.level === 'error').map(i => `${i.where}: ${i.text}`).join(' | ');
  assert.match(errors, /Conjunto 1 · Anuncio 1 · Texto 1: Meta no permite suponer algo personal/);
  assert.match(errors, /Conjunto 1 · Anuncio 1 · Texto 1: El precio \$25/);
  assert.match(errors, /Conjunto 1 · Anuncio 2 · Texto 1: Este anuncio lleva a la web/);
  const wa = normalizePlan(raw({ destination: 'whatsapp', adsets: [{ ...raw().adsets[0], ads: [videoAd({ texts: ['Escríbenos por WhatsApp'] })] }] }), ctx).plan;
  assert.equal(reviewPlan(wa, catalog).filter(i => i.level === 'error').length, 0, 'a WhatsApp sí se puede nombrar');
  const many = normalizePlan(raw({ adsets: [{ ...raw().adsets[1], ads: Array(7).fill(photoAd()) }] }), ctx).plan;
  assert.ok(reviewPlan(many, catalog).some(i => i.where === 'Conjunto 1' && /Más de 6 anuncios/.test(i.text)));
});

test('la propuesta de la IA solo usa productos, fotos y videos reales y respeta el tope', () => {
  const ai = {
    tema: 'Baby Shower', hipotesis: '¿video o foto?', explicacion: 'x', conjuntos: [{
      nombre: 'Mamás', enfoque: 'baby shower', edad_min: 22, edad_max: 45, genero: 'mujeres' as const, intereses: [], ciudades: [], presupuesto: 9,
      _interests: [{ id: '6003321277514', name: 'Fiestas premamá' }],
      anuncios: [
        { formato: 'image' as const, nombre: 'Leoncito', angulo: 'precio', producto: 'VELA LEONCITO', biblioteca_id: '', textos: ['Leoncito a $99 la docena', 'Leoncito $30 la docena, hecho a mano'], titulos: ['Leoncito $30'], descripcion: '', boton: 'ORDER_NOW', tarjetas: [] },
        { formato: 'video' as const, nombre: 'Taller', angulo: 'proceso', producto: '', biblioteca_id: 'v1', textos: ['Hechas a mano'], titulos: ['A mano'], descripcion: '', boton: 'NADA', tarjetas: [] },
        { formato: 'carousel' as const, nombre: 'Uno solo', angulo: '', producto: '', biblioteca_id: '', textos: ['Colección'], titulos: [], descripcion: '', boton: '', tarjetas: [{ producto: 'VELA ELEFANTITO', biblioteca_id: '', titulo: 'Elefantito', descripcion: '' }] },
        { formato: 'image' as const, nombre: 'Inventado', angulo: '', producto: 'VELA QUE NO EXISTE', biblioteca_id: '', textos: ['x'], titulos: ['x'], descripcion: '', boton: '', tarjetas: [] }
      ]
    }, {
      nombre: 'Abierto', enfoque: '', edad_min: 18, edad_max: 65, genero: 'todos' as const, intereses: [], ciudades: [], presupuesto: 9,
      anuncios: [{ formato: 'image' as const, nombre: 'Mesa', angulo: '', producto: '', biblioteca_id: 'i1', textos: ['Mesa de dulces'], titulos: ['Mesa'], descripcion: '', boton: '', tarjetas: [] }]
    }]
  };
  const { plan } = buildCampaignProposal(ai, { objective: 'ventas', destination: 'web', chosen: [catalog[0], catalog[1]], catalog, library, settings, idea: '', budget: 3, nAds: 8 });
  const ads = plan.adsets[0].ads;
  assert.deepEqual(ads[0].texts, ['Leoncito $30 la docena, hecho a mano'], 'el texto con un precio inventado se quita');
  assert.equal(ads[0].cta, 'ORDER_NOW');
  assert.equal(ads[1].media?.assetId, 'v1');
  assert.equal(ads[1].cta, 'SHOP_NOW', 'un botón que no existe vuelve al primero');
  assert.equal(ads[2].format, 'image', 'un carrusel de una tarjeta queda como foto');
  assert.ok(ads[3].media && catalog.some(p => p.images.includes(ads[3].media!.url)), 'un producto inventado usa una foto de los elegidos');
  assert.equal(plan.adsets[1].ads[0].media?.assetId, 'i1');
  assert.deepEqual(plan.adsets[0].audience.interests, [{ id: '6003321277514', name: 'Fiestas premamá' }]);
  assert.ok(dailyTotal(plan) <= 10, 'el presupuesto de la IA se ajusta al tope');
  assert.deepEqual(normalizePlan(plan, ctx).errors, [], 'la propuesta pasa la misma revisión que lo que se edita');
});

test('las campañas del creador de antes se ven como campaña y cuentan en el tope', () => {
  const legacy = fromLegacy({
    campaignId: '5', adsetId: '6', adId: '7', creativeId: '8', name: 'VELAMIA | Animales | WhatsApp | Oct2026 | CRM', adName: 'a', destination: 'whatsapp', format: 'single', theme: 'Animales',
    products: ['VELA LEONCITO'], image: 'https://crm/leon.jpg', text: 't', dailyBudget: 4, audience: { ageMin: 22, ageMax: 45, gender: 'mujeres', advantage: false },
    status: 'ACTIVE', createdAt: '2026-10-06T10:00:00Z', history: [], warnings: []
  });
  assert.equal(legacy.objective, 'interaccion');
  assert.equal(legacy.adsets[0].ads[0].adId, '7');
  assert.equal(activeDailyOf([legacy]), 4);
  assert.equal(activeDailyOf([legacy], '5'), 0);
});

test('memoria: formato, destino, público y resultado de cada anuncio, y grupos para comparar', () => {
  const ad = {
    creative: { object_story_spec: { video_data: { video_id: '1', call_to_action: { value: { link: 'https://www.velamia.shop/' } } } } },
    adset: { optimization_goal: 'OFFSITE_CONVERSIONS', promoted_object: { custom_event_type: 'PURCHASE' }, targeting: { age_min: 22, age_max: 45, genders: [2], flexible_spec: [{ interests: [{ id: '1', name: 'Maternidad' }] }], targeting_automation: { advantage_audience: 0 } } }
  };
  const d = describeAd(ad);
  assert.equal(d.format, 'video');
  assert.equal(d.destination, 'web');
  assert.deepEqual(d.audience.interests, ['Maternidad']);
  assert.equal(d.event, 'PURCHASE');
  assert.equal(describeAd({ creative: { object_story_spec: { link_data: { link: 'https://wa.me/1', child_attachments: [{}, {}] } } }, adset: { optimization_goal: 'CONVERSATIONS', destination_type: 'WHATSAPP' } }).format, 'carrusel');
  assert.deepEqual(resultOf('OFFSITE_CONVERSIONS', 'PURCHASE', { actions: [{ action_type: 'offsite_conversion.fb_pixel_purchase', value: '3' }, { action_type: 'omni_purchase', value: '3' }] }), { label: 'Compras', value: 3 }, 'el mismo resultado con dos nombres no se suma');
  assert.equal(resultOf('CONVERSATIONS', '', { actions: [{ action_type: 'onsite_conversion.messaging_conversation_started_7d', value: '5' }] }).value, 5);
  const row = (over: Partial<MemoryAd>): MemoryAd => ({
    adId: '1', name: 'a', campaign: 'c', campaignId: 'c1', objective: 'Ventas', destination: 'web', optimization: 'OFFSITE_CONVERSIONS', format: 'video',
    audience: { ageMin: 22, ageMax: 45, gender: 'mujeres', interests: ['Maternidad'], cities: [], advantage: false }, category: 'baby-shower', products: [], angle: 'testimonio', text: '',
    createdAt: '', status: '', from: '', to: '', spend: 10, impressions: 1000, reach: 800, clicks: 20, ctr: 2, resultLabel: 'Compras', results: 2, costPerResult: 5,
    conversations: 0, addToCart: 0, purchases: 2, purchaseValue: 90, chats: 1, sales: 1, revenue: 30, roas: 12, ...over
  });
  const groups = summarize([row({}), row({ adId: '2', format: 'foto', spend: 10, purchases: 0, purchaseValue: 0, sales: 0, revenue: 0, chats: 0, angle: 'precio' })]);
  const byFormat = groups.filter(g => g.dimension === 'Formato');
  assert.deepEqual(byFormat.map(g => [g.value, g.roas]), [['video', 12], ['foto', null]], 'el que vendió primero');
  assert.ok(groups.some(g => g.dimension === 'Interés' && g.value === 'Maternidad' && g.ads === 2));
  assert.ok(groups.some(g => g.dimension === 'Ángulo' && g.value === 'testimonio'));
});
