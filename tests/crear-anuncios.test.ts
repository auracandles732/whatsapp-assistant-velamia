/**
 * Crear anuncios con IA desde el CRM: lo que se manda a Meta (en pausa, sin mejoras automáticas), la revisión con las
 * reglas de publicidad de Meta y los topes que cuidan la cuenta.
 */
import './entorno';

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeSettings, normalizeDraft, reviewDraft, linksFor, campaignParams, adsetParams, creativeParams, namesFor, accountHealth, metaMessage,
  activeDaily, actionsToday, liveFrom, buildProposal, URL_TAGS, OPT_OUT_FEATURES, PickProduct, AdDraft, CreatedAd
} from '../src/services/adBuilder';

const catalog: PickProduct[] = [
  { id: '1', name: 'VELA LEONCITO', price: 30, unit: 'docena', category: 'BABY SHOWER', description: '', images: ['https://crm/leon.jpg', 'https://web/leon-2.png'], webId: 12, webCategory: 'baby-shower' },
  { id: '2', name: 'VELA ELEFANTITO', price: 45, unit: 'docena', category: 'BABY SHOWER', description: '', images: ['https://crm/elefante.jpg'], webId: 13, webCategory: 'baby-shower' },
  { id: '3', name: 'VELA CALABAZA', price: 32, unit: 'docena', category: 'HALLOWEEN', description: '', images: ['https://crm/calabaza.jpg'], webId: null, webCategory: 'halloween' }
];
const settings = normalizeSettings({ pageId: '1044219295441808', instagramId: '17841442983402082', pixelId: '1462926855313741', whatsappNumber: '593997329187', webUrl: 'https://www.velamia.shop/', country: 'EC', maxDaily: 10 });

const draft = (over: Partial<AdDraft> = {}): AdDraft => ({
  destination: 'web', format: 'carousel', theme: 'Baby Shower', texts: ['Recuerdos para baby shower hechos a mano. Leoncito $30 la docena.'], headlines: ['Leoncito $30 la docena'],
  description: 'Hechas a mano', cards: [
    { product: 'VELA LEONCITO', image: 'https://crm/leon.jpg', title: 'Leoncito $30 la docena', description: 'Con empaque' },
    { product: 'VELA ELEFANTITO', image: 'https://crm/elefante.jpg', title: 'Elefantito $45 la docena', description: 'Hecho a mano' }
  ], dailyBudget: 3, audience: { ageMin: 22, ageMax: 45, gender: 'mujeres', advantage: false }, ...over
});

test('los ajustes aceptan solo datos válidos (web https, números, tope)', () => {
  assert.equal(settings.webUrl, 'https://www.velamia.shop');
  assert.equal(normalizeSettings({ webUrl: 'http://otra.com' }).webUrl, '');
  assert.equal(normalizeSettings({ whatsappNumber: '+593 99 732 9187' }).whatsappNumber, '593997329187');
  assert.equal(normalizeSettings({ maxDaily: 9999 }).maxDaily, 10, 'un tope fuera de rango vuelve a $10');
  assert.equal(normalizeSettings({}).audience.gender, 'todos', 'por defecto el público no supone nada del negocio');
});

test('el borrador solo usa productos y fotos del Catálogo, y respeta el tope por día', () => {
  const ok = normalizeDraft(draft(), catalog, settings);
  assert.deepEqual(ok.errors, []);
  const foreign = normalizeDraft(draft({ cards: [{ product: 'VELA LEONCITO', image: 'https://otro-sitio/foto.jpg', title: 'x', description: '' }, draft().cards[1]] }), catalog, settings);
  assert.ok(foreign.errors.some(e => /Elige una foto/.test(e)), 'una foto que no es del producto no pasa');
  assert.ok(normalizeDraft(draft({ cards: [{ ...draft().cards[0], product: 'Vela inventada' }, draft().cards[1]] }), catalog, settings).errors.some(e => /no está en el Catálogo/.test(e)));
  assert.ok(normalizeDraft(draft({ dailyBudget: 25 }), catalog, settings).errors.some(e => /tope/.test(e)));
  assert.ok(normalizeDraft(draft({ cards: [draft().cards[0], { ...draft().cards[0], product: 'VELA LEONCITO' }] }), catalog, settings).errors.some(e => /dos veces/.test(e)));
  assert.ok(normalizeDraft(draft({ cards: draft().cards.slice(0, 1) }), catalog, settings).errors.some(e => /al menos 2/.test(e)), 'un carrusel de una sola tarjeta no pasa');
  assert.equal(normalizeDraft(draft({ format: 'single' }), catalog, settings).draft.cards.length, 1);
  assert.equal(normalizeDraft(draft({ audience: { ageMin: 22, ageMax: 40, gender: 'mujeres', advantage: true } }), catalog, settings).draft.audience.ageMax, 65, 'con Advantage+ la edad máxima la amplía Meta');
});

