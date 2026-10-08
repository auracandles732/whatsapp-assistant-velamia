import axios from 'axios';
import { getConfig, setConfig } from './supabase';
import { currentTenant } from './tenant';
import { profile } from '../config/businessProfile';
import { plain, localParts } from '../social/posts';
import { toInstagramJpeg, ImageKind } from '../social/images';
import { askSocialJson, getSocialAi } from '../social/ai';
import { listAssetsWithThumbs } from '../social/library';
import { adsAccess, rememberCreatedAd, adResults } from './ads';
import {
  readBuilderSettings, adCatalog, finder, PickProduct, BuilderSettings, Audience, Gender, normalizeAudience, textIssues, allowedPrices, Issue,
  OPT_OUT_FEATURES, URL_TAGS, WEB_EVENTS, metaCall, metaGet, metaPost, metaAccess, readAccount, withLock, featuresSpec, photoOk, short, money, clampInt,
  MONTHS, STATUS_LABEL, RESULT_ACTIONS, actionValue, META_RULES, builderZone, readCreated, overviewCache, CreatedAd, AccountHealth
} from './adBuilder';
import { learningsForPrompt } from './adMemory';

/**
 * Creador de campañas de Meta desde el CRM (para todas las empresas), solo con la API oficial (Marketing API):
 *  - Objetivo (ventas, interacción, tráfico o reconocimiento) y destino (web, WhatsApp o el mismo anuncio).
 *  - Varios conjuntos de anuncios (público, ciudades, intereses, ubicaciones y presupuesto propios) y varios anuncios por
 *    conjunto: foto, video o carrusel (cada tarjeta con su foto o video y sus textos).
 *  - La IA del agente de redes arma la campaña con el Catálogo, la Biblioteca y lo aprendido de campañas anteriores.
 * Las mismas reglas que el creador de anuncios: todo se crea EN PAUSA, textos revisados con las reglas de publicidad de
 * Meta, tope de gasto por día y pocas campañas nuevas por día. Las mejoras automáticas de Meta van apagadas.
 */

const CAMPAIGNS_KEY = 'ad_campaigns_created';
const VIDEO_CACHE_KEY = 'ad_video_cache';

export const MAX_ADSETS = 5;
export const MAX_ADS_PER_ADSET = 8;
export const MAX_CAMPAIGNS_PER_DAY = 3;
export const MAX_NEW_ADS_PER_DAY = 40;
export const MAX_CHANGES_PER_DAY = 40;
export const MAX_BUDGET_CHANGES_PER_DAY = 4;

// ---------- Objetivos, destinos y botones ----------

export type Objective = 'ventas' | 'interaccion' | 'trafico' | 'reconocimiento';
export type Destination = 'web' | 'whatsapp' | 'anuncio';
export type AdFormat = 'image' | 'video' | 'carousel';
export type Cta = 'SHOP_NOW' | 'ORDER_NOW' | 'BUY_NOW' | 'LEARN_MORE' | 'WHATSAPP_MESSAGE' | 'NONE';

export const OBJECTIVES: Record<Objective, { label: string; meta: string; destinations: Destination[] }> = {
  ventas: { label: 'Ventas', meta: 'OUTCOME_SALES', destinations: ['web', 'whatsapp'] },
  interaccion: { label: 'Interacción', meta: 'OUTCOME_ENGAGEMENT', destinations: ['whatsapp', 'web', 'anuncio'] },
  trafico: { label: 'Tráfico', meta: 'OUTCOME_TRAFFIC', destinations: ['web'] },
  reconocimiento: { label: 'Reconocimiento', meta: 'OUTCOME_AWARENESS', destinations: ['anuncio'] }
};

export const DESTINATION_LABEL: Record<Destination, string> = { web: 'Web', whatsapp: 'WhatsApp', anuncio: 'En el anuncio' };

export const CTAS: Record<Destination, Cta[]> = {
  web: ['SHOP_NOW', 'ORDER_NOW', 'BUY_NOW', 'LEARN_MORE'],
  whatsapp: ['WHATSAPP_MESSAGE'],
  anuncio: ['LEARN_MORE', 'NONE']
};

// ---------- La campaña (borrador) ----------

export interface Media { kind: 'image' | 'video'; url: string; source: 'catalogo' | 'biblioteca'; assetId: string; thumb: string }
export interface CampaignCard { media: Media; productId: string; product: string; title: string; description: string }
export interface CampaignAd {
  format: AdFormat;
  /** Nombre corto del anuncio en Meta ("Osito en nube"). */
  name: string;
  /** Qué prueba este anuncio (gancho o enfoque: "precio", "testimonio", "ocasión"): sirve para aprender después. */
  angle: string;
  /** Foto o video del anuncio (foto o video); en el carrusel van en las tarjetas. */
  media: Media | null;
  productId: string;
  product: string;
  texts: string[];
  headlines: string[];
  description: string;
  cta: Cta;
  /** A dónde lleva en la web: la ficha del producto, su categoría o el inicio. */
  link: 'producto' | 'categoria' | 'inicio';
  cards: CampaignCard[];
}
export interface Placements { mode: 'auto' | 'manual'; facebook: boolean; instagram: boolean; feed: boolean; stories: boolean; reels: boolean }
export interface Interest { id: string; name: string }
export interface City { key: string; name: string; radius: number }
export interface AdsetAudience extends Audience { cities: City[]; interests: Interest[] }
export interface CampaignAdset {
  name: string;
  /** Para qué es este conjunto (público o tema): lo que se compara entre conjuntos. */
  focus: string;
  audience: AdsetAudience;
  dailyBudget: number;
  placements: Placements;
  /** Interacción en el anuncio: con reacciones y comentarios, o con reproducciones (solo videos). */
  optimization: 'interacciones' | 'reproducciones';
  ads: CampaignAd[];
}
export interface CampaignPlan {
  objective: Objective;
  destination: Destination;
  webEvent: typeof WEB_EVENTS[number];
  attributionDays: 1 | 7;
  theme: string;
  /** Qué se quiere aprender con esta campaña ("¿el video vende más que las fotos?"). */
  hypothesis: string;
  budgetMode: 'conjunto' | 'campana';
  campaignBudget: number;
  startDate: string;
  endDate: string;
  adsets: CampaignAdset[];
}

export interface LibraryItem { id: string; kind: 'image' | 'video'; url: string; thumb: string; title: string; product: string; duration: number | null; usedCount: number }

/** La Biblioteca del agente de redes con lo que sirve para anuncios: fotos JPG o PNG y videos (MP4 o MOV). */
export async function adLibrary(): Promise<LibraryItem[]> {
  const assets = await listAssetsWithThumbs().catch(() => []);
  return assets
    .filter(a => (a.kind === 'video' && /\.(mp4|mov)(\?|$)/i.test(a.url)) || (a.kind === 'image' && photoOk(a.url)))
    .map(a => ({
      id: a.id, kind: a.kind, url: a.url, thumb: a.thumb_url || (a.kind === 'image' ? a.url : ''), title: a.title || '', product: a.product_name || '',
      duration: a.duration_seconds, usedCount: a.used_count || 0
    }));
}

const PLACEMENTS_AUTO: Placements = { mode: 'auto', facebook: true, instagram: true, feed: true, stories: true, reels: true };

const textList = (list: unknown, max: number, size: number) =>
  [...new Set((Array.isArray(list) ? list : []).map(t => short(t, size)).filter(Boolean))].slice(0, max);

const isDate = (v: unknown) => /^\d{4}-\d{2}-\d{2}$/.test(String(v || '')) && !Number.isNaN(Date.parse(`${v}T12:00:00Z`));

/** Fecha de hoy (AAAA-MM-DD) en la hora del negocio. */
export const todayIn = (timeZone: string, now = new Date()) => {
  const p = localParts(now, timeZone);
  return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
};

export interface PlanContext { catalog: PickProduct[]; library: LibraryItem[]; settings: BuilderSettings; today?: string }

/** Una foto o video válidos para el anuncio: de la ficha del producto en el Catálogo o de la Biblioteca. */
function resolveMedia(raw: any, product: PickProduct | undefined, ctx: PlanContext, allowVideo: boolean): Media | null {
  const assetId = String(raw?.assetId || '');
  if (assetId) {
    const a = ctx.library.find(x => x.id === assetId);
    if (!a || (a.kind === 'video' && !allowVideo)) return null;
    return { kind: a.kind, url: a.url, source: 'biblioteca', assetId: a.id, thumb: a.thumb };
  }
  const url = String(raw?.url || '');
  if (!url) return null;
  if (product?.images.includes(url)) return { kind: 'image', url, source: 'catalogo', assetId: '', thumb: url };
  const fromLibrary = ctx.library.find(x => x.kind === 'image' && x.url === url);
  if (fromLibrary) return { kind: 'image', url, source: 'biblioteca', assetId: fromLibrary.id, thumb: fromLibrary.thumb };
  // Una foto de otro producto del Catálogo también sirve (por ejemplo, un anuncio de categoría).
  const other = ctx.catalog.find(p => p.images.includes(url));
  return other ? { kind: 'image', url, source: 'catalogo', assetId: '', thumb: url } : null;
}

function normalizePlacements(raw: any): Placements {
  if (!raw || raw.mode !== 'manual') return { ...PLACEMENTS_AUTO };
  return { mode: 'manual', facebook: raw.facebook !== false, instagram: raw.instagram !== false, feed: raw.feed !== false, stories: raw.stories === true, reels: raw.reels === true };
}

/**
 * Ordena y revisa la campaña que manda el CRM: objetivo y destino posibles, productos y fotos del Catálogo, videos y fotos de
 * la Biblioteca, límites y presupuesto. Sin efectos.
 */
