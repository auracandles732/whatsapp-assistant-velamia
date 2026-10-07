import axios from 'axios';
import { getConfig, setConfig, getAllProducts } from './supabase';
import { currentTenant } from './tenant';
import { profile } from '../config/businessProfile';
import { plain, localParts } from '../social/posts';
import { toInstagramJpeg, ImageKind, isOwnStorageUrl } from '../social/images';
import { askSocialJson, getSocialAi } from '../social/ai';
import { unitOf } from './openai';
import { adsAccess, rememberCreatedAd, adResults } from './ads';
import { slugOf, slugMapFrom, webDisplayName } from './webCatalog';

/**
 * Crear anuncios de Meta desde el CRM (para todas las empresas), solo con la API oficial de Meta (Marketing API) y el
 * token de la cuenta publicitaria conectada en Anuncios. La IA del agente de redes propone el anuncio con productos del
 * Catálogo (fotos y precios reales); la empresa lo revisa y lo crea. Reglas para no tener problemas con Meta:
 *  - Todo se crea EN PAUSA y pasa por la revisión normal de Meta. Nada gasta hasta que la empresa toca "Activar".
 *  - Los textos se revisan antes de crear (políticas de publicidad: atributos personales, cebo de interacción, precios
 *    que no son del catálogo, promociones inventadas). Con un error, no se crea.
 *  - Tope de gasto por día para todo lo creado desde el CRM, pocos anuncios nuevos por día y pocos cambios de
 *    presupuesto: nada en masa.
 *  - Las mejoras automáticas de Meta (Advantage+ creativo) van apagadas: el anuncio sale como se vio aquí.
 * Solo se manejan (activar, pausar, presupuesto) las campañas creadas desde el CRM; las demás solo se miran.
 */

const GRAPH = 'https://graph.facebook.com/v25.0';
const SETTINGS_KEY = 'ad_builder';
const CREATED_KEY = 'ad_builder_created';

export const MAX_CREATED_PER_DAY = 5;
export const MAX_BUDGET_CHANGES_PER_DAY = 4;
export const MAX_ACTIONS_PER_DAY = 30;

// Enlace de los anuncios a la web: la web lee de qué anuncio llegó la visita (y lo pasa a la referencia de WhatsApp).
export const URL_TAGS = 'utm_source=meta&utm_medium=paid&utm_campaign={{campaign.name}}&utm_content={{ad.name}}&ad_id={{ad.id}}&campaign_id={{campaign.id}}&adset_id={{adset.id}}';

// Mejoras automáticas de Meta que van apagadas en cada anuncio (si Meta rechaza alguna, se quita y se reintenta).
export const OPT_OUT_FEATURES = [
  'adapt_to_placement', 'add_text_overlay', 'ads_with_benefits', 'advantage_plus_creative', 'app_highlights', 'audio', 'auto_promotion_tag', 'biz_ai',
  'carousel_to_video', 'catalog_feed_tag', 'creative_stickers', 'customize_product_recommendation', 'cv_transformation', 'description_automation',
  'dha_optimization', 'dynamic_cta_text', 'dynamic_partner_content', 'enable_ncs_testimonials', 'enhance_cta', 'fb_feed_tag', 'fb_reels_tag',
  'fb_story_tag', 'feed_caption_optimization', 'generate_cta', 'hide_price', 'hyperlink_formatting', 'ig_feed_tag', 'ig_glados_feed', 'ig_reels_tag',
  'ig_stream_tag', 'ig_video_native_subtitle', 'image_animation', 'image_auto_crop', 'image_background_gen', 'image_banner',
  'image_brightness_and_contrast', 'image_end_card', 'image_enhancement', 'image_templates', 'image_text_translation', 'image_touchups',
  'image_uncrop', 'inline_comment', 'local_store_extension', 'media_liquidity_animated_image', 'media_order', 'media_type_automation',
  'multi_creative_post_carousel', 'multi_photo_to_video', 'music_generation', 'pac_genai_recomposition', 'pac_recomposition', 'pac_relaxation',
  'product_browsing', 'product_extensions', 'product_metadata_automation', 'product_tags', 'profile_card', 'profile_extension', 'replace_media_text',
  'reveal_details_over_time', 'show_destination_blurbs', 'show_summary', 'site_extensions', 'standard_enhancements_catalog',
  'text_extraction_for_headline', 'text_extraction_for_tap_target', 'text_formatting_optimization', 'text_generation', 'text_optimizations',
  'text_overlay_translation', 'text_translation', 'translate_voiceover', 'video_auto_crop', 'video_filtering', 'video_highlight', 'video_highlights',
  'video_to_image', 'video_uncrop', 'video_uncrop_9x16_to_9x18', 'wa_mm_image_filtering', 'wa_mm_text_truncation_length'
];

// ---------- Ajustes de la empresa ----------

export type Gender = 'mujeres' | 'hombres' | 'todos';
export interface Audience { ageMin: number; ageMax: number; gender: Gender; advantage: boolean }
export const WEB_EVENTS = ['ADD_TO_CART', 'INITIATED_CHECKOUT', 'PURCHASE'] as const;

export interface BuilderSettings {
  pageId: string; pageName: string; instagramId: string; instagramName: string; pixelId: string; pixelName: string;
  /** Número de WhatsApp de los anuncios a WhatsApp (debe estar unido a la página de Facebook). */
  whatsappNumber: string;
  /** Página web de la tienda (https). */
  webUrl: string;
  /** Lo que se optimiza en los anuncios a la web (evento del píxel). */
  webEvent: typeof WEB_EVENTS[number];
  country: string;
  /** Tope por día (US$) de todo lo activo creado desde el CRM. */
  maxDaily: number;
  audience: Audience;
}

const COUNTRIES: Record<string, string> = {
  ecuador: 'EC', colombia: 'CO', peru: 'PE', mexico: 'MX', chile: 'CL', argentina: 'AR', bolivia: 'BO', venezuela: 'VE', panama: 'PA',
  'costa rica': 'CR', guatemala: 'GT', espana: 'ES', 'estados unidos': 'US', uruguay: 'UY', paraguay: 'PY', 'republica dominicana': 'DO'
};

const digitsOf = (v: unknown, min: number, max: number) => {
  const d = String(v ?? '').replace(/\D/g, '');
  return d.length >= min && d.length <= max ? d : '';
};
const clampInt = (v: unknown, min: number, max: number, fallback: number) => {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
};
const money = (v: unknown, min: number, max: number, fallback: number) => {
  const n = Math.round(Number(v) * 100) / 100;
  return Number.isFinite(n) && n >= min && n <= max ? n : fallback;
};
const short = (v: unknown, max: number) => String(v ?? '').replace(/[\u0000-\u0009\u000b-\u001f]/g, '').trim().slice(0, max);

export function normalizeShopUrl(value: unknown): string {
  const raw = String(value ?? '').trim().replace(/\/+$/, '');
  try {
    const u = new URL(raw);
    return u.protocol === 'https:' && !u.search && !u.hash ? u.toString().replace(/\/+$/, '') : '';
  } catch {
    return '';
  }
}

export function normalizeAudience(raw: any, fallback?: Audience): Audience {
  const base = fallback || { ageMin: 18, ageMax: 65, gender: 'todos' as Gender, advantage: false };
  const r = raw && typeof raw === 'object' ? raw : {};
  const ageMin = clampInt(r.ageMin, 18, 64, base.ageMin);
  const ageMax = clampInt(r.ageMax, ageMin + 1, 65, Math.max(base.ageMax, ageMin + 1));
  const gender: Gender = ['mujeres', 'hombres', 'todos'].includes(r.gender) ? r.gender : base.gender;
  return { ageMin, ageMax, gender, advantage: typeof r.advantage === 'boolean' ? r.advantage : base.advantage };
}

export function normalizeSettings(raw: any): BuilderSettings {
  const r = raw && typeof raw === 'object' ? raw : {};
  const country = /^[A-Z]{2}$/.test(String(r.country || '')) ? String(r.country) : (COUNTRIES[plain(profile().business.country || '')] || 'EC');
  return {
    pageId: digitsOf(r.pageId, 5, 30), pageName: short(r.pageName, 120), instagramId: digitsOf(r.instagramId, 5, 30), instagramName: short(r.instagramName, 120),
    pixelId: digitsOf(r.pixelId, 5, 30), pixelName: short(r.pixelName, 120), whatsappNumber: digitsOf(r.whatsappNumber, 8, 15),
    webUrl: normalizeShopUrl(r.webUrl), webEvent: WEB_EVENTS.includes(r.webEvent) ? r.webEvent : 'ADD_TO_CART', country,
    maxDaily: money(r.maxDaily, 1, 500, 10), audience: normalizeAudience(r.audience)
  };
}