test('la revisión frena lo que Meta castiga y lo que rompe las reglas de la empresa', () => {
  const where = (d: AdDraft, idea = '') => reviewDraft(d, catalog, idea).filter(i => i.level === 'error').map(i => i.text).join(' | ');
  assert.equal(where(draft()), '', 'un anuncio normal pasa');
  assert.match(where(draft({ texts: ['¿Estás embarazada? Mira estas velas.'] })), /personal/);
  assert.match(where(draft({ texts: ['Velas para la futura mamá.'] })), /personal/);
  assert.match(where(draft({ texts: ['Comenta "quiero" y te mandamos el precio.'] })), /comenten/);
  assert.match(where(draft({ texts: ['Pídelas por WhatsApp.'] })), /no menciones WhatsApp/);
  assert.equal(where(draft({ destination: 'whatsapp', texts: ['Escríbenos por WhatsApp y te cotizamos.'] })), '', 'a WhatsApp sí se puede nombrar');
  assert.match(where(draft({ texts: ['Leoncito a solo $25 la docena.'] })), /\$25 no es de ningún producto/);
  assert.equal(where(draft({ texts: ['Leoncito $30.00 la docena, elefantito $45.'] })), '');
  const avisos = reviewDraft(draft({ texts: ['10% de descuento solo hoy en LEONCITOS PARA BABY SHOWER!!!'] }), catalog).filter(i => i.level === 'aviso').map(i => i.text).join(' | ');
  assert.match(avisos, /promoción/);
  assert.match(avisos, /urgencia/);
  assert.match(avisos, /MAYÚSCULAS/);
  assert.match(avisos, /signos/);
  assert.doesNotMatch(reviewDraft(draft({ texts: ['10% de descuento pagando con tarjeta en la web.'] }), catalog, 'Promo: 10% de descuento con tarjeta').map(i => i.text).join(' '), /promoción/, 'la promoción que dio la empresa no se cuestiona');
});

test('los enlaces llevan a la categoría o al producto en la web, o al WhatsApp de la empresa', () => {
  const web = linksFor(draft(), settings, catalog);
  assert.equal(web.main, 'https://www.velamia.shop/?categoria=baby-shower');
  assert.deepEqual(web.cards, ['https://www.velamia.shop/?categoria=baby-shower&producto=12', 'https://www.velamia.shop/?categoria=baby-shower&producto=13']);
  const mixed = linksFor(draft({ cards: [draft().cards[0], { product: 'VELA CALABAZA', image: 'https://crm/calabaza.jpg', title: 'Calabaza', description: '' }] }), settings, catalog);
  assert.equal(mixed.main, 'https://www.velamia.shop/');
  assert.equal(mixed.cards[1], 'https://www.velamia.shop/?categoria=halloween');
  const wa = linksFor(draft({ destination: 'whatsapp' }), settings, catalog);
  assert.equal(wa.main, 'https://wa.me/593997329187');
});