export function normalizePlan(raw: any, ctx: PlanContext): { plan: CampaignPlan; errors: string[] } {
  const r = raw && typeof raw === 'object' ? raw : {};
  const s = ctx.settings;
  const errors: string[] = [];
  const objective: Objective = (Object.keys(OBJECTIVES) as Objective[]).includes(r.objective) ? r.objective : 'ventas';
  const allowed = OBJECTIVES[objective].destinations;
  const destination: Destination = allowed.includes(r.destination) ? r.destination : allowed[0];
  if (r.destination && !allowed.includes(r.destination)) errors.push(`Una campaña de ${OBJECTIVES[objective].label} no puede llevar a ${DESTINATION_LABEL[r.destination as Destination] || r.destination}.`);
  const find = finder(ctx.catalog);
  const budgetMode = r.budgetMode === 'campana' ? 'campana' : 'conjunto';
  const plan: CampaignPlan = {
    objective, destination,
    webEvent: WEB_EVENTS.includes(r.webEvent) ? r.webEvent : s.webEvent,
    attributionDays: Number(r.attributionDays ?? s.attributionDays) === 1 ? 1 : 7,
    theme: short(r.theme, 40) || 'Campaña', hypothesis: short(r.hypothesis, 300),
    budgetMode, campaignBudget: money(r.campaignBudget, 0, 100000, 0),
    startDate: isDate(r.startDate) ? String(r.startDate) : '', endDate: isDate(r.endDate) ? String(r.endDate) : '',
    adsets: []
  };
  const today = ctx.today || todayIn(builderZone());
  if (plan.startDate && plan.startDate < today) errors.push('La fecha de inicio ya pasó: elige hoy o una fecha futura (o déjala vacía para que empiece al activar).');
  if (plan.endDate && plan.endDate <= (plan.startDate || today)) errors.push('La fecha de fin tiene que ser después del inicio.');

  const rawSets = Array.isArray(r.adsets) ? r.adsets : [];
  if (!rawSets.length) errors.push('La campaña necesita al menos un conjunto de anuncios.');
  if (rawSets.length > MAX_ADSETS) errors.push(`Máximo ${MAX_ADSETS} conjuntos por campaña.`);
  rawSets.slice(0, MAX_ADSETS).forEach((rs: any, si: number) => {
    const at = `Conjunto ${si + 1}`;
    const base = normalizeAudience(rs?.audience, s.audience);
    const cities: City[] = (Array.isArray(rs?.audience?.cities) ? rs.audience.cities : []).slice(0, 10)
      .map((c: any) => ({ key: String(c?.key || '').replace(/[^\w]/g, '').slice(0, 30), name: short(c?.name, 80), radius: clampInt(c?.radius, 1, 80, 25) }))
      .filter((c: City) => c.key);
    const interests: Interest[] = (Array.isArray(rs?.audience?.interests) ? rs.audience.interests : []).slice(0, 10)
      .map((i: any) => ({ id: String(i?.id || '').replace(/\D/g, '').slice(0, 30), name: short(i?.name, 80) }))
      .filter((i: Interest) => i.id);
    const audience: AdsetAudience = { ...base, ...(base.advantage ? { ageMax: 65 } : {}), cities, interests };
    const adset: CampaignAdset = {
      name: short(rs?.name, 50) || `Conjunto ${si + 1}`, focus: short(rs?.focus, 200), audience,
      dailyBudget: money(rs?.dailyBudget, 0, 100000, 0), placements: normalizePlacements(rs?.placements),
      optimization: rs?.optimization === 'reproducciones' ? 'reproducciones' : 'interacciones', ads: []
    };
    if (adset.placements.mode === 'manual' && (!(adset.placements.facebook || adset.placements.instagram) || !(adset.placements.feed || adset.placements.stories || adset.placements.reels))) {
      errors.push(`${at}: en ubicaciones elige al menos Facebook o Instagram y al menos un lugar (feed, historias o reels).`);
    }
    const rawAds = Array.isArray(rs?.ads) ? rs.ads : [];
    if (!rawAds.length) errors.push(`${at}: agrega al menos un anuncio.`);
    if (rawAds.length > MAX_ADS_PER_ADSET) errors.push(`${at}: máximo ${MAX_ADS_PER_ADSET} anuncios por conjunto.`);
    rawAds.slice(0, MAX_ADS_PER_ADSET).forEach((ra: any, ai: number) => {
      const where = `${at} · Anuncio ${ai + 1}`;
      const format: AdFormat = ['image', 'video', 'carousel'].includes(ra?.format) ? ra.format : 'image';
      const product = find(ra?.productId, ra?.product);
      const ctaList = CTAS[destination];
      const ad: CampaignAd = {
        format, name: short(ra?.name, 60), angle: short(ra?.angle, 80), media: null,
        productId: product?.id || '', product: product?.name || '',
        texts: textList(ra?.texts, 5, 600), headlines: textList(ra?.headlines, 5, 80), description: short(ra?.description, 80),
        cta: ctaList.includes(ra?.cta) ? ra.cta : ctaList[0],
        link: ['producto', 'categoria', 'inicio'].includes(ra?.link) ? ra.link : (product ? 'producto' : 'categoria'),
        cards: []
      };
      if (format === 'carousel') {
        const seen = new Set<string>();
        for (const rc of (Array.isArray(ra?.cards) ? ra.cards : []).slice(0, 10)) {
          const cp = find(rc?.productId, rc?.product);
          const media = resolveMedia(rc?.media, cp, ctx, true);
          if (!media) { errors.push(`${where}: una tarjeta no tiene foto o video válido (elige uno del Catálogo o de la Biblioteca).`); continue; }
          if (seen.has(media.url)) { errors.push(`${where}: la misma foto o video está en dos tarjetas.`); continue; }
          seen.add(media.url);
          ad.cards.push({ media, productId: cp?.id || '', product: cp?.name || '', title: short(rc?.title, 80) || cp?.displayName || cp?.name || '', description: short(rc?.description, 80) });
        }
        if (ad.cards.length < 2) errors.push(`${where}: el carrusel necesita al menos 2 tarjetas.`);
      } else {
        ad.media = resolveMedia(ra?.media, product, ctx, format === 'video');
        if (!ad.media) errors.push(`${where}: elige ${format === 'video' ? 'un video de la Biblioteca' : 'una foto (del producto en el Catálogo o de la Biblioteca)'}.`);
        else if (format === 'video' && ad.media.kind !== 'video') errors.push(`${where}: el anuncio de video necesita un video.`);
        else if (format === 'image' && ad.media.kind !== 'image') errors.push(`${where}: el anuncio de foto necesita una foto.`);
      }
      if (!ad.texts.length) errors.push(`${where}: falta el texto principal.`);
      if (format !== 'carousel' && !ad.headlines.length && destination !== 'anuncio') errors.push(`${where}: falta el título.`);
      if (format === 'carousel' && destination === 'anuncio' && !s.webUrl) errors.push(`${where}: el carrusel necesita la página web (Ajustes) para los enlaces de sus tarjetas.`);
      adset.ads.push(ad);
    });
    if (objective === 'interaccion' && destination === 'anuncio' && adset.optimization === 'reproducciones' && adset.ads.some(a => a.format !== 'video')) {
      errors.push(`${at}: para buscar reproducciones, todos sus anuncios tienen que ser videos.`);
    }
    plan.adsets.push(adset);
  });

  // Presupuesto: por conjunto o de campaña, siempre dentro del tope de la empresa.
  if (budgetMode === 'campana') {
    if (plan.campaignBudget < 1) errors.push('El presupuesto diario de la campaña mínimo es $1.');
    else if (plan.campaignBudget > s.maxDaily) errors.push(`El presupuesto de la campaña ($${plan.campaignBudget.toFixed(2)} por día) pasa tu tope de $${s.maxDaily.toFixed(2)}. Súbelo en Ajustes si de verdad quieres gastar más.`);
  } else {
    plan.adsets.forEach((a, i) => { if (a.dailyBudget < 1) errors.push(`Conjunto ${i + 1}: el presupuesto diario mínimo es $1.`); });
    const total = dailyTotal(plan);
    if (total > s.maxDaily) errors.push(`Los conjuntos suman $${total.toFixed(2)} por día y tu tope es $${s.maxDaily.toFixed(2)}. Baja presupuestos o sube el tope en Ajustes.`);
  }
  return { plan, errors };
}

/** Lo que gasta la campaña por día (suma de conjuntos o presupuesto de campaña). */
export const dailyTotal = (plan: Pick<CampaignPlan, 'budgetMode' | 'campaignBudget' | 'adsets'>) =>
  Math.round((plan.budgetMode === 'campana' ? plan.campaignBudget : plan.adsets.reduce((t, a) => t + a.dailyBudget, 0)) * 100) / 100;

export const adCount = (plan: CampaignPlan) => plan.adsets.reduce((n, a) => n + a.ads.length, 0);

/** Productos que muestra un anuncio (el suyo y los de sus tarjetas). */
export const productsOf = (ad: CampaignAd) => [...new Set([ad.product, ...ad.cards.map(c => c.product)].filter(Boolean))];

/** Revisa los textos de toda la campaña con las reglas de publicidad de Meta y da consejos de estructura. Sin efectos. */
export function reviewPlan(plan: CampaignPlan, catalog: PickProduct[], idea = ''): Issue[] {
  const issues: Issue[] = [];
  const add = (i: Issue) => { if (!issues.some(x => x.where === i.where && x.text === i.text)) issues.push(i); };
  const toWeb = plan.destination !== 'whatsapp';
  plan.adsets.forEach((set, si) => {
    const at = `Conjunto ${si + 1}`;
    if (set.ads.length > 6) add({ level: 'aviso', where: at, text: 'Más de 6 anuncios en un conjunto reparte poco presupuesto en cada uno: Meta tarda más en aprender.' });
    if (!set.audience.advantage && !set.audience.interests.length && set.audience.ageMax - set.audience.ageMin >= 40) {
      add({ level: 'aviso', where: at, text: 'Público muy amplio sin intereses: está bien para empezar, pero con intereses llegas a gente más interesada.' });
    }
    set.ads.forEach((ad, ai) => {
      const where = `${at} · Anuncio ${ai + 1}`;
      const prices = allowedPrices(catalog, productsOf(ad), idea);
      const pieces: [string, string][] = [
        ...ad.texts.map((t, i): [string, string] => [`${where} · Texto ${i + 1}`, t]),
        ...ad.headlines.map((t, i): [string, string] => [`${where} · Título ${i + 1}`, t]),
        ...(ad.description ? [[`${where} · Descripción`, ad.description] as [string, string]] : []),
        ...ad.cards.map((c, i): [string, string] => [`${where} · Tarjeta ${i + 1}`, `${c.title}\n${c.description}`])
      ];
      for (const [w, text] of pieces) textIssues(text, w, { toWeb, prices, idea }).forEach(add);
      ad.headlines.forEach((t, i) => { if (t.length > 40) add({ level: 'aviso', where: `${where} · Título ${i + 1}`, text: 'Pasa de 40 letras: en el celular se puede cortar.' }); });
      ad.cards.forEach((c, i) => { if (c.title.length > 40) add({ level: 'aviso', where: `${where} · Tarjeta ${i + 1}`, text: 'El título de la tarjeta pasa de 40 letras: se puede cortar.' }); });
    });
    const firsts = set.ads.map(a => plain(a.texts[0] || ''));
    if (set.ads.length > 1 && firsts.every(Boolean) && new Set(firsts).size === 1) add({ level: 'aviso', where: at, text: 'Todos los anuncios del conjunto tienen el mismo texto: con textos distintos Meta encuentra antes el que funciona.' });
  });
  return issues;
}

// ---------- Lo que se manda a Meta (sin efectos) ----------

const FORMAT_LABEL: Record<AdFormat, string> = { image: 'Foto', video: 'Video', carousel: 'Carrusel' };

export function campaignNames(plan: CampaignPlan, businessName: string, country: string, now = new Date(), timeZone = 'America/Guayaquil') {
  const p = localParts(now, timeZone);
  const tag = `${MONTHS[p.month - 1]}${p.year}`;
  const clean = (t: string) => t.replace(/\|/g, ' ').replace(/\s+/g, ' ').trim();
  const campaign = `${businessName} | ${clean(plan.theme)} | ${OBJECTIVES[plan.objective].label} ${DESTINATION_LABEL[plan.destination]} | ${tag} | CRM`;
  const adsets = plan.adsets.map(a => {
    const who = a.audience.gender === 'mujeres' ? 'Mujeres' : a.audience.gender === 'hombres' ? 'Hombres' : 'Todos';
    const where = a.audience.cities.length ? a.audience.cities.map(c => c.name).slice(0, 2).join('+') : country;
    return `${clean(a.name)} | ${who} ${a.audience.ageMin}-${a.audience.ageMax} | ${where} | ${tag}`;
  });
  const ads = plan.adsets.map(a => a.ads.map((ad, i) => `${businessName} | ${clean(ad.name || ad.product || `${FORMAT_LABEL[ad.format]} ${i + 1}`)} | ${FORMAT_LABEL[ad.format]} | ${clean(a.name)} ${tag}`));
  return { campaign, adsets, ads };
}