export async function readBuilderSettings(): Promise<BuilderSettings> {
  try {
    const raw = await getConfig(SETTINGS_KEY);
    return normalizeSettings(raw ? JSON.parse(raw) : {});
  } catch {
    return normalizeSettings({});
  }
}

export async function saveBuilderSettings(input: any): Promise<BuilderSettings> {
  const current = await readBuilderSettings();
  const next = normalizeSettings({ ...current, ...(input && typeof input === 'object' ? input : {}), audience: { ...current.audience, ...(input?.audience || {}) } });
  if (input?.webUrl !== undefined && String(input.webUrl).trim() && !next.webUrl) throw new Error('La página web debe empezar con https:// (por ejemplo https://www.mitienda.com).');
  if (input?.whatsappNumber !== undefined && String(input.whatsappNumber).trim() && !next.whatsappNumber) throw new Error('El número de WhatsApp va con código de país y sin signos (por ejemplo 593991234567).');
  await setConfig(SETTINGS_KEY, JSON.stringify(next));
  overviewCache.clear();
  return next;
}

/** Lo que falta para poder crear anuncios a cada destino. */
export function missingFor(s: BuilderSettings, destination: 'web' | 'whatsapp'): string[] {
  const out: string[] = [];
  if (!s.pageId) out.push('la página de Facebook');
  if (destination === 'web' && !s.webUrl) out.push('la dirección de tu página web');
  if (destination === 'web' && !s.pixelId) out.push('el píxel de Meta de tu web');
  if (destination === 'whatsapp' && !s.whatsappNumber) out.push('el número de WhatsApp de los anuncios');
  return out;
}

// ---------- Meta (API oficial) ----------

export class MetaError extends Error {
  constructor(message: string, public meta: any = null) { super(message); }
}

/** El error de Meta en palabras simples (Meta ya manda el detalle en el idioma de la cuenta). */
export function metaMessage(error: any): string {
  const code = Number(error?.code);
  const sub = Number(error?.error_subcode);
  const accountStatus = Number(error?.error_data?.ad_account_status || 0);
  if (code === 190) return 'El token de anuncios venció o no es válido: genera uno nuevo en Meta y cámbialo en "Cuenta publicitaria de Meta".';
  if ([4, 17, 32, 613].includes(code) || (code >= 80000 && code <= 80014)) return 'Meta pidió esperar un poco (límite de uso de su sistema). Intenta de nuevo en 10 minutos: no es un problema de tu cuenta.';
  if (sub === 2490592 || (accountStatus && accountStatus !== 1 && accountStatus !== 9)) return 'Meta no deja crear ni editar anuncios en esta cuenta por su estado (por ejemplo, un saldo pendiente). Resuélvelo en Meta → Facturación y vuelve a intentar.';
  const user = [error?.error_user_title, error?.error_user_msg].filter(Boolean).join(': ');
  if (user) return user.slice(0, 400);
  if (code === 200 || code === 10) return 'El token no tiene permiso para crear anuncios en esta cuenta (necesita ads_management).';
  return String(error?.message || 'Meta no respondió').slice(0, 300);
}

async function call(method: 'GET' | 'POST' | 'DELETE', path: string, token: string, params?: Record<string, unknown>, timeoutMs = 30_000): Promise<any> {
  let body: URLSearchParams | undefined;
  if (params) {
    body = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) if (v !== undefined) body.set(k, typeof v === 'string' ? v : JSON.stringify(v));
  }
  const res = await fetch(`${GRAPH}/${path}`, { method, headers: { Authorization: `Bearer ${token}` }, body, signal: AbortSignal.timeout(timeoutMs) });
  const data: any = await res.json().catch(() => ({}));
  if (!res.ok || data?.error) throw new MetaError(metaMessage(data?.error), data?.error || null);
  return data;
}

const graphGet = (path: string, token: string) => call('GET', path, token);
const graphPost = (path: string, token: string, params: Record<string, unknown>, timeoutMs?: number) => call('POST', path, token, params, timeoutMs);

async function access() {
  const a = await adsAccess();
  if (!a) throw new Error('Conecta primero la cuenta publicitaria de Meta (más abajo, en "Cuenta publicitaria de Meta").');
  return a;
}

// ---------- Estado de la cuenta publicitaria ----------

const ACCOUNT_STATUS: Record<number, string> = {
  1: 'Activa', 2: 'Deshabilitada por Meta', 3: 'Saldo pendiente', 7: 'En revisión de Meta', 8: 'Pago pendiente', 9: 'Periodo de gracia', 100: 'Por cerrarse', 101: 'Cerrada'
};

export interface AccountHealth { status: number; label: string; canWrite: boolean; problem: string; balance: number; currency: string; name: string; minDaily: number }

export function accountHealth(a: any): AccountHealth {
  const status = Number(a?.account_status || 0);
  const balance = Math.round(Number(a?.balance || 0)) / 100;
  const canWrite = status === 1 || status === 9;
  let problem = '';
  if (status === 3 || status === 8) problem = `Tu cuenta publicitaria tiene un saldo pendiente${balance > 0 ? ` de $${balance.toFixed(2)}` : ''}. Meta no deja crear ni editar anuncios hasta que lo pagues: en Meta entra a Facturación y toca "Pagar ahora".`;
  else if (status === 2) problem = 'Meta deshabilitó tu cuenta publicitaria. Revisa el aviso en Meta (Calidad de la cuenta): desde aquí no se crea nada hasta que Meta la reactive.';
  else if (status === 7) problem = 'Meta está revisando tu cuenta publicitaria. Espera a que termine antes de crear anuncios.';
  else if (status === 100 || status === 101) problem = 'La cuenta publicitaria está cerrada o por cerrarse.';
  else if (!canWrite) problem = 'La cuenta publicitaria no está activa en Meta.';
  return {
    status, label: ACCOUNT_STATUS[status] || (status ? `Estado ${status}` : 'Sin datos'), canWrite, problem, balance, currency: String(a?.currency || 'USD'),
    name: String(a?.name || ''), minDaily: Math.max(1, Number(a?.min_daily_budget || 100) / 100)
  };
}

async function readAccount(token: string, accountId: string): Promise<AccountHealth> {
  return accountHealth(await graphGet(`${accountId}?fields=name,account_status,balance,currency,min_daily_budget`, token));
}

/** Página, Instagram, píxel y número de WhatsApp que ya usa la cuenta: llena lo que falte en los ajustes. */
export async function detectSetup() {
  const { token, accountId } = await access();
  const s = await readBuilderSettings();
  const [pages, pixels, adsets] = await Promise.all([
    graphGet('me/accounts?fields=id,name,instagram_business_account{id,username}&limit=50', token).catch(() => ({ data: [] })),
    graphGet(`${accountId}/adspixels?fields=id,name,last_fired_time&limit=50`, token).catch(() => ({ data: [] })),
    graphGet(`${accountId}/adsets?fields=promoted_object,destination_type,created_time&limit=50`, token).catch(() => ({ data: [] }))
  ]);
  const pageList = (pages.data || []).map((p: any) => ({ id: String(p.id), name: String(p.name || ''), instagramId: String(p.instagram_business_account?.id || ''), instagramName: String(p.instagram_business_account?.username || '') }));
  const pixelList = (pixels.data || []).map((p: any) => ({ id: String(p.id), name: String(p.name || ''), lastFired: String(p.last_fired_time || '') }))
    .sort((a: any, b: any) => b.lastFired.localeCompare(a.lastFired));
  const used = (adsets.data || []).map((a: any) => a.promoted_object || {});
  const usedPage = used.find((o: any) => o.page_id)?.page_id;
  const page = pageList.find((p: any) => p.id === (s.pageId || usedPage)) || pageList[0];
  const whatsapp = used.find((o: any) => o.whatsapp_phone_number)?.whatsapp_phone_number;
  const pixel = pixelList.find((p: any) => p.id === (s.pixelId || used.find((o: any) => o.pixel_id)?.pixel_id)) || pixelList[0];
  const next = await saveBuilderSettings({
    pageId: s.pageId || page?.id || '', pageName: page?.name || s.pageName, instagramId: s.instagramId || page?.instagramId || '',
    instagramName: page?.instagramName || s.instagramName, pixelId: s.pixelId || pixel?.id || '', pixelName: pixel?.name || s.pixelName,
    whatsappNumber: s.whatsappNumber || whatsapp || ''
  });
  return { settings: next, pages: pageList, pixels: pixelList };
}

// ---------- Productos para el anuncio ----------

export interface PickProduct {
  id: string; name: string; price: number; unit: string; category: string; description: string; images: string[]; webId: number | null; webCategory: string;
  /** Cómo se dice en un anuncio: el nombre de la web o el del Catálogo sin mayúsculas ("Vela de Angelito"). */
  displayName?: string;
}