test('todo se crea en pausa, con el público elegido y sin mejoras automáticas de Meta', () => {
  assert.deepEqual(campaignParams(draft(), 'C'), { name: 'C', objective: 'OUTCOME_SALES', status: 'PAUSED', special_ad_categories: [], is_adset_budget_sharing_enabled: false });
  assert.equal(campaignParams(draft({ destination: 'whatsapp' }), 'C').objective, 'OUTCOME_ENGAGEMENT');
  const web: any = adsetParams(draft(), settings, '99', 'A');
  assert.equal(web.status, 'PAUSED');
  assert.equal(web.daily_budget, 300);
  assert.deepEqual(web.promoted_object, { pixel_id: '1462926855313741', custom_event_type: 'ADD_TO_CART' });
  assert.deepEqual(web.targeting.genders, [2]);
  assert.equal(web.targeting.targeting_automation.advantage_audience, 0);
  const wa: any = adsetParams(draft({ destination: 'whatsapp', audience: { ageMin: 18, ageMax: 65, gender: 'todos', advantage: false } }), settings, '99', 'A');
  assert.equal(wa.destination_type, 'WHATSAPP');
  assert.equal(wa.optimization_goal, 'CONVERSATIONS');
  assert.deepEqual(wa.promoted_object, { page_id: '1044219295441808', whatsapp_phone_number: '593997329187' });
  assert.equal(wa.targeting.genders, undefined, '"todos" no filtra por género');

  const links = linksFor(draft(), settings, catalog);
  const carousel: any = creativeParams(draft(), settings, ['h1', 'h2'], links, 'N');
  assert.equal(carousel.url_tags, URL_TAGS, 'la web sabe de qué anuncio llegó la visita');
  assert.equal(carousel.object_story_spec.instagram_user_id, '17841442983402082');
  assert.equal(carousel.object_story_spec.link_data.child_attachments.length, 2);
  assert.equal(carousel.object_story_spec.link_data.child_attachments[1].call_to_action.type, 'SHOP_NOW');
  assert.equal(carousel.asset_feed_spec, undefined);
  const single: any = creativeParams(draft({ format: 'single', texts: ['A', 'B'], headlines: ['T1', 'T2'] }), settings, ['h1'], links, 'N');
  assert.deepEqual(single.asset_feed_spec.bodies, [{ text: 'A' }, { text: 'B' }]);
  assert.equal(single.object_story_spec.link_data.image_hash, 'h1');
  assert.equal(creativeParams(draft({ format: 'single', texts: ['A', 'B'] }), settings, ['h1'], links, 'N', false).asset_feed_spec, undefined);
  const waCreative: any = creativeParams(draft({ destination: 'whatsapp' }), settings, ['h1', 'h2'], linksFor(draft({ destination: 'whatsapp' }), settings, catalog), 'N');
  assert.equal(waCreative.url_tags, undefined);
  assert.deepEqual(waCreative.object_story_spec.link_data.call_to_action, { type: 'WHATSAPP_MESSAGE', value: { app_destination: 'WHATSAPP' } });
  assert.ok(OPT_OUT_FEATURES.includes('advantage_plus_creative') && OPT_OUT_FEATURES.includes('text_generation') && !OPT_OUT_FEATURES.includes('standard_enhancements'), 'standard_enhancements ya no existe en la API');
});

test('los nombres siguen la forma de siempre y dicen que se crearon en el CRM', () => {
  const n = namesFor(draft(), 'VELAMIA', 'EC', new Date('2026-10-06T15:00:00Z'));
  assert.equal(n.campaign, 'VELAMIA | Baby Shower | Ventas Web | Oct2026 | CRM');
  assert.equal(n.adset, 'Mujeres 22-45 | EC | Web | Baby Shower Oct2026');
  assert.equal(n.ad, 'VELAMIA | Baby Shower Carrusel | Web | Oct2026');
});

test('la cuenta con saldo pendiente no deja crear y lo explica', () => {
  const h = accountHealth({ account_status: 3, balance: '869', currency: 'USD', min_daily_budget: 100 });
  assert.equal(h.canWrite, false);
  assert.match(h.problem, /saldo pendiente de \$8\.69/);
  assert.equal(accountHealth({ account_status: 1 }).canWrite, true);
  assert.match(metaMessage({ code: 200, error_subcode: 2490592 }), /estado/);
  assert.match(metaMessage({ code: 17 }), /esperar/);
  assert.match(metaMessage({ code: 100, error_user_title: 'Falta un campo', error_user_msg: 'El campo "link" es obligatorio.' }), /Falta un campo: El campo "link"/);
});

test('topes: lo activo por día y las acciones de hoy', () => {
  const item = (id: string, status: 'ACTIVE' | 'PAUSED', budget: number, at: string): CreatedAd => ({
    campaignId: id, adsetId: 'a' + id, adId: 'd' + id, creativeId: 'c', name: 'n', adName: 'n', destination: 'web', format: 'single', theme: 't', products: [], image: '',
    text: '', dailyBudget: budget, audience: { ageMin: 18, ageMax: 65, gender: 'todos', advantage: false }, status, createdAt: at, warnings: [],
    history: [{ at, action: 'crear', detail: '' }]
  });
  const list = [item('1', 'ACTIVE', 3, '2026-10-06T15:00:00Z'), item('2', 'ACTIVE', 4, '2026-10-05T15:00:00Z'), item('3', 'PAUSED', 9, '2026-10-06T16:00:00Z')];
  assert.equal(activeDaily(list), 7);
  assert.equal(activeDaily(list, '2'), 3);
  assert.equal(actionsToday(list, 'America/Guayaquil', new Date('2026-10-06T20:00:00Z'), 'crear'), 2);
});