/** Enlace de un anuncio o de una tarjeta: la ficha del producto, su categoría, el inicio de la web o el WhatsApp. */
export function linkFor(plan: CampaignPlan, s: BuilderSettings, catalog: PickProduct[], mode: CampaignAd['link'], productIds: string[]): string {
  if (plan.destination === 'whatsapp') return `https://wa.me/${s.whatsappNumber}`;
  if (!s.webUrl) return '';
  const find = finder(catalog);
  const products = productIds.map(id => find(id)).filter(Boolean) as PickProduct[];
  const categories = [...new Set(products.map(p => p.webCategory).filter(Boolean))];
  if (mode === 'producto' && products.length === 1) {
    const p = products[0];
    const q = [p.webCategory ? `categoria=${encodeURIComponent(p.webCategory)}` : '', p.webId ? `producto=${p.webId}` : ''].filter(Boolean).join('&');
    if (q) return `${s.webUrl}/?${q}`;
  }
  if (mode !== 'inicio' && categories.length === 1) return `${s.webUrl}/?categoria=${encodeURIComponent(categories[0])}`;
  return `${s.webUrl}/`;
}

export function campaignParams(plan: CampaignPlan, name: string) {
  const out: Record<string, unknown> = { name, objective: OBJECTIVES[plan.objective].meta, status: 'PAUSED', special_ad_categories: [] };
  if (plan.budgetMode === 'campana') Object.assign(out, { daily_budget: Math.round(plan.campaignBudget * 100), bid_strategy: 'LOWEST_COST_WITHOUT_CAP' });
  else out.is_adset_budget_sharing_enabled = false;
  return out;
}

/** La medianoche de un día (AAAA-MM-DD) en la hora del negocio, en segundos (como lo pide Meta). */
export function zonedMidnight(date: string, timeZone: string): number {
  const [y, m, d] = date.split('-').map(Number);
  let utc = Date.UTC(y, m - 1, d);
  for (let i = 0; i < 2; i++) {
    const p = localParts(new Date(utc), timeZone);
    const shown = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute);
    utc -= shown - Date.UTC(y, m - 1, d);
  }
  return Math.round(utc / 1000);
}

export function targetingFor(a: CampaignAdset, s: BuilderSettings) {
  const geo = a.audience.cities.length
    ? { cities: a.audience.cities.map(c => ({ key: c.key, radius: c.radius, distance_unit: 'kilometer' })), location_types: ['home', 'recent'] }
    : { countries: [s.country], location_types: ['home', 'recent'] };
  const t: Record<string, unknown> = {
    age_min: a.audience.ageMin, age_max: a.audience.ageMax, geo_locations: geo,
    targeting_automation: { advantage_audience: a.audience.advantage ? 1 : 0 }
  };
  if (a.audience.gender !== 'todos') t.genders = [a.audience.gender === 'mujeres' ? 2 : 1];
  if (a.audience.interests.length) t.flexible_spec = [{ interests: a.audience.interests.map(i => ({ id: i.id, name: i.name })) }];
  if (a.placements.mode === 'manual') {
    const p = a.placements;
    t.publisher_platforms = [p.facebook && 'facebook', p.instagram && 'instagram'].filter(Boolean);
    if (p.facebook) t.facebook_positions = [p.feed && 'feed', p.stories && 'story', p.reels && 'facebook_reels'].filter(Boolean);
    if (p.instagram) t.instagram_positions = [p.feed && 'stream', p.stories && 'story', p.reels && 'reels'].filter(Boolean);
  }
  return t;
}

export function adsetParams(plan: CampaignPlan, a: CampaignAdset, s: BuilderSettings, campaignId: string, name: string, timeZone = 'America/Guayaquil', today = '') {
  const out: Record<string, unknown> = { name, campaign_id: campaignId, status: 'PAUSED', billing_event: 'IMPRESSIONS', targeting: targetingFor(a, s) };
  if (plan.budgetMode === 'conjunto') Object.assign(out, { daily_budget: Math.round(a.dailyBudget * 100), bid_strategy: 'LOWEST_COST_WITHOUT_CAP' });
  if (plan.startDate && plan.startDate > (today || todayIn(timeZone))) out.start_time = zonedMidnight(plan.startDate, timeZone);
  if (plan.endDate) out.end_time = zonedMidnight(plan.endDate, timeZone) + 86_399;
  const attribution = [{ event_type: 'CLICK_THROUGH', window_days: plan.attributionDays }];
  const whatsapp = { optimization_goal: 'CONVERSATIONS', destination_type: 'WHATSAPP', promoted_object: { page_id: s.pageId, whatsapp_phone_number: s.whatsappNumber } };
  if (plan.objective === 'ventas') {
    return plan.destination === 'whatsapp'
      ? { ...out, ...whatsapp }
      : { ...out, optimization_goal: 'OFFSITE_CONVERSIONS', promoted_object: { pixel_id: s.pixelId, custom_event_type: plan.webEvent }, attribution_spec: attribution };
  }
  if (plan.objective === 'interaccion') {
    if (plan.destination === 'whatsapp') return { ...out, ...whatsapp };
    if (plan.destination === 'web') return { ...out, optimization_goal: 'OFFSITE_CONVERSIONS', destination_type: 'WEBSITE', promoted_object: { pixel_id: s.pixelId, custom_event_type: 'CONTENT_VIEW' }, attribution_spec: attribution };
    return a.optimization === 'reproducciones'
      ? { ...out, optimization_goal: 'THRUPLAY', destination_type: 'ON_VIDEO' }
      : { ...out, optimization_goal: 'POST_ENGAGEMENT', destination_type: 'ON_POST' };
  }
  if (plan.objective === 'trafico') return { ...out, optimization_goal: 'LANDING_PAGE_VIEWS', destination_type: 'WEBSITE' };
  return { ...out, optimization_goal: 'REACH' };
}

/** Lo subido a Meta para cada foto o video: hash de la foto, o id del video con el hash de su portada. */
export interface Uploaded { hash?: string; videoId?: string; thumbHash?: string }

export function creativeParams(plan: CampaignPlan, ad: CampaignAd, s: BuilderSettings, catalog: PickProduct[], up: Map<string, Uploaded>, name: string, withTextOptions = true) {
  const spec: Record<string, any> = { page_id: s.pageId };
  if (s.instagramId) spec.instagram_user_id = s.instagramId;
  const whatsapp = plan.destination === 'whatsapp';
  const cta = (link: string) => {
    if (whatsapp) return { type: 'WHATSAPP_MESSAGE', value: { app_destination: 'WHATSAPP' } };
    if (!link || ad.cta === 'NONE' || ad.cta === 'WHATSAPP_MESSAGE') return undefined;
    return { type: ad.cta, value: { link } };
  };
  const main = linkFor(plan, s, catalog, ad.link, ad.format === 'carousel' ? ad.cards.map(c => c.productId).filter(Boolean) : [ad.productId].filter(Boolean));
  const media = (m: Media) => {
    const u = up.get(m.url) || {};
    return m.kind === 'video' ? { video_id: u.videoId, image_hash: u.thumbHash } : { image_hash: u.hash };
  };
  if (ad.format === 'carousel') {
    const link = main || `${s.webUrl}/`;
    spec.link_data = {
      link, message: ad.texts[0], multi_share_end_card: false, multi_share_optimized: false, call_to_action: cta(link),
      child_attachments: ad.cards.map(c => {
        const cardLink = linkFor(plan, s, catalog, c.productId ? 'producto' : ad.link, [c.productId].filter(Boolean)) || link;
        return { link: cardLink, ...media(c.media), name: c.title, description: c.description || undefined, call_to_action: cta(cardLink) };
      })
    };
  } else if (ad.format === 'video') {
    spec.video_data = { ...media(ad.media!), message: ad.texts[0], title: ad.headlines[0] || undefined, link_description: ad.description || undefined, call_to_action: main ? cta(main) : undefined };
  } else if (main) {
    spec.link_data = { link: main, message: ad.texts[0], name: ad.headlines[0] || undefined, description: ad.description || undefined, ...media(ad.media!), call_to_action: cta(main) };
  } else {
    spec.photo_data = { ...media(ad.media!), caption: ad.texts[0] };
  }
  const out: Record<string, any> = { name, object_story_spec: spec };
  if (main && !whatsapp) out.url_tags = URL_TAGS;
  // Varias opciones de texto: Meta muestra a cada persona la combinación que mejor funciona (foto o video con enlace).
  if (withTextOptions && ad.format !== 'carousel' && (spec.link_data || spec.video_data) && (ad.texts.length > 1 || ad.headlines.length > 1)) {
    out.asset_feed_spec = {
      bodies: ad.texts.map(text => ({ text })), titles: ad.headlines.length ? ad.headlines.map(text => ({ text })) : undefined,
      descriptions: ad.description ? [{ text: ad.description }] : undefined, optimization_type: 'DEGREES_OF_FREEDOM'
    };
  }
  return out;
}

// ---------- Subir fotos y videos a la cuenta publicitaria ----------

const GRAPH_VIDEO = 'https://graph-video.facebook.com/v25.0';

async function uploadImage(token: string, accountId: string, bytes: Buffer): Promise<string> {
  const up = await metaPost(`${accountId}/adimages`, token, { bytes: bytes.toString('base64') }, 90_000);
  const first: any = Object.values(up?.images || {})[0];
  const hash = String(first?.hash || '');
  if (!hash) throw new Error('Meta no devolvió la foto subida. Intenta de nuevo.');
  return hash;
}

async function download(url: string, maxBytes: number): Promise<Buffer> {
  const { data } = await axios.get(url, { responseType: 'arraybuffer', timeout: 120_000, maxContentLength: maxBytes });
  return Buffer.from(data);
}

async function readVideoCache(): Promise<Record<string, { videoId: string; at: string }>> {
  try {
    const raw = await getConfig(VIDEO_CACHE_KEY);
    const v = raw ? JSON.parse(raw) : {};
    return v && typeof v === 'object' ? v : {};
  } catch {
    return {};
  }
}