// Solo fotos del almacenamiento propio del CRM (las que el CRM puede mostrar y descargar), en JPG o PNG.
const photoOk = (url: string) => isOwnStorageUrl(url) && /\.(jpe?g|png)(\?|$)/i.test(url);

/** El Catálogo con lo que necesita un anuncio: precio, unidad, fotos usables (del CRM, JPG o PNG) y su lugar en la web. */
export async function adCatalog(): Promise<PickProduct[]> {
  const products: any[] = await getAllProducts().catch(() => []);
  const slugs = slugMapFrom(products);
  const p = profile();
  return products.filter(x => x?.name && Number(x.price) > 0).map(x => {
    const images = [...new Set([String(x.image_url || ''), ...((x.web?.images as string[]) || [])])].filter(photoOk).slice(0, 6);
    return {
      id: String(x.id), name: String(x.name), displayName: webDisplayName(x), price: Number(x.price), unit: unitOf(x, p),
      category: String(x.category || ''), description: short(x.description, 200),
      images, webId: x.web && Number.isFinite(Number(x.web.id)) && x.web.id !== null ? Number(x.web.id) : null,
      webCategory: x.web ? (x.web.category || slugOf(String(x.category || ''), slugs)) : slugOf(String(x.category || ''), slugs)
    };
  });
}

// ---------- El anuncio (borrador) ----------

/** Una tarjeta del anuncio: el producto (por su id del Catálogo; el nombre también sirve si no se repite), su foto y textos. */
export interface AdCard { productId?: string; product: string; image: string; title: string; description: string }

/** Busca un producto del Catálogo por su id o, si no viene, por su nombre. */
export function finder(catalog: PickProduct[]) {
  const byId = new Map(catalog.map(p => [p.id, p]));
  const byName = new Map(catalog.map(p => [plain(p.name), p]));
  return (id: unknown, name?: unknown): PickProduct | undefined => byId.get(String(id ?? '')) || (name !== undefined ? byName.get(plain(name)) : byName.get(plain(id)));
}
export interface AdDraft {
  destination: 'web' | 'whatsapp';
  format: 'single' | 'carousel';
  /** Tema corto para los nombres de la campaña ("Halloween"). */
  theme: string;
  /** Textos principales (Meta prueba hasta 5 en el anuncio de una foto; el carrusel usa el primero). */
  texts: string[];
  /** Títulos del anuncio de una foto (hasta 5). */
  headlines: string[];
  description: string;
  /** Una tarjeta (anuncio de una foto) o de 2 a 10 (carrusel). */
  cards: AdCard[];
  dailyBudget: number;
  audience: Audience;
}

const LIMITS = { text: 600, headline: 80, description: 80, card: 80, theme: 40 };

const uniqueTexts = (list: unknown, max: number, size: number) =>
  [...new Set((Array.isArray(list) ? list : []).map(t => short(t, size)).filter(Boolean))].slice(0, max);

/** Ordena y revisa lo que manda el CRM: productos del Catálogo, fotos de esos productos y límites. */
export function normalizeDraft(raw: any, catalog: PickProduct[], s: BuilderSettings): { draft: AdDraft; errors: string[] } {
  const r = raw && typeof raw === 'object' ? raw : {};
  const errors: string[] = [];
  const destination = r.destination === 'whatsapp' ? 'whatsapp' : 'web';
  const format = r.format === 'carousel' ? 'carousel' : 'single';
  const find = finder(catalog);
  const cards: AdCard[] = [];
  for (const c of Array.isArray(r.cards) ? r.cards.slice(0, 10) : []) {
    const product = find(c?.productId, c?.product);
    if (!product) { errors.push(`"${short(c?.product, 60)}" no está en el Catálogo.`); continue; }
    const image = String(c?.image || '');
    if (!product.images.includes(image)) { errors.push(`Elige una foto de ${product.name} (de su ficha en el Catálogo).`); continue; }
    if (cards.some(x => x.image === image)) { errors.push(`La foto de ${product.name} está dos veces: cada tarjeta lleva una foto distinta.`); continue; }
    cards.push({ productId: product.id, product: product.name, image, title: short(c?.title, LIMITS.card) || product.name, description: short(c?.description, LIMITS.card) });
  }
  const draft: AdDraft = {
    destination, format, theme: short(r.theme, LIMITS.theme) || 'Anuncio',
    texts: uniqueTexts(r.texts, 5, LIMITS.text), headlines: uniqueTexts(r.headlines, 5, LIMITS.headline), description: short(r.description, LIMITS.description),
    cards: format === 'single' ? cards.slice(0, 1) : cards, dailyBudget: Math.round(Number(r.dailyBudget) * 100) / 100,
    audience: normalizeAudience(r.audience, s.audience)
  };
  if (draft.audience.advantage) draft.audience.ageMax = 65;
  if (!draft.texts.length) errors.push('Falta el texto principal del anuncio.');
  if (format === 'single' && !draft.headlines.length) errors.push('Falta el título del anuncio.');
  if (format === 'single' && draft.cards.length < 1) errors.push('Elige el producto y la foto del anuncio.');
  if (format === 'carousel' && draft.cards.length < 2) errors.push('El carrusel necesita al menos 2 tarjetas (productos con foto).');
  if (!Number.isFinite(draft.dailyBudget) || draft.dailyBudget < 1) errors.push('El presupuesto diario mínimo es $1.');
  else if (draft.dailyBudget > s.maxDaily) errors.push(`El presupuesto diario ($${draft.dailyBudget.toFixed(2)}) pasa tu tope de $${s.maxDaily.toFixed(2)} por día. Súbelo en Ajustes si de verdad quieres gastar más.`);
  return { draft, errors };
}

// ---------- Revisión con las reglas de publicidad de Meta ----------

export interface Issue { level: 'error' | 'aviso'; where: string; text: string }

// Palabras completas con (?<!\p{L}) y (?!\p{L}): el \b de JavaScript no reconoce "á" ni "ú" como letras.
const PERSONAL = [
  /(?<!\p{L})(?:est[aá]s|eres|vas a ser|te sientes|sufres|padeces)(?!\p{L})[^.!?\n]{0,30}(?<!\p{L})(?:embarazad\p{L}*|solter\p{L}*|divorciad\p{L}*|viud\p{L}*|gord\p{L}*|obes\p{L}*|deprimid\p{L}*|ansios\p{L}*|endeudad\p{L}*|desemplead\p{L}*|enferm\p{L}*|diab[eé]tic\p{L}*|gay|lesbiana|cristian[oa]s?|cat[oó]lic[oa]s?|evang[eé]lic[oa]s?|mam[aá] primeriza)(?!\p{L})/iu,
  /(?<!\p{L})(?:tu embarazo|tus deudas|tu enfermedad|tu peso|tu religi[oó]n|tu divorcio|futura mam[aá]|mam[aá] primeriza)(?!\p{L})/iu
];
const BAIT = /(?<!\p{L})(?:comenta|comenten|comp[aá]rte(?:lo|la|nos)?|etiqueta a|etiqueten|dale (?:like|me gusta)|reacciona con)(?!\p{L})/iu;
const PROMO = /\d+\s?%|(?<!\p{L})(?:descuentos?|gratis|ofertas?|promo|promoci[oó]n|promociones|2\s?x\s?1|rebajas?|liquidaci[oó]n)(?!\p{L})/iu;
const URGENCY = /(?<!\p{L})(?:[uú]ltimas? unidades|solo hoy|por tiempo limitado|se acaban?|quedan poc[oa]s|[uú]ltimo d[ií]a)(?!\p{L})/iu;
const ABSOLUTE = /#1(?!\d)|(?<!\p{L})(?:garantizad[oa]s?|el mejor del (?:pa[ií]s|ecuador|mundo)|n[uú]mero 1)(?![\p{L}\d])/iu;
const META_BRANDS = /(?<!\p{L})(?:facebook|instagram|meta)(?!\p{L})/iu;
const WHATSAPP_WORDS = /(?<!\p{L})(?:whats\s?app|wa\.me|wsp|inbox)(?!\p{L})/iu;
const EMOJI = /\p{Extended_Pictographic}/gu;

const pricesIn = (text: string) => [...text.matchAll(/\$\s?(\d{1,5}(?:[.,]\d{1,2})?)/g)].map(m => Number(m[1].replace(',', '.')));

/**
 * Revisa los textos del anuncio con las reglas de publicidad de Meta y las de la empresa. Los "error" impiden crearlo; los
 * "aviso" se muestran para que la empresa decida. Sin efectos.
 */