test('lo que se ve en vivo: estado, motivo de rechazo y resultados sin contar dos veces', () => {
  const l = liveFrom(
    { effective_status: 'DISAPPROVED', ad_review_feedback: { global: { Política: 'Atributos personales' } }, adset: { daily_budget: '300' } },
    { spend: '1.20', actions: [{ action_type: 'offsite_conversion.fb_pixel_add_to_cart', value: '2' }, { action_type: 'add_to_cart', value: '2' }] },
    { spend: '10.5', impressions: '1200', inline_link_clicks: '40', actions: [{ action_type: 'omni_add_to_cart', value: '7' }, { action_type: 'add_to_cart', value: '7' }] },
    'web'
  );
  assert.equal(l.statusLabel, 'Rechazado por Meta');
  assert.deepEqual(l.reasons, ['Atributos personales']);
  assert.equal(l.budget, 3);
  assert.equal(l.resultsToday, 2);
  assert.equal(l.results, 7);
  assert.equal(liveFrom({}, null, { actions: [{ action_type: 'onsite_conversion.messaging_conversation_started_7d', value: '5' }] }, 'whatsapp').results, 5);
});

test('de la propuesta de la IA solo quedan productos reales y los textos que pasan las reglas', () => {
  const out = buildProposal({
    tema: 'Baby Shower', formato: 'carousel', productos: ['VELA ELEFANTITO', 'Vela que no existe', 'vela leoncito'],
    textos: ['¿Estás embarazada? Te encantarán.', 'Recuerdos hechos a mano para baby shower. Leoncito $30 la docena.'], titulos: ['Leoncito $30'], descripcion: 'Hechas a mano',
    tarjetas: [{ producto: 'VELA LEONCITO', titulo: 'Leoncito $30 la docena', descripcion: 'Con empaque' }], edad_min: 22, edad_max: 45, genero: 'mujeres', presupuesto: 50, explicacion: ''
  }, { destination: 'web', chosen: [], catalog, settings, wantFormat: 'auto', idea: '' });
  assert.deepEqual(out.draft.cards.map(c => c.product), ['VELA ELEFANTITO', 'VELA LEONCITO']);
  assert.equal(out.draft.cards[1].title, 'Leoncito $30 la docena');
  assert.deepEqual(out.draft.texts, ['Recuerdos hechos a mano para baby shower. Leoncito $30 la docena.'], 'el texto con un atributo personal se quita');
  assert.equal(out.draft.dailyBudget, 3, 'un presupuesto sobre el tope vuelve a $3');
  assert.equal(out.draft.audience.gender, 'mujeres');
  const one = buildProposal({ ...({} as any), tema: 'x', formato: 'carousel', productos: ['VELA CALABAZA'], textos: ['Calabazas $32'], titulos: ['t'], descripcion: '', tarjetas: [], edad_min: 18, edad_max: 65, genero: 'todos', presupuesto: 3, explicacion: '' },
    { destination: 'web', chosen: [], catalog, settings, wantFormat: 'auto', idea: '' });
  assert.equal(one.draft.format, 'single', 'con un solo producto no hay carrusel');
});

test('dos productos con el mismo nombre no se confunden: manda el id', () => {
  const twins: PickProduct[] = [
    { ...catalog[0], id: 'a', name: 'VELA FANTASMA 2', price: 30, images: ['https://crm/fantasma.jpg'] },
    { ...catalog[0], id: 'b', name: 'VELA FANTASMA 2', price: 35, images: ['https://crm/pollito.png'] }
  ];
  const one = normalizeDraft(draft({ format: 'single', cards: [{ productId: 'a', product: 'VELA FANTASMA 2', image: 'https://crm/fantasma.jpg', title: 'Fantasma', description: '' }] }), twins, settings);
  assert.deepEqual(one.errors, []);
  assert.equal(one.draft.cards[0].productId, 'a');
  const wrong = normalizeDraft(draft({ format: 'single', cards: [{ productId: 'a', product: 'VELA FANTASMA 2', image: 'https://crm/pollito.png', title: 'x', description: '' }] }), twins, settings);
  assert.ok(wrong.errors.some(e => /Elige una foto/.test(e)), 'la foto del otro producto con el mismo nombre no pasa');
});