/** Sube un video de la Biblioteca a la cuenta publicitaria (una sola vez por video) y espera a que Meta lo procese. */
async function uploadVideo(token: string, accountId: string, m: Media): Promise<{ videoId: string; thumbHash: string }> {
  const cache = await readVideoCache();
  const cacheKey = `${accountId}:${m.assetId || m.url}`;
  let videoId = cache[cacheKey]?.videoId || '';
  if (videoId) {
    const ok = await metaGet(`${videoId}?fields=status`, token).catch(() => null);
    if (!ok || ok?.status?.video_status === 'error') videoId = '';
  }
  if (!videoId) {
    const bytes = await download(m.url, 60 * 1024 * 1024);
    const form = new FormData();
    form.append('name', m.assetId ? `Biblioteca ${m.assetId.slice(0, 8)}` : 'Video del CRM');
    form.append('source', new Blob([new Uint8Array(bytes)]), /\.mov(\?|$)/i.test(m.url) ? 'video.mov' : 'video.mp4');
    const res = await fetch(`${GRAPH_VIDEO}/${accountId}/advideos`, { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: form, signal: AbortSignal.timeout(300_000) });
    const data: any = await res.json().catch(() => ({}));
    if (!res.ok || data?.error || !data?.id) throw new Error(`Meta no recibió el video: ${data?.error?.error_user_msg || data?.error?.message || res.status}`);
    videoId = String(data.id);
    await setConfig(VIDEO_CACHE_KEY, JSON.stringify({ ...cache, [cacheKey]: { videoId, at: new Date().toISOString() } })).catch(() => undefined);
  }
  // Meta procesa el video unos segundos antes de poder usarlo en un anuncio.
  for (let i = 0; i < 40; i++) {
    const st = await metaGet(`${videoId}?fields=status`, token).catch(() => null);
    const status = st?.status?.video_status;
    if (status === 'ready') break;
    if (status === 'error') throw new Error('Meta no pudo procesar el video: prueba con otro (MP4, menos de 50 MB).');
    if (i === 39) throw new Error('Meta sigue procesando el video: intenta crear la campaña de nuevo en unos minutos.');
    await new Promise(r => setTimeout(r, 5000));
  }
  // Portada: la que elige Meta (o la miniatura de la Biblioteca), subida como foto de la cuenta.
  let thumbBytes: Buffer | null = null;
  const thumbs = await metaGet(`${videoId}/thumbnails?fields=uri,is_preferred&limit=10`, token).catch(() => null);
  const best = (thumbs?.data || []).find((t: any) => t.is_preferred) || (thumbs?.data || [])[0];
  if (best?.uri) thumbBytes = await download(String(best.uri), 15 * 1024 * 1024).catch(() => null);
  if (!thumbBytes && m.thumb) thumbBytes = await download(m.thumb, 15 * 1024 * 1024).catch(() => null);
  if (!thumbBytes) throw new Error('No se pudo sacar la portada del video: intenta de nuevo en unos minutos.');
  return { videoId, thumbHash: await uploadImage(token, accountId, thumbBytes) };
}

/** Sube todas las fotos y videos de la campaña (cada uno una vez, en el tamaño que pide su formato). */
async function uploadAll(token: string, accountId: string, plan: CampaignPlan): Promise<Map<string, Uploaded>> {
  const up = new Map<string, Uploaded>();
  const jobs: { m: Media; kind: ImageKind }[] = [];
  for (const set of plan.adsets) {
    for (const ad of set.ads) {
      if (ad.media) jobs.push({ m: ad.media, kind: 'feed' });
      for (const c of ad.cards) jobs.push({ m: c.media, kind: 'square' });
    }
  }
  for (const { m, kind } of jobs) {
    // La misma foto en un anuncio (4:5) y en un carrusel (1:1) se sube en los dos tamaños.
    const key = m.kind === 'video' ? m.url : `${kind}:${m.url}`;
    if (up.has(key)) { up.set(m.url, up.get(key)!); continue; }
    let value: Uploaded;
    try {
      value = m.kind === 'video'
        ? await uploadVideo(token, accountId, m)
        : { hash: await uploadImage(token, accountId, await toInstagramJpeg(await download(m.url, 15 * 1024 * 1024), kind)) };
    } catch (error: any) {
      throw new Error(`No se pudo preparar ${m.kind === 'video' ? 'el video' : 'la foto'} (${m.url.split('/').pop()}): ${error.message}`);
    }
    up.set(key, value);
    up.set(m.url, value);
  }
  return up;
}

/** Para cada anuncio, el mapa de subidas con el tamaño que le toca a cada foto (4:5 suelta, 1:1 en carrusel). */
function uploadsFor(ad: CampaignAd, all: Map<string, Uploaded>): Map<string, Uploaded> {
  const out = new Map<string, Uploaded>();
  if (ad.media) out.set(ad.media.url, all.get(ad.media.kind === 'video' ? ad.media.url : `feed:${ad.media.url}`) || {});
  for (const c of ad.cards) out.set(c.media.url, all.get(c.media.kind === 'video' ? c.media.url : `square:${c.media.url}`) || {});
  return out;
}

/** El contenido con las mejoras automáticas apagadas (si Meta no acepta alguna, se quita y se reintenta). */
async function makeCreative(token: string, accountId: string, params: (textOptions: boolean) => Record<string, unknown>, warnings: string[], where: string, validateOnly = false): Promise<string> {
  let features = [...OPT_OUT_FEATURES];
  let textOptions = true;
  for (let attempt = 0; attempt < 8; attempt++) {
    try {
      const body: Record<string, unknown> = { ...params(textOptions), degrees_of_freedom_spec: featuresSpec(features) };
      if (validateOnly) body.execution_options = ['validate_only'];
      const created = await metaPost(`${accountId}/adcreatives`, token, body);
      return String(created.id || '');
    } catch (error: any) {
      const raw = JSON.stringify(error?.meta || {});
      const bad = features.filter(k => new RegExp(`(^|[^a-z0-9_])${k}([^a-z0-9_]|$)`).test(raw));
      if (bad.length) { features = features.filter(k => !bad.includes(k)); continue; }
      if (textOptions && /asset_feed_spec|dynamic|degrees_of_freedom|optimization_type/i.test(raw)) {
        textOptions = false;
        if (!validateOnly) warnings.push(`${where}: Meta no aceptó varias opciones de texto; lleva el primer texto y el primer título.`);
        continue;
      }
      throw new Error(`${where}: ${error.message}`);
    }
  }
  throw new Error(`${where}: Meta no aceptó el contenido del anuncio. Intenta de nuevo más tarde.`);
}

// ---------- Campañas creadas desde el CRM ----------

export interface CreatedCampaignAd {
  adId: string; creativeId: string; name: string; format: AdFormat; angle: string; products: string[]; image: string; text: string; status: 'PAUSED' | 'ACTIVE';
}
export interface CreatedCampaignAdset {
  adsetId: string; name: string; focus: string; dailyBudget: number; audience: AdsetAudience; placements: Placements; optimization?: string; ads: CreatedCampaignAd[];
}
export interface CreatedCampaign {
  campaignId: string; name: string; objective: Objective; destination: Destination; theme: string; hypothesis: string;
  budgetMode: 'conjunto' | 'campana'; campaignBudget: number; webEvent: string; attributionDays: number; startDate: string; endDate: string;
  status: 'PAUSED' | 'ACTIVE'; createdAt: string; adsets: CreatedCampaignAdset[];
  history: { at: string; action: string; detail: string }[]; warnings: string[];
  /** Hecha con el creador de anuncios de antes (una campaña de un solo anuncio). */
  legacy?: boolean;
}

/** Un anuncio del creador de antes, en la forma de campaña (un conjunto con un anuncio). */
export function fromLegacy(c: CreatedAd): CreatedCampaign {
  return {
    campaignId: c.campaignId, name: c.name, objective: c.destination === 'web' ? 'ventas' : 'interaccion', destination: c.destination, theme: c.theme,
    hypothesis: '', budgetMode: 'conjunto', campaignBudget: 0, webEvent: '', attributionDays: 7, startDate: '', endDate: '', status: c.status, createdAt: c.createdAt,
    adsets: [{
      adsetId: c.adsetId, name: c.theme, focus: '', dailyBudget: c.dailyBudget, audience: { ...c.audience, cities: [], interests: [] }, placements: { ...PLACEMENTS_AUTO },
      ads: [{ adId: c.adId, creativeId: c.creativeId, name: c.adName, format: c.format === 'carousel' ? 'carousel' : 'image', angle: '', products: c.products, image: c.image, text: c.text, status: c.status }]
    }],
    history: c.history, warnings: c.warnings, legacy: true
  };
}

/** Las campañas creadas desde el CRM (las del creador de antes se suman la primera vez). */
export async function readCampaigns(): Promise<CreatedCampaign[]> {
  let list: CreatedCampaign[] = [];
  try {
    const raw = await getConfig(CAMPAIGNS_KEY);
    const v = raw ? JSON.parse(raw) : [];
    list = Array.isArray(v) ? v : [];
  } catch {
    list = [];
  }
  const legacy = await readCreated();
  const known = new Set(list.map(c => c.campaignId));
  const missing = legacy.filter(c => !known.has(c.campaignId)).map(fromLegacy);
  return missing.length ? [...list, ...missing].sort((a, b) => b.createdAt.localeCompare(a.createdAt)) : list;
}

const writeCampaigns = (list: CreatedCampaign[]) => setConfig(CAMPAIGNS_KEY, JSON.stringify(list.slice(0, 60)));

const dayOf = (iso: string, timeZone: string) => {
  const p = localParts(new Date(iso), timeZone);
  return `${p.year}-${p.month}-${p.day}`;
};

/** Gasto por día de las campañas activas creadas desde el CRM (sin contar una). */
export function activeDailyOf(list: CreatedCampaign[], except = ''): number {
  return Math.round(list.filter(c => c.status === 'ACTIVE' && c.campaignId !== except).reduce((t, c) => t + dailyTotal({ budgetMode: c.budgetMode, campaignBudget: c.campaignBudget, adsets: c.adsets as any }), 0) * 100) / 100;
}

export function actionsTodayOf(list: CreatedCampaign[], timeZone: string, now = new Date(), kind?: string): number {
  const today = dayOf(now.toISOString(), timeZone);
  return list.reduce((n, c) => n + c.history.filter(h => dayOf(h.at, timeZone) === today && (!kind || h.action === kind)).length, 0);
}

const adsCreatedToday = (list: CreatedCampaign[], timeZone: string, now = new Date()) => {
  const today = dayOf(now.toISOString(), timeZone);
  return list.filter(c => dayOf(c.createdAt, timeZone) === today).reduce((n, c) => n + c.adsets.reduce((m, a) => m + a.ads.length, 0), 0);
};

const missingForPlan = (s: BuilderSettings, plan: CampaignPlan): string[] => {
  const out: string[] = [];
  if (!s.pageId) out.push('la página de Facebook');
  const needsWeb = plan.destination === 'web' || plan.objective === 'trafico';
  if (needsWeb && !s.webUrl) out.push('la dirección de tu página web');
  if (plan.destination === 'web' && (plan.objective === 'ventas' || plan.objective === 'interaccion') && !s.pixelId) out.push('el píxel de Meta de tu web');
  if (plan.destination === 'whatsapp' && !s.whatsappNumber) out.push('el número de WhatsApp de los anuncios');
  return out;
};

/**
 * Crea la campaña completa en Meta, EN PAUSA: sube fotos y videos, valida cada anuncio con Meta sin crearlo, y recién
 * entonces crea campaña, conjuntos, contenidos y anuncios. Si algo falla a la mitad, se borra la campaña entera.
 */