export function reviewDraft(d: AdDraft, catalog: PickProduct[], idea = ''): Issue[] {
  const issues: Issue[] = [];
  const add = (level: Issue['level'], where: string, text: string) => {
    if (!issues.some(i => i.where === where && i.text === text)) issues.push({ level, where, text });
  };
  const inAd = new Set(d.cards.map(c => plain(c.product)));
  const allowed = new Set<number>([...catalog.filter(p => inAd.has(plain(p.name))).map(p => p.price), ...pricesIn(idea)].map(n => Math.round(n * 100)));
  const pieces: [string, string][] = [
    ...d.texts.map((t, i): [string, string] => [`Texto ${i + 1}`, t]),
    ...(d.format === 'single' ? d.headlines.map((t, i): [string, string] => [`Título ${i + 1}`, t]) : []),
    ...(d.format === 'single' && d.description ? [['Descripción', d.description] as [string, string]] : []),
    ...(d.format === 'carousel' ? d.cards.flatMap((c, i): [string, string][] => [[`Tarjeta ${i + 1}`, `${c.title}\n${c.description}`]]) : [])
  ];
  for (const [where, text] of pieces) {
    if (PERSONAL.some(re => re.test(text))) add('error', where, 'Meta no permite suponer algo personal de quien ve el anuncio (embarazo, salud, religión, estado civil, dinero…). Habla del producto o de la ocasión.');
    if (BAIT.test(text)) add('error', where, 'Meta castiga pedir que comenten, compartan, etiqueten o den like. Invita a ver o pedir el producto.');
    if (d.destination === 'web' && WHATSAPP_WORDS.test(text)) add('error', where, 'Este anuncio lleva a la web: no menciones WhatsApp.');
    for (const price of pricesIn(text)) {
      if (!allowed.has(Math.round(price * 100))) add('error', where, `El precio $${price} no es de ningún producto de este anuncio en el Catálogo.`);
    }
    if (PROMO.test(text) && !PROMO.test(idea)) add('aviso', where, 'Habla de una promoción o descuento: confirma que es real (Meta rechaza anuncios engañosos).');
    if (URGENCY.test(text) && !URGENCY.test(idea)) add('aviso', where, 'Usa urgencia ("últimas unidades", "solo hoy"): úsala solo si es verdad.');
    if (ABSOLUTE.test(text)) add('aviso', where, 'Las promesas absolutas ("garantizado", "el mejor") pueden ser rechazadas por Meta.');
    if (META_BRANDS.test(text)) add('aviso', where, 'Mejor no nombrar Facebook, Instagram ni Meta en el texto.');
    if ((text.match(/\b[A-ZÁÉÍÓÚÑ]{4,}\b/g) || []).length >= 3) add('aviso', where, 'Muchas palabras en MAYÚSCULAS: Meta lo ve poco profesional.');
    if (/[!?¡¿]{3,}/.test(text)) add('aviso', where, 'Demasiados signos seguidos (!!!).');
    if ((text.match(EMOJI) || []).length > 6) add('aviso', where, 'Demasiados emojis.');
  }
  if (d.format === 'single') d.headlines.forEach((t, i) => { if (t.length > 40) add('aviso', `Título ${i + 1}`, 'Pasa de 40 letras: en el celular se puede cortar.'); });
  return issues;
}

// ---------- Lo que se manda a Meta (sin efectos) ----------

const MONTHS = ['Ene', 'Feb', 'Mar', 'Abr', 'May', 'Jun', 'Jul', 'Ago', 'Sep', 'Oct', 'Nov', 'Dic'];

export function namesFor(d: AdDraft, businessName: string, country: string, now = new Date(), timeZone = 'America/Guayaquil') {
  const p = localParts(now, timeZone);
  const tag = `${MONTHS[p.month - 1]}${p.year}`;
  const where = d.destination === 'web' ? 'Web' : 'WhatsApp';
  const who = d.audience.gender === 'mujeres' ? 'Mujeres' : d.audience.gender === 'hombres' ? 'Hombres' : 'Todos';
  const theme = d.theme.replace(/\|/g, ' ').trim();
  return {
    campaign: `${businessName} | ${theme} | ${d.destination === 'web' ? 'Ventas Web' : 'WhatsApp'} | ${tag} | CRM`,
    adset: `${who} ${d.audience.ageMin}-${d.audience.ageMax} | ${country} | ${where} | ${theme} ${tag}`,
    ad: `${businessName} | ${theme} ${d.format === 'carousel' ? 'Carrusel' : 'Foto'} | ${where} | ${tag}`
  };
}

/** Enlaces del anuncio: a la web (categoría o producto) o al WhatsApp de la empresa. */
export function linksFor(d: AdDraft, s: BuilderSettings, catalog: PickProduct[]): { main: string; cards: string[] } {
  if (d.destination === 'whatsapp') {
    const wa = `https://wa.me/${s.whatsappNumber}`;
    return { main: wa, cards: d.cards.map(() => wa) };
  }
  const find = finder(catalog);
  const products = d.cards.map(c => find(c.productId, c.product));
  const categories = [...new Set(products.map(p => p?.webCategory).filter(Boolean))];
  const main = categories.length === 1 ? `${s.webUrl}/?categoria=${encodeURIComponent(categories[0]!)}` : `${s.webUrl}/`;
  const cards = products.map(p => {
    const q = [p?.webCategory ? `categoria=${encodeURIComponent(p.webCategory)}` : '', p?.webId ? `producto=${p.webId}` : ''].filter(Boolean).join('&');
    return q ? `${s.webUrl}/?${q}` : main;
  });
  return { main: d.format === 'single' ? cards[0] || main : main, cards };
}

export function campaignParams(d: AdDraft, name: string) {
  return { name, objective: d.destination === 'web' ? 'OUTCOME_SALES' : 'OUTCOME_ENGAGEMENT', status: 'PAUSED', special_ad_categories: [], is_adset_budget_sharing_enabled: false };
}

export function adsetParams(d: AdDraft, s: BuilderSettings, campaignId: string, name: string) {
  const targeting: Record<string, unknown> = {
    age_min: d.audience.ageMin, age_max: d.audience.ageMax,
    geo_locations: { countries: [s.country], location_types: ['home', 'recent'] },
    targeting_automation: { advantage_audience: d.audience.advantage ? 1 : 0 }
  };
  if (d.audience.gender !== 'todos') targeting.genders = [d.audience.gender === 'mujeres' ? 2 : 1];
  const base = {
    name, campaign_id: campaignId, status: 'PAUSED', daily_budget: Math.round(d.dailyBudget * 100), billing_event: 'IMPRESSIONS',
    bid_strategy: 'LOWEST_COST_WITHOUT_CAP', targeting
  };
  return d.destination === 'web'
    ? { ...base, optimization_goal: 'OFFSITE_CONVERSIONS', promoted_object: { pixel_id: s.pixelId, custom_event_type: s.webEvent }, attribution_spec: [{ event_type: 'CLICK_THROUGH', window_days: 7 }] }
    : { ...base, optimization_goal: 'CONVERSATIONS', destination_type: 'WHATSAPP', promoted_object: { page_id: s.pageId, whatsapp_phone_number: s.whatsappNumber } };
}

export function creativeParams(d: AdDraft, s: BuilderSettings, hashes: string[], links: { main: string; cards: string[] }, name: string, withTextOptions = true) {
  const web = d.destination === 'web';
  const cta = (link: string) => (web ? { type: 'SHOP_NOW', value: { link } } : { type: 'WHATSAPP_MESSAGE', value: { app_destination: 'WHATSAPP' } });
  const spec: Record<string, any> = { page_id: s.pageId };
  if (s.instagramId) spec.instagram_user_id = s.instagramId;
  if (d.format === 'carousel') {
    spec.link_data = {
      link: links.main, message: d.texts[0], call_to_action: cta(links.main), multi_share_end_card: false, multi_share_optimized: false,
      child_attachments: d.cards.map((c, i) => ({ link: links.cards[i], image_hash: hashes[i], name: c.title, description: c.description, call_to_action: cta(links.cards[i]) }))
    };
  } else {
    spec.link_data = { link: links.main, message: d.texts[0], name: d.headlines[0], description: d.description, image_hash: hashes[0], call_to_action: cta(links.main) };
  }
  const out: Record<string, any> = { name, object_story_spec: spec };
  if (web) out.url_tags = URL_TAGS;
  // Varias opciones de texto: Meta muestra a cada persona la combinación que mejor funciona (solo anuncio de una foto).
  if (withTextOptions && d.format === 'single' && (d.texts.length > 1 || d.headlines.length > 1)) {
    out.asset_feed_spec = {
      bodies: d.texts.map(text => ({ text })), titles: d.headlines.map(text => ({ text })),
      descriptions: d.description ? [{ text: d.description }] : undefined, optimization_type: 'DEGREES_OF_FREEDOM'
    };
  }
  return out;
}