export async function createCampaign(raw: any, who = ''): Promise<CreatedCampaign> {
  return withLock(async () => {
    const { token, accountId } = await metaAccess();
    const s = await readBuilderSettings();
    const [catalog, library] = await Promise.all([adCatalog(), adLibrary()]);
    const { plan, errors } = normalizePlan(raw, { catalog, library, settings: s });
    if (errors.length) throw new Error(errors.join(' '));
    const missing = missingForPlan(s, plan);
    if (missing.length) throw new Error(`Antes de crear falta: ${missing.join(', ')} (en "Ajustes para crear anuncios").`);
    const account = await readAccount(token, accountId);
    if (!account.canWrite) throw new Error(account.problem);
    const low = plan.budgetMode === 'campana' ? (plan.campaignBudget < account.minDaily ? plan.campaignBudget : null) : plan.adsets.find(a => a.dailyBudget < account.minDaily)?.dailyBudget ?? null;
    if (low !== null) throw new Error(`Meta pide un presupuesto diario de al menos $${account.minDaily.toFixed(2)} por ${plan.budgetMode === 'campana' ? 'campaña' : 'conjunto'}.`);
    const problems = reviewPlan(plan, catalog, String(raw?.idea || '')).filter(i => i.level === 'error');
    if (problems.length) throw new Error(`Corrige esto antes de crear: ${problems.map(i => `${i.where}: ${i.text}`).join(' ')}`);
    const list = await readCampaigns();
    const zone = builderZone();
    if (actionsTodayOf(list, zone, new Date(), 'crear') >= MAX_CAMPAIGNS_PER_DAY) throw new Error(`Hoy ya se crearon ${MAX_CAMPAIGNS_PER_DAY} campañas desde el CRM. Para cuidar tu cuenta con Meta, la siguiente mañana.`);
    if (adsCreatedToday(list, zone) + adCount(plan) > MAX_NEW_ADS_PER_DAY) throw new Error(`Con esta campaña pasarías de ${MAX_NEW_ADS_PER_DAY} anuncios nuevos hoy. Para cuidar tu cuenta con Meta, crea menos anuncios o sigue mañana.`);

    const names = campaignNames(plan, profile().business.name, s.country, new Date(), zone);
    const uploads = await uploadAll(token, accountId, plan);
    const warnings: string[] = [];
    // Cada anuncio se valida con Meta antes de crear nada (validate_only: Meta revisa y no crea).
    for (const [si, set] of plan.adsets.entries()) {
      for (const [ai, ad] of set.ads.entries()) {
        await makeCreative(token, accountId, t => creativeParams(plan, ad, s, catalog, uploadsFor(ad, uploads), names.ads[si][ai], t), warnings, `Conjunto ${si + 1} · Anuncio ${ai + 1}`, true);
      }
    }

    const campaign = await metaPost(`${accountId}/campaigns`, token, campaignParams(plan, names.campaign));
    const campaignId = String(campaign.id);
    try {
      const sets: CreatedCampaignAdset[] = [];
      for (const [si, set] of plan.adsets.entries()) {
        let adset: any;
        try {
          adset = await metaPost(`${accountId}/adsets`, token, adsetParams(plan, set, s, campaignId, names.adsets[si], zone));
        } catch (error: any) {
          throw new Error(`Conjunto ${si + 1}: ${error.message}`);
        }
        const ads: CreatedCampaignAd[] = [];
        for (const [ai, ad] of set.ads.entries()) {
          const where = `Conjunto ${si + 1} · Anuncio ${ai + 1}`;
          const creativeId = await makeCreative(token, accountId, t => creativeParams(plan, ad, s, catalog, uploadsFor(ad, uploads), names.ads[si][ai], t), warnings, where);
          let created: any;
          try {
            created = await metaPost(`${accountId}/ads`, token, { name: names.ads[si][ai], adset_id: String(adset.id), creative: { creative_id: creativeId }, status: 'PAUSED' });
          } catch (error: any) {
            throw new Error(`${where}: ${error.message}`);
          }
          // Se revisa que Meta no haya prendido mejoras automáticas por su cuenta.
          const back = await metaGet(`${creativeId}?fields=degrees_of_freedom_spec`, token).catch(() => null);
          const on = Object.entries(back?.degrees_of_freedom_spec?.creative_features_spec || {}).filter(([, v]: any) => v?.enroll_status === 'OPT_IN').map(([k]) => k);
          if (on.length) warnings.push(`${where}: Meta dejó encendidas estas mejoras automáticas: ${on.join(', ')}.`);
          const products = productsOf(ad);
          const image = ad.media?.thumb || ad.media?.url || ad.cards[0]?.media.thumb || ad.cards[0]?.media.url || '';
          const categories = [...new Set(products.map(n => catalog.find(p => p.name === n)?.webCategory || ''))].filter(Boolean);
          await rememberCreatedAd(String(created.id), {
            ad_name: names.ads[si][ai], campaign_id: campaignId, campaign_name: names.campaign, adset_id: String(adset.id), adset_name: names.adsets[si],
            destination: plan.destination === 'whatsapp' ? 'whatsapp' : 'web', status: 'PAUSED',
            headline: ad.headlines[0] || ad.cards[0]?.title || '', body: ad.texts[0], image_url: image
          }, products, categories.length === 1 ? categories[0] : '').catch(error => console.warn('⚠️ No se registró el anuncio creado:', error.message));
          ads.push({ adId: String(created.id), creativeId, name: names.ads[si][ai], format: ad.format, angle: ad.angle, products, image, text: ad.texts[0], status: 'PAUSED' });
        }
        sets.push({ adsetId: String(adset.id), name: set.name, focus: set.focus, dailyBudget: set.dailyBudget, audience: set.audience, placements: set.placements, optimization: set.optimization, ads });
      }
      const now = new Date().toISOString();
      const record: CreatedCampaign = {
        campaignId, name: names.campaign, objective: plan.objective, destination: plan.destination, theme: plan.theme, hypothesis: plan.hypothesis,
        budgetMode: plan.budgetMode, campaignBudget: plan.campaignBudget, webEvent: plan.webEvent, attributionDays: plan.attributionDays,
        startDate: plan.startDate, endDate: plan.endDate, status: 'PAUSED', createdAt: now, adsets: sets, warnings: [...new Set(warnings)],
        history: [{ at: now, action: 'crear', detail: `Creada en pausa${who ? ` por ${who}` : ''}: ${sets.length} conjunto(s), ${adCount(plan)} anuncio(s) · $${dailyTotal(plan).toFixed(2)} por día` }]
      };
      await writeCampaigns([record, ...(await readCampaigns())]);
      overviewCache.clear();
      campaignsCache.clear();
      console.log(`📣 Campaña creada en pausa desde el CRM: ${names.campaign} (${campaignId})`);
      return record;
    } catch (error) {
      await metaCall('DELETE', campaignId, token).catch(e => console.warn(`⚠️ No se pudo borrar la campaña a medias ${campaignId}:`, e.message));
      throw error;
    }
  });
}

function findCampaign(list: CreatedCampaign[], campaignId: string): CreatedCampaign {
  const found = list.find(c => c.campaignId === campaignId);
  if (!found) throw new Error('Solo se manejan desde aquí las campañas creadas en el CRM. Las demás, en el Administrador de anuncios de Meta.');
  return found;
}

const note = (c: CreatedCampaign, action: string, detail: string) => {
  c.history.unshift({ at: new Date().toISOString(), action, detail });
  c.history = c.history.slice(0, 60);
};

/** Activa o pausa una campaña completa. Activar revisa la cuenta y el tope por día. */
export async function setCampaignActive(campaignId: string, active: boolean, who = ''): Promise<CreatedCampaign> {
  return withLock(async () => {
    const { token, accountId } = await metaAccess();
    const s = await readBuilderSettings();
    const list = await readCampaigns();
    const item = findCampaign(list, campaignId);
    if (actionsTodayOf(list, builderZone()) >= MAX_CHANGES_PER_DAY) throw new Error('Hoy ya se hicieron muchos cambios desde el CRM. Para cuidar tu cuenta con Meta, sigue mañana.');
    if (active) {
      const account = await readAccount(token, accountId);
      if (!account.canWrite) throw new Error(account.problem);
      const total = activeDailyOf(list, campaignId) + dailyTotal({ budgetMode: item.budgetMode, campaignBudget: item.campaignBudget, adsets: item.adsets as any });
      if (total > s.maxDaily) throw new Error(`Con esta campaña, lo activo sumaría $${total.toFixed(2)} por día y tu tope es $${s.maxDaily.toFixed(2)}. Pausa otra, baja presupuestos o sube el tope en Ajustes.`);
      for (const set of item.adsets) {
        for (const ad of set.ads) {
          await metaPost(ad.adId, token, { status: 'ACTIVE' });
          ad.status = 'ACTIVE';
        }
        await metaPost(set.adsetId, token, { status: 'ACTIVE' });
      }
      await metaPost(item.campaignId, token, { status: 'ACTIVE' });
    } else {
      await metaPost(item.campaignId, token, { status: 'PAUSED' });
    }
    item.status = active ? 'ACTIVE' : 'PAUSED';
    note(item, active ? 'activar' : 'pausar', `${active ? 'Activada' : 'Pausada'}${who ? ` por ${who}` : ''}`);
    await writeCampaigns(list);
    campaignsCache.clear();
    overviewCache.clear();
    return item;
  });
}

/** Pausa o vuelve a activar un anuncio de una campaña creada desde el CRM (no cambia el presupuesto). */
export async function setAdActive(campaignId: string, adId: string, active: boolean, who = ''): Promise<CreatedCampaign> {
  return withLock(async () => {
    const { token } = await metaAccess();
    const list = await readCampaigns();
    const item = findCampaign(list, campaignId);
    const ad = item.adsets.flatMap(a => a.ads).find(a => a.adId === adId);
    if (!ad) throw new Error('Ese anuncio no es de esta campaña.');
    if (actionsTodayOf(list, builderZone()) >= MAX_CHANGES_PER_DAY) throw new Error('Hoy ya se hicieron muchos cambios desde el CRM. Sigue mañana.');
    await metaPost(adId, token, { status: active ? 'ACTIVE' : 'PAUSED' });
    ad.status = active ? 'ACTIVE' : 'PAUSED';
    note(item, active ? 'activar anuncio' : 'pausar anuncio', `${active ? 'Activado' : 'Pausado'} el anuncio ${ad.name}${who ? ` (${who})` : ''}`);
    await writeCampaigns(list);
    campaignsCache.clear();
    return item;
  });
}

/** Cambia el presupuesto diario de un conjunto (o de la campaña), dentro del tope y pocas veces al día. */
export async function setCampaignBudget(campaignId: string, adsetId: string, daily: unknown, who = ''): Promise<CreatedCampaign> {
  return withLock(async () => {
    const { token, accountId } = await metaAccess();
    const s = await readBuilderSettings();
    const list = await readCampaigns();
    const item = findCampaign(list, campaignId);
    const value = Math.round(Number(daily) * 100) / 100;
    if (!Number.isFinite(value) || value < 1) throw new Error('El presupuesto diario mínimo es $1.');
    const set = item.budgetMode === 'conjunto' ? item.adsets.find(a => a.adsetId === adsetId) : null;
    if (item.budgetMode === 'conjunto' && !set) throw new Error('Ese conjunto no es de esta campaña.');
    const before = set ? set.dailyBudget : item.campaignBudget;
    const after = dailyTotal({ budgetMode: item.budgetMode, campaignBudget: set ? item.campaignBudget : value, adsets: item.adsets.map(a => (a === set ? { ...a, dailyBudget: value } : a)) as any });
    if (after > s.maxDaily) throw new Error(`La campaña sumaría $${after.toFixed(2)} por día y tu tope es $${s.maxDaily.toFixed(2)} (puedes subirlo en Ajustes).`);
    if (item.status === 'ACTIVE' && activeDailyOf(list, campaignId) + after > s.maxDaily) throw new Error(`Lo activo sumaría $${(activeDailyOf(list, campaignId) + after).toFixed(2)} por día y tu tope es $${s.maxDaily.toFixed(2)}.`);
    const today = dayOf(new Date().toISOString(), builderZone());
    if (item.history.filter(h => h.action === 'presupuesto' && dayOf(h.at, builderZone()) === today).length >= MAX_BUDGET_CHANGES_PER_DAY) {
      throw new Error('Esta campaña ya cambió de presupuesto varias veces hoy. Espera a mañana: cada cambio hace que Meta vuelva a aprender.');
    }
    const account = await readAccount(token, accountId);
    if (!account.canWrite) throw new Error(account.problem);
    if (value < account.minDaily) throw new Error(`Meta pide al menos $${account.minDaily.toFixed(2)} por día.`);
    await metaPost(set ? set.adsetId : item.campaignId, token, { daily_budget: Math.round(value * 100) });
    if (set) set.dailyBudget = value; else item.campaignBudget = value;
    note(item, 'presupuesto', `${set ? `Conjunto ${set.name}` : 'Campaña'}: $${before.toFixed(2)} → $${value.toFixed(2)} por día${who ? ` (${who})` : ''}`);
    await writeCampaigns(list);
    campaignsCache.clear();
    return item;
  });
}

// ---------- Lo que se ve en vivo ----------

/** Qué cuenta como "resultado" según el objetivo y el destino (el mismo resultado viene con varios nombres: no se suman). */
export function resultTypes(objective: Objective, destination: Destination, webEvent: string, optimization = ''): { label: string; types: string[] } {
  if (destination === 'whatsapp') return { label: 'Chats iniciados', types: RESULT_ACTIONS.whatsapp };
  if (objective === 'ventas') return { label: webEvent === 'PURCHASE' ? 'Compras' : webEvent === 'INITIATED_CHECKOUT' ? 'Pagos iniciados' : 'Agregados al carrito', types: RESULT_ACTIONS[webEvent] || RESULT_ACTIONS.ADD_TO_CART };
  if (objective === 'interaccion' && destination === 'web') return { label: 'Productos vistos', types: ['offsite_conversion.fb_pixel_view_content', 'omni_view_content', 'view_content'] };
  if (objective === 'interaccion') return optimization === 'reproducciones'
    ? { label: 'Reproducciones', types: ['video_thruplay_watched_actions', 'video_view'] }
    : { label: 'Interacciones', types: ['post_engagement', 'page_engagement'] };
  if (objective === 'trafico') return { label: 'Visitas a la web', types: ['landing_page_view', 'omni_landing_page_view'] };
  return { label: 'Personas alcanzadas', types: [] };
}

const campaignsCache = new Map<string, { at: number; data: any }>();

/** Las campañas creadas desde el CRM con estado, gasto y resultados de Meta y ventas del CRM por anuncio (caché de 1 minuto). */
export async function campaignsOverview() {
  const key = currentTenant()?.businessId || 'velamia';
  const hit = campaignsCache.get(key);
  if (hit && Date.now() - hit.at < 60_000) return hit.data;
  const s = await readBuilderSettings();
  const a = await adsAccess();
  const list = await readCampaigns();
  let account: AccountHealth | null = null;
  let liveError = '';
  const live = new Map<string, any>();
  const shown = list.slice(0, 15);
  const ids = shown.flatMap(c => c.adsets.flatMap(x => x.ads.map(ad => ad.adId))).slice(0, 150);
  if (a) {
    try {
      account = await readAccount(a.token, a.accountId);
      if (ids.length) {
        const filter = (chunk: string[]) => encodeURIComponent(JSON.stringify([{ field: 'ad.id', operator: 'IN', value: chunk }]));
        const ins = 'ad_id,spend,impressions,reach,inline_link_clicks,actions,action_values';
        for (let i = 0; i < ids.length; i += 50) {
          const chunk = ids.slice(i, i + 50);
          const [ads, today, total] = await Promise.all([
            metaGet(`?ids=${chunk.join(',')}&fields=effective_status,ad_review_feedback,issues_info`, a.token),
            metaGet(`${a.accountId}/insights?level=ad&filtering=${filter(chunk)}&date_preset=today&fields=${ins}&limit=100`, a.token),
            metaGet(`${a.accountId}/insights?level=ad&filtering=${filter(chunk)}&date_preset=maximum&fields=${ins}&limit=100`, a.token)
          ]);
          const byAd = (rows: any) => new Map<string, any>((rows?.data || []).map((r: any) => [String(r.ad_id), r]));
          const t = byAd(today), m = byAd(total);
          for (const id of chunk) live.set(id, { ad: ads?.[id], today: t.get(id), total: m.get(id) });
        }
      }
    } catch (error: any) {
      liveError = error.message;
    }
  }
  // Ventas del CRM desde la campaña más antigua de la lista (como mucho un año).
  const oldest = shown.reduce((m, c) => Math.min(m, Date.parse(c.createdAt) || Date.now()), Date.now());
  const crm = shown.length ? await adResults(new Date(Math.max(oldest - 86_400_000, Date.now() - 365 * 86_400_000)), new Date()).catch(() => null) : null;
  const sales = new Map((crm?.results || []).map(r => [r.adId, r]));
  // Lo que cambió en Meta (activado o pausado desde allá) se aplica después sobre la lista recién leída: así no se pisa
  // un cambio hecho desde el CRM mientras se leía Meta.
  const adChanges = new Map<string, 'ACTIVE' | 'PAUSED'>();
  const stopped = new Set<string>();
  const campaigns = shown.map(c => {
    const kind = (opt = '') => resultTypes(c.objective, c.destination, c.webEvent || s.webEvent, opt);
    const sum = { spendToday: 0, spendTotal: 0, impressions: 0, clicks: 0, results: 0, chats: 0, sales: 0, revenue: 0, webRevenue: 0 };
    const adsets = c.adsets.map(set => {
      const r = kind(set.optimization || '');
      const ads = set.ads.map(ad => {
        const l = live.get(ad.adId);
        const status = String(l?.ad?.effective_status || '');
        const reasons = Object.values(l?.ad?.ad_review_feedback?.global || {}).map(String);
        const issues = (l?.ad?.issues_info || []).map((i: any) => String(i.error_summary || i.error_message || '')).filter(Boolean);
        const results = r.types.length ? actionValue(l?.total?.actions, r.types) : Number(l?.total?.reach || 0);
        const webRevenue = actionValue(l?.total?.action_values, RESULT_ACTIONS.PURCHASE);
        const crmRow = sales.get(ad.adId);
        // Si se activó o pausó desde Meta, el CRM se pone al día.
        if (status) {
          const running = ['ACTIVE', 'PENDING_REVIEW', 'IN_PROCESS', 'PREAPPROVED', 'WITH_ISSUES'].includes(status);
          if (ad.status === 'ACTIVE' && !running && status !== 'CAMPAIGN_PAUSED' && status !== 'ADSET_PAUSED') { ad.status = 'PAUSED'; adChanges.set(ad.adId, 'PAUSED'); }
          else if (ad.status === 'PAUSED' && running) { ad.status = 'ACTIVE'; adChanges.set(ad.adId, 'ACTIVE'); }
        }
        const row = {
          ...ad, live: l ? {
            status, statusLabel: STATUS_LABEL[status] || status || '—', reasons, issues,
            spendToday: Number(l.today?.spend || 0), spendTotal: Number(l.total?.spend || 0), impressions: Number(l.total?.impressions || 0),
            clicks: Number(l.total?.inline_link_clicks || 0), results, webRevenue
          } : null,
          crm: { chats: crmRow?.chats || 0, quotations: crmRow?.quotations || 0, sales: crmRow?.sales || 0, revenue: crmRow?.revenue || 0 }
        };
        if (row.live) {
          sum.spendToday += row.live.spendToday; sum.spendTotal += row.live.spendTotal; sum.impressions += row.live.impressions;
          sum.clicks += row.live.clicks; sum.results += row.live.results; sum.webRevenue += row.live.webRevenue;
        }
        sum.chats += row.crm.chats; sum.sales += row.crm.sales; sum.revenue += row.crm.revenue;
        return row;
      });
      return { ...set, resultLabel: r.label, ads };
    });
    const allStatus = adsets.flatMap(x => x.ads.map(ad => ad.live?.status)).filter(Boolean) as string[];
    const campaignLive = allStatus.length ? (allStatus.includes('ACTIVE') ? 'ACTIVE' : allStatus.find(st => st === 'PENDING_REVIEW' || st === 'IN_PROCESS') || allStatus[0]) : '';
    if (c.status === 'ACTIVE' && campaignLive && ['PAUSED', 'CAMPAIGN_PAUSED', 'ARCHIVED', 'DELETED'].includes(campaignLive)) { c.status = 'PAUSED'; stopped.add(c.campaignId); }
    const round2 = (n: number) => Math.round(n * 100) / 100;
    const revenue = sum.revenue + sum.webRevenue;
    return {
      ...c, adsets, resultLabel: kind().label, liveStatus: campaignLive, liveLabel: STATUS_LABEL[campaignLive] || '',
      totals: { ...sum, spendToday: round2(sum.spendToday), spendTotal: round2(sum.spendTotal), revenue: round2(sum.revenue), webRevenue: round2(sum.webRevenue), roas: sum.spendTotal > 0 && revenue > 0 ? Math.round((revenue / sum.spendTotal) * 10) / 10 : null },
      daily: dailyTotal({ budgetMode: c.budgetMode, campaignBudget: c.campaignBudget, adsets: c.adsets as any })
    };
  });
  if (adChanges.size || stopped.size) {
    const fresh = await readCampaigns().catch(() => null);
    if (fresh) {
      for (const c of fresh) {
        for (const set of c.adsets) for (const ad of set.ads) if (adChanges.has(ad.adId)) ad.status = adChanges.get(ad.adId)!;
        if (stopped.has(c.campaignId) && c.status === 'ACTIVE') { c.status = 'PAUSED'; note(c, 'meta', 'Quedó detenida en Meta'); }
      }
      await writeCampaigns(fresh).catch(() => undefined);
    }
  }
  const zone = builderZone();
  const data = {
    connected: !!a, accountId: a?.accountId || '', settings: s, account, liveError, campaigns, activeDaily: activeDailyOf(list),
    limits: {
      campaignsPerDay: MAX_CAMPAIGNS_PER_DAY, campaignsToday: actionsTodayOf(list, zone, new Date(), 'crear'), adsPerDay: MAX_NEW_ADS_PER_DAY,
      adsToday: adsCreatedToday(list, zone), maxAdsets: MAX_ADSETS, maxAdsPerAdset: MAX_ADS_PER_ADSET
    },
    ai: { configured: !!(await getSocialAi().catch(() => null))?.apiKey }
  };
  campaignsCache.set(key, { at: Date.now(), data });
  return data;
}

// ---------- Públicos: intereses y ciudades (búsqueda oficial de Meta) ----------

const searchCache = new Map<string, { at: number; data: any[] }>();

/** Busca intereses (para segmentación detallada) o ciudades del país de la empresa con la búsqueda de Meta. */
export async function searchTargeting(type: 'interes' | 'ciudad', q: string): Promise<any[]> {
  const query = short(q, 60);
  if (query.length < 2) return [];
  const { token } = await metaAccess();
  const s = await readBuilderSettings();
  const key = `${type}:${s.country}:${plain(query)}`;
  const hit = searchCache.get(key);
  if (hit && Date.now() - hit.at < 24 * 3600_000) return hit.data;
  const path = type === 'interes'
    ? `search?type=adinterest&q=${encodeURIComponent(query)}&locale=es_LA&limit=12`
    : `search?type=adgeolocation&location_types=${encodeURIComponent(JSON.stringify(['city']))}&country_code=${s.country}&q=${encodeURIComponent(query)}&limit=12`;
  const r = await metaGet(path, token);
  const data = (r?.data || []).map((x: any) => type === 'interes'
    ? { id: String(x.id), name: String(x.name || ''), size: Number(x.audience_size_upper_bound || x.audience_size || 0), path: (x.path || []).join(' › ') }
    : { key: String(x.key), name: String(x.name || ''), region: String(x.region || '') });
  searchCache.set(key, { at: Date.now(), data });
  return data;
}