const featuresSpec = (features: string[]) => ({ creative_features_spec: Object.fromEntries(features.map(k => [k, { enroll_status: 'OPT_OUT' }])) });

// ---------- Anuncios creados desde el CRM ----------

export interface CreatedAd {
  campaignId: string; adsetId: string; adId: string; creativeId: string;
  name: string; adName: string; destination: 'web' | 'whatsapp'; format: 'single' | 'carousel'; theme: string;
  products: string[]; image: string; text: string; dailyBudget: number; audience: Audience;
  status: 'PAUSED' | 'ACTIVE'; createdAt: string; history: { at: string; action: string; detail: string }[];
  warnings: string[];
}

async function readCreated(): Promise<CreatedAd[]> {
  try {
    const raw = await getConfig(CREATED_KEY);
    const list = raw ? JSON.parse(raw) : [];
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

const writeCreated = (list: CreatedAd[]) => setConfig(CREATED_KEY, JSON.stringify(list.slice(0, 100)));

const dayOf = (iso: string, timeZone: string) => {
  const p = localParts(new Date(iso), timeZone);
  return `${p.year}-${p.month}-${p.day}`;
};

/** Cuánto suman por día las campañas activas creadas desde el CRM (sin contar una). */
export function activeDaily(list: CreatedAd[], except = ''): number {
  return Math.round(list.filter(c => c.status === 'ACTIVE' && c.campaignId !== except).reduce((t, c) => t + Number(c.dailyBudget || 0), 0) * 100) / 100;
}

/** Acciones de hoy (crear, activar, pausar, presupuesto) para no hacer nada en masa. */
export function actionsToday(list: CreatedAd[], timeZone: string, now = new Date(), kind?: string): number {
  const today = dayOf(now.toISOString(), timeZone);
  return list.reduce((n, c) => n + c.history.filter(h => dayOf(h.at, timeZone) === today && (!kind || h.action === kind)).length, 0);
}

const zone = () => profile().business.timezone || 'America/Guayaquil';
const busy = new Set<string>();

async function withLock<T>(fn: () => Promise<T>): Promise<T> {
  const key = currentTenant()?.businessId || 'velamia';
  if (busy.has(key)) throw new Error('Ya hay un cambio en camino con Meta: espera a que termine.');
  busy.add(key);
  try {
    return await fn();
  } finally {
    busy.delete(key);
  }
}

/** La foto del producto lista para el anuncio: la foto completa sobre un fondo difuminado (4:5 o 1:1), en JPG. */
async function adImageBytes(url: string, kind: ImageKind): Promise<Buffer> {
  const { data } = await axios.get(url, { responseType: 'arraybuffer', timeout: 60_000, maxContentLength: 15 * 1024 * 1024 });
  return toInstagramJpeg(Buffer.from(data), kind);
}

/**
 * Crea el anuncio en Meta, EN PAUSA: campaña, conjunto (público y presupuesto), contenido (fotos y textos) y anuncio.
 * Si algo falla a la mitad, se borra lo que se alcanzó a crear (nunca queda una campaña a medias).
 */
export async function createAd(raw: any, who = ''): Promise<CreatedAd> {
  return withLock(async () => {
    const { token, accountId } = await access();
    const s = await readBuilderSettings();
    const destination = raw?.destination === 'whatsapp' ? 'whatsapp' : 'web';
    const missing = missingFor(s, destination);
    if (missing.length) throw new Error(`Antes de crear falta: ${missing.join(', ')} (en "Ajustes para crear anuncios").`);
    const account = await readAccount(token, accountId);
    if (!account.canWrite) throw new Error(account.problem);
    const catalog = await adCatalog();
    const { draft, errors } = normalizeDraft(raw, catalog, s);
    if (errors.length) throw new Error(errors.join(' '));
    if (draft.dailyBudget < account.minDaily) throw new Error(`Meta pide un presupuesto diario de al menos $${account.minDaily.toFixed(2)}.`);
    const problems = reviewDraft(draft, catalog, String(raw?.idea || '')).filter(i => i.level === 'error');
    if (problems.length) throw new Error(`Corrige esto antes de crear: ${problems.map(i => `${i.where}: ${i.text}`).join(' ')}`);
    const list = await readCreated();
    if (actionsToday(list, zone(), new Date(), 'crear') >= MAX_CREATED_PER_DAY) {
      throw new Error(`Hoy ya se crearon ${MAX_CREATED_PER_DAY} anuncios desde el CRM. Para cuidar tu cuenta con Meta, el siguiente mañana.`);
    }

    // Fotos a la biblioteca de la cuenta publicitaria (cada foto una sola vez).
    const kind: ImageKind = draft.format === 'carousel' ? 'square' : 'feed';
    const hashByUrl = new Map<string, string>();
    for (const card of draft.cards) {
      if (hashByUrl.has(card.image)) continue;
      let bytes: Buffer;
      try {
        bytes = await adImageBytes(card.image, kind);
      } catch (error: any) {
        throw new Error(`No se pudo preparar la foto de ${card.product}: ${error.message}. Elige otra foto.`);
      }
      const up = await graphPost(`${accountId}/adimages`, token, { bytes: bytes.toString('base64') }, 90_000);
      const first: any = Object.values(up?.images || {})[0];
      const hash = String(first?.hash || '');
      if (!hash) throw new Error('Meta no devolvió la foto subida. Intenta de nuevo.');
      hashByUrl.set(card.image, hash);
    }
    const hashes = draft.cards.map(c => hashByUrl.get(c.image)!);
    const names = namesFor(draft, profile().business.name, s.country, new Date(), zone());
    const links = linksFor(draft, s, catalog);
    const warnings: string[] = [];

    const campaign = await graphPost(`${accountId}/campaigns`, token, campaignParams(draft, names.campaign));
    const campaignId = String(campaign.id);
    try {
      const adset = await graphPost(`${accountId}/adsets`, token, adsetParams(draft, s, campaignId, names.adset));
      const creativeId = await createCreative(token, accountId, draft, s, hashes, links, names.ad, warnings);
      const ad = await graphPost(`${accountId}/ads`, token, { name: names.ad, adset_id: String(adset.id), creative: { creative_id: creativeId }, status: 'PAUSED' });
      // Se revisa que Meta no haya prendido mejoras automáticas por su cuenta.
      const back = await graphGet(`${creativeId}?fields=degrees_of_freedom_spec`, token).catch(() => null);
      const on = Object.entries(back?.degrees_of_freedom_spec?.creative_features_spec || {}).filter(([, v]: any) => v?.enroll_status === 'OPT_IN').map(([k]) => k);
      if (on.length) warnings.push(`Meta dejó encendidas estas mejoras automáticas: ${on.join(', ')}.`);
      const products = [...new Set(draft.cards.map(c => c.product))];
      const categories = [...new Set(products.map(n => catalog.find(p => p.name === n)?.category || ''))];
      await rememberCreatedAd(String(ad.id), {
        ad_name: names.ad, campaign_id: campaignId, campaign_name: names.campaign, adset_id: String(adset.id), adset_name: names.adset,
        destination: draft.destination, status: 'PAUSED', headline: draft.format === 'single' ? draft.headlines[0] : draft.cards[0].title, body: draft.texts[0],
        image_url: draft.cards[0].image
      }, products, categories.length === 1 ? categories[0] : '').catch(error => console.warn('⚠️ No se registró el anuncio creado:', error.message));
      const now = new Date().toISOString();
      const record: CreatedAd = {
        campaignId, adsetId: String(adset.id), adId: String(ad.id), creativeId, name: names.campaign, adName: names.ad, destination: draft.destination,
        format: draft.format, theme: draft.theme, products, image: draft.cards[0].image, text: draft.texts[0], dailyBudget: draft.dailyBudget,
        audience: draft.audience, status: 'PAUSED', createdAt: now, warnings,
        history: [{ at: now, action: 'crear', detail: `Creado en pausa${who ? ` por ${who}` : ''} · $${draft.dailyBudget.toFixed(2)} por día` }]
      };
      await writeCreated([record, ...(await readCreated())]);
      overviewCache.clear();
      console.log(`📣 Anuncio creado en pausa desde el CRM: ${names.campaign} (${campaignId})`);
      return record;
    } catch (error) {
      await call('DELETE', campaignId, token).catch(e => console.warn(`⚠️ No se pudo borrar la campaña a medias ${campaignId}:`, e.message));
      throw error;
    }
  });
}

/** El contenido del anuncio con todas las mejoras automáticas apagadas (si Meta no acepta alguna, se quita y se reintenta). */
async function createCreative(token: string, accountId: string, d: AdDraft, s: BuilderSettings, hashes: string[], links: { main: string; cards: string[] }, name: string, warnings: string[]): Promise<string> {
  let features = [...OPT_OUT_FEATURES];
  let textOptions = true;
  for (let attempt = 0; attempt < 8; attempt++) {
    try {
      const created = await graphPost(`${accountId}/adcreatives`, token, { ...creativeParams(d, s, hashes, links, name, textOptions), degrees_of_freedom_spec: featuresSpec(features) });
      return String(created.id);
    } catch (error: any) {
      const raw = JSON.stringify(error?.meta || {});
      const bad = features.filter(k => new RegExp(`(^|[^a-z0-9_])${k}([^a-z0-9_]|$)`).test(raw));
      if (bad.length) { features = features.filter(k => !bad.includes(k)); continue; }
      if (textOptions && /asset_feed_spec|dynamic|degrees_of_freedom|optimization_type/i.test(raw) && d.format === 'single' && (d.texts.length > 1 || d.headlines.length > 1)) {
        textOptions = false;
        warnings.push('Meta no aceptó varias opciones de texto en este anuncio: lleva el primer texto y el primer título.');
        continue;
      }
      throw error;
    }
  }
  throw new Error('Meta no aceptó el contenido del anuncio. Intenta de nuevo más tarde.');
}

function findCreated(list: CreatedAd[], campaignId: string): CreatedAd {
  const found = list.find(c => c.campaignId === campaignId);
  if (!found) throw new Error('Solo se manejan desde aquí los anuncios creados en el CRM. Los demás, en el Administrador de anuncios de Meta.');
  return found;
}

/** Activa o pausa una campaña creada desde el CRM. Activar revisa el estado de la cuenta y el tope por día. */
export async function setActive(campaignId: string, active: boolean, who = ''): Promise<CreatedAd> {
  return withLock(async () => {
    const { token, accountId } = await access();
    const s = await readBuilderSettings();
    const list = await readCreated();
    const item = findCreated(list, campaignId);
    if (actionsToday(list, zone()) >= MAX_ACTIONS_PER_DAY) throw new Error('Hoy ya se hicieron muchos cambios desde el CRM. Para cuidar tu cuenta con Meta, sigue mañana.');
    if (active) {
      const account = await readAccount(token, accountId);
      if (!account.canWrite) throw new Error(account.problem);
      const total = activeDaily(list, campaignId) + item.dailyBudget;
      if (total > s.maxDaily) throw new Error(`Con este anuncio, lo activo sumaría $${total.toFixed(2)} por día y tu tope es $${s.maxDaily.toFixed(2)}. Pausa otro, baja su presupuesto o sube el tope en Ajustes.`);
      await graphPost(item.adId, token, { status: 'ACTIVE' });
      await graphPost(item.adsetId, token, { status: 'ACTIVE' });
      await graphPost(item.campaignId, token, { status: 'ACTIVE' });
    } else {
      await graphPost(item.campaignId, token, { status: 'PAUSED' });
    }
    item.status = active ? 'ACTIVE' : 'PAUSED';
    item.history.unshift({ at: new Date().toISOString(), action: active ? 'activar' : 'pausar', detail: `${active ? 'Activado' : 'Pausado'}${who ? ` por ${who}` : ''}` });
    item.history = item.history.slice(0, 40);
    await writeCreated(list);
    overviewCache.clear();
    return item;
  });
}

/** Cambia el presupuesto diario (dentro del tope; pocas veces al día para no reiniciar el aprendizaje de Meta). */
export async function setBudget(campaignId: string, daily: unknown, who = ''): Promise<CreatedAd> {
  return withLock(async () => {
    const { token, accountId } = await access();
    const s = await readBuilderSettings();
    const list = await readCreated();
    const item = findCreated(list, campaignId);
    const value = Math.round(Number(daily) * 100) / 100;
    if (!Number.isFinite(value) || value < 1) throw new Error('El presupuesto diario mínimo es $1.');
    if (value > s.maxDaily) throw new Error(`Pasa tu tope de $${s.maxDaily.toFixed(2)} por día (puedes subirlo en Ajustes).`);
    if (item.status === 'ACTIVE' && activeDaily(list, campaignId) + value > s.maxDaily) {
      throw new Error(`Lo activo sumaría $${(activeDaily(list, campaignId) + value).toFixed(2)} por día y tu tope es $${s.maxDaily.toFixed(2)}.`);
    }
    const today = dayOf(new Date().toISOString(), zone());
    if (item.history.filter(h => h.action === 'presupuesto' && dayOf(h.at, zone()) === today).length >= MAX_BUDGET_CHANGES_PER_DAY) {
      throw new Error('Este anuncio ya cambió de presupuesto varias veces hoy. Espera a mañana: cada cambio hace que Meta vuelva a aprender.');
    }
    const account = await readAccount(token, accountId);
    if (!account.canWrite) throw new Error(account.problem);
    if (value < account.minDaily) throw new Error(`Meta pide al menos $${account.minDaily.toFixed(2)} por día.`);
    await graphPost(item.adsetId, token, { daily_budget: Math.round(value * 100) });
    item.history.unshift({ at: new Date().toISOString(), action: 'presupuesto', detail: `Presupuesto $${item.dailyBudget.toFixed(2)} → $${value.toFixed(2)} por día${who ? ` (${who})` : ''}` });
    item.history = item.history.slice(0, 40);
    item.dailyBudget = value;
    await writeCreated(list);
    overviewCache.clear();
    return item;
  });
}

// ---------- Lo que se ve en vivo ----------

const STATUS_LABEL: Record<string, string> = {
  ACTIVE: 'Activo', PAUSED: 'Pausado', CAMPAIGN_PAUSED: 'Pausado', ADSET_PAUSED: 'Pausado', PENDING_REVIEW: 'En revisión de Meta', IN_PROCESS: 'Procesando',
  DISAPPROVED: 'Rechazado por Meta', WITH_ISSUES: 'Con problemas', PREAPPROVED: 'Aprobado', PENDING_BILLING_INFO: 'Falta método de pago', ARCHIVED: 'Archivado', DELETED: 'Borrado'
};

const RESULT_ACTIONS: Record<string, string[]> = {
  whatsapp: ['onsite_conversion.messaging_conversation_started_7d'],
  ADD_TO_CART: ['offsite_conversion.fb_pixel_add_to_cart', 'omni_add_to_cart', 'add_to_cart'],
  INITIATED_CHECKOUT: ['offsite_conversion.fb_pixel_initiate_checkout', 'omni_initiated_checkout', 'initiate_checkout'],
  PURCHASE: ['offsite_conversion.fb_pixel_purchase', 'omni_purchase', 'purchase']
};

/** El primer tipo de acción que trae Meta de la lista (el mismo resultado viene con varios nombres: no se suman). */
const actionValue = (actions: any[], types: string[]) => {
  for (const type of types) {
    const hit = (actions || []).find((a: any) => a.action_type === type);
    if (hit) return Number(hit.value || 0);
  }
  return 0;
};

export function liveFrom(ad: any, today: any, total: any, destination: 'web' | 'whatsapp', webEvent = 'ADD_TO_CART') {
  const reasons = Object.values(ad?.ad_review_feedback?.global || {}).map(String);
  const issues = (ad?.issues_info || []).map((i: any) => String(i.error_summary || i.error_message || '')).filter(Boolean);
  const types = RESULT_ACTIONS[destination === 'whatsapp' ? 'whatsapp' : webEvent] || RESULT_ACTIONS.ADD_TO_CART;
  const results = (r: any) => actionValue(r?.actions, types);
  const status = String(ad?.effective_status || '');
  return {
    status, statusLabel: STATUS_LABEL[status] || status || '—', reasons, issues,
    budget: ad?.adset?.daily_budget ? Number(ad.adset.daily_budget) / 100 : null,
    spendToday: Number(today?.spend || 0), spendTotal: Number(total?.spend || 0), impressions: Number(total?.impressions || 0),
    clicks: Number(total?.inline_link_clicks || 0), results: results(total), resultsToday: results(today)
  };
}

const overviewCache = new Map<string, { at: number; data: any }>();

/** Ajustes, estado de la cuenta y los anuncios creados desde el CRM con su estado, gasto y ventas (caché de 1 minuto). */
export async function builderOverview() {
  const key = currentTenant()?.businessId || 'velamia';
  const hit = overviewCache.get(key);
  if (hit && Date.now() - hit.at < 60_000) return hit.data;
  const s = await readBuilderSettings();
  const a = await adsAccess();
  const created = await readCreated();
  let account: AccountHealth | null = null;
  let liveError = '';
  const live = new Map<string, any>();
  if (a) {
    try {
      account = await readAccount(a.token, a.accountId);
      const ids = created.slice(0, 40).map(c => c.adId);
      if (ids.length) {
        const fields = 'effective_status,ad_review_feedback,issues_info,adset{daily_budget}';
        const filter = encodeURIComponent(JSON.stringify([{ field: 'ad.id', operator: 'IN', value: ids }]));
        const ins = 'ad_id,spend,impressions,inline_link_clicks,actions';
        const [ads, today, total] = await Promise.all([
          graphGet(`?ids=${ids.join(',')}&fields=${fields}`, a.token),
          graphGet(`${a.accountId}/insights?level=ad&filtering=${filter}&date_preset=today&fields=${ins}&limit=100`, a.token),
          graphGet(`${a.accountId}/insights?level=ad&filtering=${filter}&date_preset=maximum&fields=${ins}&limit=100`, a.token)
        ]);
        const byAd = (rows: any) => new Map<string, any>((rows?.data || []).map((r: any) => [String(r.ad_id), r]));
        const t = byAd(today), m = byAd(total);
        for (const c of created.slice(0, 40)) live.set(c.adId, liveFrom(ads?.[c.adId], t.get(c.adId), m.get(c.adId), c.destination, s.webEvent));
        // Si se activó o pausó desde Meta, el CRM se pone al día (para que el tope por día cuente lo de verdad).
        let changed = false;
        for (const c of created) {
          const st = live.get(c.adId)?.status;
          if (!st) continue;
          const running = ['ACTIVE', 'PENDING_REVIEW', 'IN_PROCESS', 'PREAPPROVED', 'WITH_ISSUES'].includes(st);
          const stopped = ['PAUSED', 'CAMPAIGN_PAUSED', 'ADSET_PAUSED', 'ARCHIVED', 'DELETED', 'DISAPPROVED'].includes(st);
          if (c.status === 'ACTIVE' && stopped) { c.status = 'PAUSED'; c.history.unshift({ at: new Date().toISOString(), action: 'meta', detail: `Quedó detenido en Meta (${STATUS_LABEL[st] || st})` }); changed = true; }
          else if (c.status === 'PAUSED' && running) { c.status = 'ACTIVE'; c.history.unshift({ at: new Date().toISOString(), action: 'meta', detail: 'Se activó desde Meta' }); changed = true; }
        }
        if (changed) await writeCreated(created);
      }
    } catch (error: any) {
      liveError = error.message;
    }
  }
  // Ventas del CRM desde que se creó el anuncio más antiguo de la lista (como mucho un año).
  const oldest = created.reduce((m, c) => Math.min(m, Date.parse(c.createdAt) || Date.now()), Date.now());
  const since = new Date(Math.max(oldest - 86_400_000, Date.now() - 365 * 86_400_000));
  const crm = created.length ? await adResults(since, new Date()).catch(() => null) : null;
  const sales = new Map((crm?.results || []).map(r => [r.adId, r]));
  const items = created.map(c => {
    const r = sales.get(c.adId);
    const l = live.get(c.adId) || null;
    return {
      ...c, live: l,
      crm: { chats: r?.chats || 0, quotations: r?.quotations || 0, sales: r?.sales || 0, revenue: r?.revenue || 0 },
      roas: l && l.spendTotal > 0 && r ? Math.round((r.revenue / l.spendTotal) * 10) / 10 : null
    };
  });
  const data = {
    connected: !!a, accountId: a?.accountId || '', settings: s, account, liveError, created: items, activeDaily: activeDaily(created),
    limits: { perDay: MAX_CREATED_PER_DAY, createdToday: actionsToday(created, zone(), new Date(), 'crear'), budgetChanges: MAX_BUDGET_CHANGES_PER_DAY },
    ai: { configured: !!(await getSocialAi().catch(() => null))?.apiKey }
  };
  overviewCache.set(key, { at: Date.now(), data });
  return data;
}

// ---------- La IA propone el anuncio ----------

const META_RULES = [
  'REGLAS DE PUBLICIDAD DE META (obligatorias, para que la cuenta nunca tenga problemas):',
  '- Nunca supongas ni nombres algo personal de quien ve el anuncio: embarazo, salud, peso, religión, estado civil, orientación, dinero o deudas. Nada de "¿Estás embarazada?", "futura mamá", "tu bebé". Habla del producto y de la ocasión ("recuerdos para baby shower", "velas para bautizo").',
  '- Nada de pedir que comenten, compartan, etiqueten o den like.',
  '- Nunca inventes descuentos, promociones, envíos gratis, fechas límite ni "últimas unidades". Solo si vienen en la idea de la empresa.',
  '- Sin promesas absolutas ("garantizado", "el mejor del país"), sin MAYÚSCULAS seguidas, sin "!!!", máximo 3 emojis por texto.',
  '- No nombres Facebook, Instagram ni Meta.',
  '- Precios exactamente como vienen en los productos (por ejemplo "$30 la docena"). Nunca otro precio.'
].join('\n');

interface AiProposal {
  tema: string; formato: 'single' | 'carousel'; productos: string[]; textos: string[]; titulos: string[]; descripcion: string;
  tarjetas: { producto: string; titulo: string; descripcion: string }[]; edad_min: number; edad_max: number; genero: Gender; presupuesto: number; explicacion: string;
}

export interface ProposeInput { destination?: unknown; products?: unknown; idea?: unknown; format?: unknown }

/** La IA del agente de redes arma el anuncio con productos reales del Catálogo; después se revisa con las reglas de Meta. */
export async function proposeAd(input: ProposeInput) {
  const s = await readBuilderSettings();
  const catalog = await adCatalog();
  const destination = input.destination === 'whatsapp' ? 'whatsapp' : 'web';
  const idea = short(input.idea, 600);
  const wantFormat = input.format === 'single' || input.format === 'carousel' ? input.format : 'auto';
  const find = finder(catalog);
  const chosen = [...new Set((Array.isArray(input.products) ? input.products : []).map(n => find(n)).filter(Boolean) as PickProduct[])]
    .filter(p => p.images.length).slice(0, 10);
  if (!chosen.length && !idea) throw new Error('Elige productos del Catálogo o escribe la idea del anuncio.');
  const p = profile();
  const b = p.business;
  const social = await getSocialAi().catch(() => null);
  const now = localParts(new Date(), zone());
  const productLine = (x: PickProduct) => ({ nombre: x.name, como_decirlo: x.displayName || x.name, precio: `$${x.price % 1 ? x.price.toFixed(2) : x.price} ${x.unit === p.sales.unitSingular ? p.sales.priceSuffix : `c/${x.unit}`}`, categoria: x.category, descripcion: x.description });
  const system = [
    `Eres quien hace los anuncios pagados de Meta (Facebook e Instagram) de ${b.name}, ${b.description}${b.city ? ` en ${b.city}` : ''}. Escribe en español natural y cálido, como una persona de la marca.`,
    destination === 'web'
      ? '- El anuncio lleva a la PÁGINA WEB donde se compra: invita a ver y pedir en la web ("Pídelas en nuestra web", "Mira todos los modelos"). Nunca menciones WhatsApp.'
      : '- El anuncio abre un chat de WHATSAPP con la tienda: invita a escribir para cotizar o pedir ("Escríbenos y te cotizamos").',
    '- "textos": 5 textos principales distintos (entre 90 y 220 letras cada uno): el primero engancha con la ocasión o el beneficio; menciona 1 o 2 productos con su precio exacto; cierra con la invitación.',
    '- En los textos y las tarjetas nombra los productos de forma natural, como los diría una persona (usa "como_decirlo" o algo más corto: "velas de fantasmita", "osito en nube"), nunca en MAYÚSCULAS ni con números de modelo. En "productos" y "tarjetas.producto" sí va el "nombre" exacto, para identificarlos.',
    '- "titulos": 5 títulos de máximo 40 letras (por ejemplo el producto con su precio). "descripcion": máximo 30 letras (por ejemplo "Hechas a mano").',
    '- "tarjetas": una por producto, en el orden en que deben salir: título de máximo 40 letras con el precio exacto, y descripción de máximo 30 letras.',
    `- "formato": "carousel" si hay 2 o más productos que lucen juntos; "single" si es un solo producto.${wantFormat !== 'auto' ? ` La empresa pidió "${wantFormat}": úsalo.` : ''}`,
    chosen.length ? '- "productos": exactamente los productos dados, en el orden que mejor venda.' : '- "productos": elige de 1 a 6 productos del catálogo dado que encajen con la idea (nombres exactos).',
    `- "edad_min", "edad_max" y "genero" (mujeres, hombres o todos): quién compra este producto. "presupuesto": dólares por día, entre 1 y ${Math.min(s.maxDaily, 20)} (para empezar, lo justo: $3 a $5 suele bastar).`,
    '- "tema": 1 a 3 palabras para el nombre de la campaña (por ejemplo "Halloween", "Baby Shower Ositos"). "explicacion": 2 frases simples para la dueña de por qué este anuncio.',
    META_RULES,
    social?.prompt?.trim() ? `\nINSTRUCCIONES DE LA EMPRESA PARA SUS REDES (síguelas salvo que choquen con las reglas de Meta o pidan inventar precios o promociones):\n${social.prompt.trim().slice(0, 4000)}` : ''
  ].filter(Boolean).join('\n');
  const user = JSON.stringify({
    hoy: `${now.day}/${now.month}/${now.year}`, destino: destination === 'web' ? 'página web' : 'WhatsApp', idea_de_la_empresa: idea || '(sin idea: decide tú)',
    productos: chosen.map(productLine),
    ...(chosen.length ? {} : { catalogo: catalog.filter(x => x.images.length).slice(0, 300).map(x => `${x.name} (${x.displayName}) · ${x.category} · $${x.price}`) })
  });
  const schema = {
    type: 'object', additionalProperties: false,
    required: ['tema', 'formato', 'productos', 'textos', 'titulos', 'descripcion', 'tarjetas', 'edad_min', 'edad_max', 'genero', 'presupuesto', 'explicacion'],
    properties: {
      tema: { type: 'string' }, formato: { type: 'string', enum: ['single', 'carousel'] }, productos: { type: 'array', items: { type: 'string' } },
      textos: { type: 'array', items: { type: 'string' } }, titulos: { type: 'array', items: { type: 'string' } }, descripcion: { type: 'string' },
      tarjetas: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['producto', 'titulo', 'descripcion'], properties: { producto: { type: 'string' }, titulo: { type: 'string' }, descripcion: { type: 'string' } } } },
      edad_min: { type: 'integer' }, edad_max: { type: 'integer' }, genero: { type: 'string', enum: ['mujeres', 'hombres', 'todos'] }, presupuesto: { type: 'number' }, explicacion: { type: 'string' }
    }
  };
  const ai = await askSocialJson<AiProposal>({ system, user, schemaName: 'anuncio', schema, maxTokens: 5000 });
  return { ...buildProposal(ai, { destination, chosen, catalog, settings: s, wantFormat, idea }), explanation: short(ai.explicacion, 500) };
}