// ---------- La IA arma la campaña ----------

const CTA_WORDS: Record<Cta, string> = { SHOP_NOW: 'Comprar', ORDER_NOW: 'Pedir ahora', BUY_NOW: 'Comprar ya', LEARN_MORE: 'Más información', WHATSAPP_MESSAGE: 'Enviar mensaje', NONE: 'Sin botón' };

interface AiAd {
  formato: AdFormat; nombre: string; angulo: string; producto: string; biblioteca_id: string; textos: string[]; titulos: string[]; descripcion: string; boton: string;
  tarjetas: { producto: string; biblioteca_id: string; titulo: string; descripcion: string }[];
}
interface AiAdset { nombre: string; enfoque: string; edad_min: number; edad_max: number; genero: Gender; intereses: string[]; ciudades: string[]; presupuesto: number; anuncios: AiAd[] }
interface AiCampaign { tema: string; hipotesis: string; explicacion: string; conjuntos: AiAdset[] }

export interface ProposeCampaignInput {
  objective?: unknown; destination?: unknown; idea?: unknown; products?: unknown; assets?: unknown; adsets?: unknown; adsPerAdset?: unknown;
  mix?: unknown; budget?: unknown;
}

const destinationGuide = (objective: Objective, destination: Destination) => {
  if (destination === 'web') return objective === 'ventas'
    ? 'Lleva a la PÁGINA WEB a comprar: invita a ver y pedir en la web ("Pídelas en nuestra web"). Nunca menciones WhatsApp.'
    : 'Lleva a la PÁGINA WEB a mirar los productos: invita a conocer los modelos. Nunca menciones WhatsApp.';
  if (destination === 'whatsapp') return 'Abre un chat de WHATSAPP con la tienda: invita a escribir para cotizar o pedir ("Escríbenos y te cotizamos").';
  return objective === 'reconocimiento'
    ? 'Busca que mucha gente conozca la marca: textos cortos y memorables sobre la marca y sus productos.'
    : 'Busca reacciones, comentarios o reproducciones en el mismo anuncio: textos cercanos que hagan detenerse a mirar (sin pedir que comenten ni compartan).';
};

/** La IA del agente de redes arma la campaña completa con el Catálogo, la Biblioteca y lo aprendido de campañas anteriores. */
export async function proposeCampaign(input: ProposeCampaignInput) {
  const s = await readBuilderSettings();
  const [catalog, library] = await Promise.all([adCatalog(), adLibrary()]);
  const objective: Objective = (Object.keys(OBJECTIVES) as Objective[]).includes(input.objective as Objective) ? input.objective as Objective : 'ventas';
  const destination: Destination = OBJECTIVES[objective].destinations.includes(input.destination as Destination) ? input.destination as Destination : OBJECTIVES[objective].destinations[0];
  const idea = short(input.idea, 800);
  const nSets = clampInt(input.adsets, 1, MAX_ADSETS, 1);
  const nAds = clampInt(input.adsPerAdset, 1, MAX_ADS_PER_ADSET, 4);
  const mix = input.mix && typeof input.mix === 'object' ? input.mix as any : null;
  const budget = money(input.budget, 1, s.maxDaily, Math.min(3, s.maxDaily));
  const find = finder(catalog);
  const chosen = [...new Set((Array.isArray(input.products) ? input.products : []).map(n => find(n)).filter(Boolean) as PickProduct[])].filter(p => p.images.length).slice(0, 30);
  const chosenAssets = (Array.isArray(input.assets) ? input.assets : []).map(id => library.find(a => a.id === id)).filter(Boolean) as LibraryItem[];
  if (!chosen.length && !idea) throw new Error('Elige productos del Catálogo o escribe la idea de la campaña.');
  const p = profile();
  const b = p.business;
  const social = await getSocialAi().catch(() => null);
  const now = localParts(new Date(), builderZone());
  const learned = await learningsForPrompt().catch(() => '');
  const productLine = (x: PickProduct) => ({ nombre: x.name, como_decirlo: x.displayName || x.name, precio: `$${x.price % 1 ? x.price.toFixed(2) : x.price} ${x.unit === p.sales.unitSingular ? p.sales.priceSuffix : `c/${x.unit}`}`, categoria: x.category });
  const libLine = (a: LibraryItem) => ({ id: a.id, tipo: a.kind === 'video' ? 'video' : 'foto', titulo: a.title, producto: a.product, segundos: a.duration, veces_usado: a.usedCount });
  const library4ai = [...chosenAssets, ...library.filter(a => !chosenAssets.includes(a))].slice(0, 80);
  const mixText = mix ? `En cada conjunto: ${Number(mix.image) || 0} de foto, ${Number(mix.video) || 0} de video y ${Number(mix.carousel) || 0} carrusel(es).` : 'Mezcla formatos: casi siempre al menos un video (si hay videos en la Biblioteca) y fotos de productos; carrusel cuando varios productos lucen juntos.';
  const ctas = CTAS[destination].map(c => `${c} (${CTA_WORDS[c]})`).join(', ');
  const system = [
    `Eres quien planifica y escribe las campañas pagadas de Meta (Facebook e Instagram) de ${b.name}, ${b.description}${b.city ? ` en ${b.city}` : ''}. Escribe en español natural y cálido, como una persona de la marca.`,
    `- Objetivo: ${OBJECTIVES[objective].label}. ${destinationGuide(objective, destination)}`,
    `- Arma ${nSets} conjunto(s) de anuncios con ${nAds} anuncio(s) cada uno. ${mixText}`,
    '- Cada conjunto prueba UNA cosa distinta (un público, una ocasión o un tipo de producto) y lo dice en "enfoque". Dentro del conjunto, cada anuncio prueba un ángulo distinto ("angulo": precio, ocasión, hecho a mano, testimonio, regalo, detalle del producto…).',
    '- "intereses": de 1 a 4 intereses de Meta en español por conjunto (por ejemplo "Fiestas premamá", "Maternidad", "Halloween"). "ciudades": vacío salvo que la idea pida ciudades. "presupuesto": dólares por día del conjunto.',
    `- "formato": "image" (una foto del producto), "video" (un video de la Biblioteca: pon su id en "biblioteca_id") o "carousel" (de 2 a 10 tarjetas, cada una con su producto o foto de la Biblioteca y su propio título y descripción). Usa solo ids de la Biblioteca dada y nombres exactos de productos dados.`,
    '- Para "image": pon el "producto" (nombre exacto) o, si es una foto de la Biblioteca, su "biblioteca_id". En "video" el producto es opcional (si el video muestra uno).',
    '- "textos": 5 textos principales distintos (90 a 220 letras): el primero engancha con el ángulo del anuncio; menciona productos con su precio exacto cuando sirva; cierra con una invitación clara. "titulos": 5 de máximo 40 letras. "descripcion": máximo 30 letras.',
    '- Nombra los productos de forma natural (usa "como_decirlo" o algo más corto), nunca en MAYÚSCULAS. En "producto" sí va el nombre exacto para identificarlo.',
    `- "boton": uno de ${ctas}.`,
    '- "nombre" del anuncio: 2 a 4 palabras ("Osito en nube", "Video taller"). "tema": 1 a 3 palabras para la campaña. "hipotesis": qué se quiere aprender con esta campaña, en una frase. "explicacion": 2 o 3 frases simples para la dueña.',
    META_RULES,
    learned ? `\nLO QUE YA APRENDIMOS DE CAMPAÑAS ANTERIORES (úsalo: repite lo que funcionó, evita lo que no, y prueba algo nuevo en al menos un anuncio):\n${learned}` : '',
    social?.prompt?.trim() ? `\nINSTRUCCIONES DE LA EMPRESA PARA SUS REDES (síguelas salvo que choquen con las reglas de Meta o pidan inventar precios o promociones):\n${social.prompt.trim().slice(0, 4000)}` : ''
  ].filter(Boolean).join('\n');
  const user = JSON.stringify({
    hoy: `${now.day}/${now.month}/${now.year}`, objetivo: OBJECTIVES[objective].label, destino: DESTINATION_LABEL[destination], idea_de_la_empresa: idea || '(sin idea: decide tú)',
    presupuesto_por_conjunto: budget,
    productos: chosen.length ? chosen.map(productLine) : catalog.filter(x => x.images.length).slice(0, 250).map(productLine),
    biblioteca: library4ai.map(libLine), biblioteca_elegida: chosenAssets.map(a => a.id)
  });
  const adSchema = {
    type: 'object', additionalProperties: false, required: ['formato', 'nombre', 'angulo', 'producto', 'biblioteca_id', 'textos', 'titulos', 'descripcion', 'boton', 'tarjetas'],
    properties: {
      formato: { type: 'string', enum: ['image', 'video', 'carousel'] }, nombre: { type: 'string' }, angulo: { type: 'string' }, producto: { type: 'string' }, biblioteca_id: { type: 'string' },
      textos: { type: 'array', items: { type: 'string' } }, titulos: { type: 'array', items: { type: 'string' } }, descripcion: { type: 'string' }, boton: { type: 'string' },
      tarjetas: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['producto', 'biblioteca_id', 'titulo', 'descripcion'], properties: { producto: { type: 'string' }, biblioteca_id: { type: 'string' }, titulo: { type: 'string' }, descripcion: { type: 'string' } } } }
    }
  };
  const schema = {
    type: 'object', additionalProperties: false, required: ['tema', 'hipotesis', 'explicacion', 'conjuntos'],
    properties: {
      tema: { type: 'string' }, hipotesis: { type: 'string' }, explicacion: { type: 'string' },
      conjuntos: {
        type: 'array', items: {
          type: 'object', additionalProperties: false, required: ['nombre', 'enfoque', 'edad_min', 'edad_max', 'genero', 'intereses', 'ciudades', 'presupuesto', 'anuncios'],
          properties: {
            nombre: { type: 'string' }, enfoque: { type: 'string' }, edad_min: { type: 'integer' }, edad_max: { type: 'integer' }, genero: { type: 'string', enum: ['mujeres', 'hombres', 'todos'] },
            intereses: { type: 'array', items: { type: 'string' } }, ciudades: { type: 'array', items: { type: 'string' } }, presupuesto: { type: 'number' }, anuncios: { type: 'array', items: adSchema }
          }
        }
      }
    }
  };
  const ai = await askSocialJson<AiCampaign>({ system, user, schemaName: 'campana', schema, maxTokens: 16000 });
  // Intereses y ciudades se buscan en Meta por su nombre (solo los que existen de verdad).
  const resolve = async (type: 'interes' | 'ciudad', names: string[]) => {
    const out: any[] = [];
    for (const n of names.slice(0, 4)) {
      const found = await searchTargeting(type, n).catch(() => []);
      const best = found.find((x: any) => plain(x.name) === plain(n)) || found[0];
      if (best && !out.some(o => (o.id || o.key) === (best.id || best.key))) out.push(type === 'interes' ? { id: best.id, name: best.name } : { key: best.key, name: best.name, radius: 25 });
    }
    return out;
  };
  const sets = [];
  for (const set of (ai.conjuntos || []).slice(0, nSets)) {
    sets.push({ ...set, _interests: await resolve('interes', set.intereses || []), _cities: await resolve('ciudad', set.ciudades || []) });
  }
  return { ...buildCampaignProposal({ ...ai, conjuntos: sets }, { objective, destination, chosen, catalog, library, settings: s, idea, budget, nAds }), explanation: short(ai.explicacion, 600) };
}

/** Del JSON de la IA al borrador: solo productos, fotos y videos reales, textos que pasan las reglas y límites de la empresa. */
export function buildCampaignProposal(ai: Omit<AiCampaign, 'conjuntos'> & { conjuntos: (AiAdset & { _interests?: Interest[]; _cities?: City[] })[] }, o: {
  objective: Objective; destination: Destination; chosen: PickProduct[]; catalog: PickProduct[]; library: LibraryItem[]; settings: BuilderSettings; idea: string; budget: number; nAds: number;
}) {
  const chosenByName = new Map(o.chosen.map(p => [plain(p.name), p]));
  const find = finder(o.catalog);
  const product = (name: string) => chosenByName.get(plain(name)) || find(undefined, name);
  const asset = (id: string) => o.library.find(a => a.id === id);
  const ctaList = CTAS[o.destination];
  const toMedia = (a: LibraryItem): Media => ({ kind: a.kind, url: a.url, source: 'biblioteca', assetId: a.id, thumb: a.thumb });
  const photoOf = (p: PickProduct): Media => ({ kind: 'image', url: p.images[0], source: 'catalogo', assetId: '', thumb: p.images[0] });
  const plan: CampaignPlan = {
    objective: o.objective, destination: o.destination, webEvent: o.settings.webEvent, attributionDays: o.settings.attributionDays,
    theme: short(ai.tema, 40) || 'Campaña', hypothesis: short(ai.hipotesis, 300), budgetMode: 'conjunto', campaignBudget: 0, startDate: '', endDate: '',
    adsets: (ai.conjuntos || []).map((set, si) => {
      const audience: AdsetAudience = {
        ...normalizeAudience({ ageMin: set.edad_min, ageMax: set.edad_max, gender: set.genero, advantage: false }, o.settings.audience),
        cities: set._cities || [], interests: set._interests || []
      };
      const ads: CampaignAd[] = [];
      for (const a of (set.anuncios || []).slice(0, o.nAds)) {
        let format: AdFormat = ['image', 'video', 'carousel'].includes(a.formato) ? a.formato : 'image';
        const p = a.producto ? product(a.producto) : undefined;
        const lib = a.biblioteca_id ? asset(a.biblioteca_id) : undefined;
        let media: Media | null = null;
        const cards: CampaignCard[] = [];
        if (format === 'video') {
          const video = lib?.kind === 'video' ? lib : o.library.find(x => x.kind === 'video');
          if (video) media = toMedia(video); else format = 'image';
        }
        if (format === 'carousel') {
          for (const t of (a.tarjetas || []).slice(0, 10)) {
            const cp = t.producto ? product(t.producto) : undefined;
            const cl = t.biblioteca_id ? asset(t.biblioteca_id) : undefined;
            const m = cl ? toMedia(cl) : cp?.images.length ? photoOf(cp) : null;
            if (!m || cards.some(c => c.media.url === m.url)) continue;
            cards.push({ media: m, productId: cp?.id || '', product: cp?.name || '', title: short(t.titulo, 80) || cp?.displayName || cp?.name || '', description: short(t.descripcion, 80) });
          }
          if (cards.length < 2) format = 'image';
        }
        if (format === 'image') {
          media = lib?.kind === 'image' ? toMedia(lib) : p?.images.length ? photoOf(p) : o.chosen[ads.length % Math.max(1, o.chosen.length)] ? photoOf(o.chosen[ads.length % o.chosen.length]) : null;
          if (!media) continue;
        }
        const ownProduct = p || (format === 'image' && media?.source === 'catalogo' ? o.catalog.find(x => x.images.includes(media!.url)) : undefined);
        ads.push({
          format, name: short(a.nombre, 60), angle: short(a.angulo, 80), media: format === 'carousel' ? null : media,
          productId: ownProduct?.id || '', product: ownProduct?.name || '',
          texts: textList(a.textos, 5, 600),
          // Una foto o un video sin título (por ejemplo, un carrusel que quedó como foto) toma el nombre del producto.
          headlines: textList(a.titulos, 5, 80).length || format === 'carousel' ? textList(a.titulos, 5, 80) : [short(ownProduct?.displayName || ownProduct?.name || a.nombre || ai.tema, 80)].filter(Boolean),
          description: short(a.descripcion, 80),
          cta: ctaList.includes(a.boton as Cta) ? a.boton as Cta : ctaList[0], link: ownProduct ? 'producto' : 'categoria',
          cards: format === 'carousel' ? cards : []
        });
      }
      return {
        name: short(set.nombre, 50) || `Conjunto ${si + 1}`, focus: short(set.enfoque, 200), audience,
        dailyBudget: money(set.presupuesto, 1, o.settings.maxDaily, o.budget), placements: { ...PLACEMENTS_AUTO },
        optimization: 'interacciones' as const, ads
      };
    }).filter(set => set.ads.length)
  };
  if (!plan.adsets.length) throw new Error('La IA no pudo armar anuncios con fotos o videos reales. Elige productos con foto o sube videos a la Biblioteca.');
  // Los textos que no pasan las reglas se quitan (si quedan otros).
  const toWeb = o.destination !== 'whatsapp';
  for (const set of plan.adsets) {
    for (const ad of set.ads) {
      const prices = allowedPrices(o.catalog, productsOf(ad), o.idea);
      const ok = (t: string) => !textIssues(t, '', { toWeb, prices, idea: o.idea }).some(i => i.level === 'error');
      const texts = ad.texts.filter(ok);
      if (texts.length) ad.texts = texts;
      const titles = ad.headlines.filter(ok);
      if (titles.length) ad.headlines = titles;
    }
  }
  // El presupuesto de la IA se ajusta al tope de la empresa.
  while (dailyTotal(plan) > o.settings.maxDaily && plan.adsets.some(a => a.dailyBudget > 1)) {
    for (const a of plan.adsets) a.dailyBudget = Math.max(1, Math.round((a.dailyBudget - 0.5) * 100) / 100);
  }
  return { plan, issues: reviewPlan(plan, o.catalog, o.idea) };
}

/** Textos nuevos con la IA: para un anuncio (5 textos, 5 títulos y descripción) o para una tarjeta del carrusel (3 opciones). */
export async function writeTexts(input: any) {
  const s = await readBuilderSettings();
  const catalog = await adCatalog();
  const find = finder(catalog);
  const objective: Objective = (Object.keys(OBJECTIVES) as Objective[]).includes(input?.objective) ? input.objective : 'ventas';
  const destination: Destination = OBJECTIVES[objective].destinations.includes(input?.destination) ? input.destination : OBJECTIVES[objective].destinations[0];
  const idea = short(input?.idea, 600);
  const mode = input?.mode === 'tarjeta' ? 'tarjeta' : 'anuncio';
  const products = (Array.isArray(input?.products) ? input.products : []).map((n: unknown) => find(n)).filter(Boolean).slice(0, 10) as PickProduct[];
  const p = profile();
  const b = p.business;
  const social = await getSocialAi().catch(() => null);
  const learned = await learningsForPrompt().catch(() => '');
  const lines = products.map(x => ({ nombre: x.name, como_decirlo: x.displayName || x.name, precio: `$${x.price % 1 ? x.price.toFixed(2) : x.price} ${x.unit === p.sales.unitSingular ? p.sales.priceSuffix : `c/${x.unit}`}`, categoria: x.category, descripcion: x.description }));
  const system = [
    `Escribes textos de anuncios pagados de Meta de ${b.name}, ${b.description}. Español natural y cálido.`,
    `- Objetivo: ${OBJECTIVES[objective].label}. ${destinationGuide(objective, destination)}`,
    mode === 'tarjeta'
      ? '- Escribe 3 opciones distintas para UNA tarjeta de carrusel: "titulo" de máximo 40 letras (puede llevar el precio exacto) y "descripcion" de máximo 30 letras.'
      : '- Escribe 5 "textos" principales distintos (90 a 220 letras) con el ángulo pedido, 5 "titulos" de máximo 40 letras y una "descripcion" de máximo 30 letras.',
    '- Nombra los productos de forma natural (nunca en MAYÚSCULAS). Precios exactamente como vienen.',
    META_RULES,
    learned ? `\nLO QUE YA APRENDIMOS:\n${learned}` : '',
    social?.prompt?.trim() ? `\nINSTRUCCIONES DE LA EMPRESA:\n${social.prompt.trim().slice(0, 3000)}` : ''
  ].filter(Boolean).join('\n');
  const user = JSON.stringify({
    formato: input?.format === 'video' ? 'video' : input?.format === 'carousel' ? 'carrusel' : 'foto', angulo: short(input?.angle, 80), idea: idea || '(sin idea)',
    productos: lines, foto_o_video: short(input?.mediaTitle, 120), textos_actuales: textList(input?.current, 5, 600)
  });
  const prices = allowedPrices(catalog, products.map(x => x.name), idea);
  const toWeb = destination !== 'whatsapp';
  const ok = (t: string) => !textIssues(t, '', { toWeb, prices, idea }).some(i => i.level === 'error');
  if (mode === 'tarjeta') {
    const schema = { type: 'object', additionalProperties: false, required: ['opciones'], properties: { opciones: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['titulo', 'descripcion'], properties: { titulo: { type: 'string' }, descripcion: { type: 'string' } } } } } };
    const out = await askSocialJson<{ opciones: { titulo: string; descripcion: string }[] }>({ system, user, schemaName: 'tarjeta', schema, maxTokens: 1500 });
    return { options: (out.opciones || []).map(x => ({ title: short(x.titulo, 80), description: short(x.descripcion, 80) })).filter(x => x.title && ok(`${x.title}\n${x.description}`)).slice(0, 3) };
  }
  const schema = { type: 'object', additionalProperties: false, required: ['textos', 'titulos', 'descripcion'], properties: { textos: { type: 'array', items: { type: 'string' } }, titulos: { type: 'array', items: { type: 'string' } }, descripcion: { type: 'string' } } };
  const out = await askSocialJson<{ textos: string[]; titulos: string[]; descripcion: string }>({ system, user, schemaName: 'textos', schema, maxTokens: 3000 });
  return { texts: textList(out.textos, 5, 600).filter(ok), headlines: textList(out.titulos, 5, 80).filter(ok), description: ok(out.descripcion || '') ? short(out.descripcion, 80) : '' };
}

/** Todo lo que necesita el creador en el CRM: ajustes, catálogo con fotos, biblioteca y las opciones de objetivos. */
export async function builderOptions() {
  const [catalog, library] = await Promise.all([adCatalog(), adLibrary()]);
  return {
    catalog: catalog.filter(p => p.images.length), library,
    objectives: Object.entries(OBJECTIVES).map(([id, o]) => ({ id, label: o.label, destinations: o.destinations })),
    ctas: Object.fromEntries(Object.entries(CTAS).map(([d, list]) => [d, list.map(c => ({ id: c, label: CTA_WORDS[c] }))])),
    destinationLabels: DESTINATION_LABEL
  };
}