/** Del JSON de la IA al borrador: solo productos del Catálogo con foto, textos que pasan las reglas y límites de la empresa. */
export function buildProposal(ai: AiProposal, o: { destination: 'web' | 'whatsapp'; chosen: PickProduct[]; catalog: PickProduct[]; settings: BuilderSettings; wantFormat: string; idea: string }) {
  // Los nombres que devuelve la IA se buscan primero entre los productos elegidos (por si hay otro con el mismo nombre).
  const chosenByName = new Map(o.chosen.map(p => [plain(p.name), p]));
  const find = finder(o.catalog);
  const fromAi = [...new Set((ai.productos || []).map(n => chosenByName.get(plain(n)) || find(undefined, n)).filter((p): p is PickProduct => !!p && p.images.length > 0))];
  const products = (o.chosen.length ? [...fromAi.filter(p => o.chosen.includes(p)), ...o.chosen.filter(p => !fromAi.includes(p))] : fromAi).slice(0, 10);
  if (!products.length) throw new Error('La IA no encontró productos con foto para esa idea. Elige los productos en la lista.');
  let format: 'single' | 'carousel' = o.wantFormat === 'single' || o.wantFormat === 'carousel' ? o.wantFormat : ai.formato === 'carousel' ? 'carousel' : 'single';
  if (format === 'carousel' && products.length < 2) format = 'single';
  const cardText = new Map((ai.tarjetas || []).map(t => [plain(t.producto), t]));
  const cards: AdCard[] = products.map(p => {
    const t = cardText.get(plain(p.name));
    return { productId: p.id, product: p.name, image: p.images[0], title: short(t?.titulo, LIMITS.card) || p.name, description: short(t?.descripcion, LIMITS.card) };
  });
  const draft: AdDraft = {
    destination: o.destination, format, theme: short(ai.tema, LIMITS.theme) || 'Anuncio',
    texts: uniqueTexts(ai.textos, 5, LIMITS.text), headlines: uniqueTexts(ai.titulos, 5, LIMITS.headline), description: short(ai.descripcion, LIMITS.description),
    cards: format === 'single' ? cards.slice(0, 1) : cards,
    dailyBudget: money(ai.presupuesto, 1, o.settings.maxDaily, Math.min(3, o.settings.maxDaily)),
    audience: normalizeAudience({ ageMin: ai.edad_min, ageMax: ai.edad_max, gender: ai.genero, advantage: false }, o.settings.audience)
  };
  // Los textos que no pasan las reglas se quitan (si quedan otros); el resto de avisos se muestran.
  const passes = (patch: Partial<AdDraft>, where: string) => !reviewDraft({ ...draft, ...patch }, o.catalog, o.idea).some(x => x.level === 'error' && x.where === where);
  const okTexts = draft.texts.filter(t => passes({ texts: [t] }, 'Texto 1'));
  if (okTexts.length) draft.texts = okTexts;
  const okTitles = draft.headlines.filter(t => passes({ headlines: [t] }, 'Título 1'));
  if (okTitles.length) draft.headlines = okTitles;
  return { draft, issues: reviewDraft(draft, o.catalog, o.idea), alternatives: { products: o.chosen.length ? [] : products.map(p => p.name) } };
}

// ---------- Consejos de la IA ----------

/** La IA lee los resultados (gasto de Meta y ventas del CRM) y dice qué hacer con cada anuncio. No cambia nada sola. */
export async function adviceForAds() {
  const overview = await builderOverview();
  const crm = await adResults(new Date(Date.now() - 30 * 86_400_000), new Date());
  const rows = crm.results.filter(r => (r.spend || 0) > 0 || r.chats > 0).slice(0, 15).map(r => ({
    anuncio: r.adName, destino: r.destination, gasto_30_dias: r.spend, chats: r.chats, cotizaciones: r.quotations, ventas: r.sales, ingresos: r.revenue,
    costo_por_chat: r.costPerChat, retorno: r.roas, creado_en_crm: overview.created.some((c: any) => c.adId === r.adId)
  }));
  const mine = overview.created.slice(0, 10).map((c: any) => ({
    anuncio: c.adName, estado: c.live?.statusLabel || c.status, presupuesto_diario: c.dailyBudget, creado: c.createdAt.slice(0, 10),
    gasto_total: c.live?.spendTotal ?? null, resultados_meta: c.live?.results ?? null, chats: c.crm.chats, ventas: c.crm.sales, ingresos: c.crm.revenue,
    rechazo: (c.live?.reasons || []).join(' ')
  }));
  if (!rows.length && !mine.length) return { resumen: 'Todavía no hay resultados de anuncios para analizar. Cuando un anuncio lleve unos días activo, aquí verás qué conviene hacer.', consejos: [] };
  const b = profile().business;
  const system = [
    `Eres quien revisa los anuncios de Meta de ${b.name}. Con los datos dados (los calcula el sistema: nunca inventes cifras), di qué conviene hacer con cada anuncio.`,
    '- La meta son VENTAS del CRM (y cotizaciones), no clics ni vistas.',
    '- Con menos de 3 días activo o menos de $10 gastados, di que todavía es pronto para decidir (acción "esperar").',
    '- Cambios de presupuesto de máximo 20-30% de una vez: cambios grandes hacen que Meta vuelva a aprender.',
    '- Si un anuncio fue rechazado, explica en simple qué cambiar.',
    '- "acción": esperar, mantener, subir presupuesto, bajar presupuesto, pausar, cambiar texto o foto, o crear uno nuevo.',
    '- "resumen": 2 frases simples. "consejos": máximo 6, uno por anuncio importante, en palabras simples para la dueña.'
  ].join('\n');
  const schema = {
    type: 'object', additionalProperties: false, required: ['resumen', 'consejos'],
    properties: {
      resumen: { type: 'string' },
      consejos: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['anuncio', 'accion', 'por_que'], properties: { anuncio: { type: 'string' }, accion: { type: 'string' }, por_que: { type: 'string' } } } }
    }
  };
  const out = await askSocialJson<{ resumen: string; consejos: { anuncio: string; accion: string; por_que: string }[] }>({
    system, user: JSON.stringify({ ultimos_30_dias: rows, creados_desde_el_crm: mine }), schemaName: 'consejos', schema, maxTokens: 3000
  });
  return { resumen: short(out.resumen, 600), consejos: (out.consejos || []).slice(0, 6).map(c => ({ anuncio: short(c.anuncio, 160), accion: short(c.accion, 40), por_que: short(c.por_que, 400) })) };
}
