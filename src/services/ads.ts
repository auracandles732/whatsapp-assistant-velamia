import { createHash, randomBytes, timingSafeEqual } from 'crypto';
import { supabase, tenantColumns, tenantOp, tenantValue, parseDbTimestamp, getAllProducts, getConfig, setConfig, getActiveTenants } from './supabase';
import { encryptSecret, decryptSecret, maskSecret, currentTenant, runWithTenant } from './tenant';
import { profile } from '../config/businessProfile';
import { plain, localParts } from '../social/posts';

/**
 * Atribución de anuncios de Meta (para todas las empresas). Cuando una clienta escribe desde un anuncio que abre
 * WhatsApp (o Instagram/Messenger), Meta manda en el primer mensaje de qué anuncio vino: el chat queda unido a ese
 * anuncio y la vendedora sabe qué producto vio. Si llegó por la web, el botón de WhatsApp lleva una referencia
 * (Ref: K7M2QX) que dice de qué anuncio venía y qué producto miraba. Con la cuenta publicitaria conectada se leen los
 * anuncios (nombre, campaña, producto) y lo gastado, y se ve qué anuncio deja ventas de verdad.
 * Los totales no se guardan: se calculan. Sin la migración 027 todo sigue funcionando, solo que sin esto.
 */

const REGISTRY = 'ad_registry';
const ORIGINS = 'lead_origins';
const WEB_REFS = 'web_refs';
const SETTINGS_KEY = 'meta_ads';
const GRAPH = 'https://graph.facebook.com/v25.0';

export const MISSING_ADS_MIGRATION = 'Falta activar la medición de anuncios: hay que aplicar migrations/027_atribucion_de_anuncios.sql en Supabase.';

let available: { ok: boolean; at: number } | null = null;
let warned = false;

/** ¿Ya se aplicó la migración 027? Se revisa cada 10 minutos. */
export async function adsAvailable(): Promise<boolean> {
  if (available && Date.now() - available.at < 10 * 60_000) return available.ok;
  const { error } = await supabase.from(REGISTRY).select('id').limit(1);
  const ok = !error;
  if (!ok && !warned) {
    console.warn('⚠️ Atribución de anuncios apagada: falta aplicar migrations/027_atribucion_de_anuncios.sql en Supabase');
    warned = true;
  }
  available = { ok, at: Date.now() };
  return ok;
}

// ---------- Cuenta publicitaria (token cifrado) y llave para apps de reportes ----------

interface AdsSettings { accountId: string; token: string; reportKeyHash: string; reportKeyHint: string; lastSyncAt: string; lastSyncError: string }

async function readSettings(): Promise<AdsSettings> {
  let s: any = {};
  try {
    const raw = await getConfig(SETTINGS_KEY);
    s = raw ? JSON.parse(raw) : {};
  } catch {
    s = {};
  }
  return {
    accountId: String(s.accountId || ''), token: String(s.token || ''), reportKeyHash: String(s.reportKeyHash || ''),
    reportKeyHint: String(s.reportKeyHint || ''), lastSyncAt: String(s.lastSyncAt || ''), lastSyncError: String(s.lastSyncError || '')
  };
}

const writeSettings = (next: AdsSettings) => setConfig(SETTINGS_KEY, JSON.stringify(next));

function tokenOf(s: AdsSettings): string {
  try {
    return decryptSecret(s.token);
  } catch {
    return '';
  }
}

/** Lo que ve el CRM: nunca el token ni la llave, solo sus últimos 4 caracteres. */
export async function publicAdsSettings() {
  const s = await readSettings();
  const token = tokenOf(s);
  return {
    connected: !!(token && s.accountId), accountId: s.accountId, tokenHint: maskSecret(token),
    reportKey: !!s.reportKeyHash, reportKeyHint: s.reportKeyHint ? `••••${s.reportKeyHint}` : '',
    lastSyncAt: s.lastSyncAt || null, lastSyncError: s.lastSyncError || ''
  };
}

export function normalizeAccountId(value: unknown): string {
  const digits = String(value ?? '').trim().replace(/^act_/i, '');
  return /^\d{5,30}$/.test(digits) ? `act_${digits}` : '';
}

function metaError(error: any): string {
  const message = String(error?.message || 'Meta no respondió');
  if (error?.code === 190) return 'El token de anuncios venció o no es válido: genera uno nuevo en Meta.';
  if (error?.code === 200 || /ads_read|ads_management/i.test(message)) return 'El token no tiene permiso para leer los anuncios de esa cuenta (ads_read).';
  return message.slice(0, 220);
}

async function graph(path: string, token: string): Promise<any> {
  const res = await fetch(`${GRAPH}/${path}`, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(25_000) });
  const data: any = await res.json().catch(() => ({}));
  if (!res.ok || data?.error) throw new Error(metaError(data?.error));
  return data;
}

/** Conecta la cuenta publicitaria: se prueba con Meta antes de guardar (el token va cifrado). */
export async function saveAdsSettings(input: { accountId?: unknown; token?: unknown; disconnect?: unknown }) {
  const s = await readSettings();
  if (input.disconnect === true) {
    await writeSettings({ ...s, accountId: '', token: '', lastSyncError: '' });
    return publicAdsSettings();
  }
  const accountId = input.accountId !== undefined ? normalizeAccountId(input.accountId) : s.accountId;
  if (!accountId) throw new Error('La cuenta publicitaria debe ser su número (por ejemplo act_953233320466297).');
  const raw = String(input.token ?? '').trim();
  if (raw && !/^[A-Za-z0-9_-]{30,700}$/.test(raw)) throw new Error('Ese no parece un token de Meta.');
  const token = raw || tokenOf(s);
  if (!token) throw new Error('Falta el token de anuncios de Meta (con permiso ads_read).');
  const account = await graph(`${accountId}?fields=name,currency`, token);
  await writeSettings({ ...s, accountId, token: raw ? encryptSecret(raw) : s.token, lastSyncError: '' });
  return { ...(await publicAdsSettings()), accountName: String(account?.name || '') };
}

const sha = (text: string) => createHash('sha256').update(text).digest('hex');

/** Llave para que otra app (por ejemplo la de métricas) lea los resultados por anuncio. Se muestra una sola vez. */
export async function createReportKey(): Promise<string> {
  const key = `nxr_${randomBytes(24).toString('base64url')}`;
  const s = await readSettings();
  await writeSettings({ ...s, reportKeyHash: sha(key), reportKeyHint: key.slice(-4) });
  return key;
}

export async function reportKeyValid(key: string): Promise<boolean> {
  const s = await readSettings();
  if (!s.reportKeyHash || !key) return false;
  const a = Buffer.from(sha(key));
  const b = Buffer.from(s.reportKeyHash);
  return a.length === b.length && timingSafeEqual(a, b);
}

// ---------- Producto que muestra un anuncio ----------

// Palabras que no distinguen un producto: "Vela de osito en nube" → osito, nube.
const FILLER = new Set(['vela', 'velas', 'velita', 'velitas', 'de', 'del', 'la', 'el', 'los', 'las', 'en', 'con', 'para', 'y', 'un', 'una', 'mi', 'tu', 'su', 'al', 'por']);

const tokensOf = (text: string) => plain(text).replace(/[^a-z0-9ñ\s]/g, ' ').split(/\s+/).filter(Boolean);
const keyWords = (name: string) => tokensOf(name).filter(w => w.length >= 3 && !FILLER.has(w));

/**
 * Productos del Catálogo que nombra el texto de un anuncio (todas sus palabras clave, en singular o plural). Si dos
 * coinciden y uno es más específico ("osito en nube" y "osito en nube con corazón"), queda el específico. Sin efectos.
 */
export function suggestFor(text: string, catalog: { name: string; category?: string }[]): { products: string[]; category: string } {
  const said = new Set(tokensOf(text));
  const has = (w: string) => said.has(w) || said.has(`${w}s`) || said.has(`${w}es`) || (w.endsWith('s') && said.has(w.slice(0, -1)));
  const hits = catalog
    .map(p => ({ p, words: keyWords(p.name) }))
    .filter(x => x.words.length > 0 && x.words.every(has));
  const specific = hits.filter(x => !hits.some(o => o !== x && o.words.length > x.words.length && x.words.every(w => o.words.includes(w))));
  const products = [...new Set(specific.map(x => x.p.name))].slice(0, 6);
  const categories = [...new Set((products.length ? specific.map(x => x.p.category || '') : catalog.map(p => p.category || ''))
    .filter(c => c && (products.length || keyWords(c).some(has))))];
  return { products, category: categories.length === 1 ? categories[0] : '' };
}

let catalogCache: { key: string; at: number; list: { name: string; category: string }[] } | null = null;

async function catalogLite(): Promise<{ name: string; category: string }[]> {
  const key = currentTenant()?.businessId || 'velamia';
  if (catalogCache && catalogCache.key === key && Date.now() - catalogCache.at < 5 * 60_000) return catalogCache.list;
  const list = (await getAllProducts().catch(() => [])).map((p: any) => ({ name: String(p.name || ''), category: String(p.category || '') })).filter(p => p.name);
  catalogCache = { key, at: Date.now(), list };
  return list;
}

// ---------- Registro de anuncios ----------

export interface AdRow {
  id: string; ad_id: string; ad_name: string; campaign_id: string; campaign_name: string; adset_id: string; adset_name: string;
  destination: string; status: string; headline: string; body: string; image_url: string; products: string[]; category: string;
  product_source: string; created_at: string; updated_at: string;
}

type AdFields = Partial<Pick<AdRow, 'ad_name' | 'campaign_id' | 'campaign_name' | 'adset_id' | 'adset_name' | 'destination' | 'status' | 'headline' | 'body' | 'image_url'>> & { extraText?: string };

async function adRow(adId: string): Promise<AdRow | null> {
  const { data } = await supabase.from(REGISTRY).select('*').filter('business_id', tenantOp(), tenantValue()).eq('ad_id', adId).maybeSingle();
  return (data as AdRow) || null;
}

/**
 * Guarda o completa un anuncio. 'replace' = lo que dice Meta manda (sincronización); 'fill' = solo llena lo vacío (lo
 * que trae un mensaje). El producto confirmado por la empresa nunca se pisa; el sugerido se recalcula.
 */
async function upsertAd(adId: string, fields: AdFields, mode: 'fill' | 'replace' = 'fill', catalog?: { name: string; category: string }[]): Promise<AdRow | null> {
  const current = await adRow(adId);
  const { extraText = '', ...incoming } = fields;
  const next: Record<string, any> = {};
  for (const [k, v] of Object.entries(incoming)) {
    const value = String(v ?? '').trim();
    if (value && (mode === 'replace' || !(current as any)?.[k])) next[k] = value.slice(0, k === 'body' ? 1000 : 500);
  }
  if (!current || current.product_source !== 'confirmado') {
    const merged = { ...(current || {}), ...next } as any;
    const text = [merged.ad_name, merged.headline, merged.body, merged.campaign_name, merged.adset_name, extraText].filter(Boolean).join('\n');
    const s = suggestFor(text, catalog || await catalogLite());
    if (!current || s.products.length || s.category) Object.assign(next, { products: s.products, category: s.category, product_source: 'sugerido' });
  }
  if (current) {
    if (Object.keys(next).length === 0) return current;
    const { data, error } = await supabase.from(REGISTRY).update({ ...next, updated_at: new Date().toISOString() }).eq('id', current.id).select().maybeSingle();
    if (error) throw new Error(`Error guardando el anuncio: ${error.message}`);
    return data as AdRow;
  }
  const { data, error } = await supabase.from(REGISTRY).insert([{ ...tenantColumns(), ad_id: adId, ...next }]).select().maybeSingle();
  // Dos mensajes del mismo anuncio a la vez: el segundo encuentra el que guardó el primero.
  if (error) return adRow(adId);
  return data as AdRow;
}

const AD_FIELDS = 'id,name,effective_status,campaign{id,name},adset{id,name,destination_type},creative{title,body,image_url,thumbnail_url,object_story_spec,asset_feed_spec}';

/** Lo que se guarda de un anuncio leído de Meta (incluye el texto de cada tarjeta del carrusel para sugerir productos). */
export function adFieldsFrom(ad: any): AdFields {
  const c = ad?.creative || {};
  const spec = c.object_story_spec || {};
  const link = spec.link_data || {};
  const video = spec.video_data || {};
  const feed = c.asset_feed_spec || {};
  const cards: any[] = link.child_attachments || [];
  const headline = c.title || link.name || video.title || feed.titles?.[0]?.text || cards[0]?.name || '';
  const body = c.body || link.message || video.message || feed.bodies?.[0]?.text || '';
  const links = [link.link, link.call_to_action?.value?.link, video.call_to_action?.value?.link, ...cards.map(x => x?.link), ...(feed.link_urls || []).map((u: any) => u?.website_url)]
    .filter(Boolean).join(' ');
  const ctas = [link.call_to_action?.type, video.call_to_action?.type, ...(feed.call_to_action_types || [])].filter(Boolean).join(' ');
  const kind = String(ad?.adset?.destination_type || '').toUpperCase();
  const destination = /WHATSAPP/.test(kind) || /wa\.me|whatsapp\.com/i.test(links) || /WHATSAPP/.test(ctas) ? 'whatsapp'
    : /INSTAGRAM_DIRECT|MESSENGER/.test(kind) ? 'mensajes'
      : links ? 'web' : '';
  const extraText = [...cards.flatMap(x => [x?.name, x?.description]), ...(feed.titles || []).map((t: any) => t?.text), ...(feed.bodies || []).map((t: any) => t?.text)]
    .filter(Boolean).join('\n');
  return {
    ad_name: String(ad?.name || ''), status: String(ad?.effective_status || ''),
    campaign_id: String(ad?.campaign?.id || ''), campaign_name: String(ad?.campaign?.name || ''),
    adset_id: String(ad?.adset?.id || ''), adset_name: String(ad?.adset?.name || ''),
    destination, headline: String(headline), body: String(body),
    image_url: String(c.image_url || c.thumbnail_url || cards[0]?.picture || ''), extraText
  };
}

/** Completa un anuncio con lo que dice Meta (nombre, campaña, producto). Sin cuenta conectada no hace nada. */
async function refreshAdFromMeta(adId: string) {
  const s = await readSettings();
  const token = tokenOf(s);
  if (!token) return;
  try {
    await upsertAd(adId, adFieldsFrom(await graph(`${adId}?fields=${AD_FIELDS}`, token)), 'replace');
  } catch (error: any) {
    console.warn(`⚠️ No se pudo leer el anuncio ${adId} en Meta:`, error.message);
  }
}

/** Lee todos los anuncios de la cuenta publicitaria y los guarda (con el producto sugerido si no está confirmado). */
export async function syncAds(): Promise<{ count: number }> {
  if (!(await adsAvailable())) throw new Error(MISSING_ADS_MIGRATION);
  const s = await readSettings();
  const token = tokenOf(s);
  if (!token || !s.accountId) throw new Error('Conecta primero la cuenta publicitaria de Meta.');
  try {
    const statuses = encodeURIComponent('["ACTIVE","PAUSED","CAMPAIGN_PAUSED","ADSET_PAUSED","IN_PROCESS","WITH_ISSUES","PENDING_REVIEW","DISAPPROVED"]');
    const base = `${s.accountId}/ads?fields=${AD_FIELDS}&limit=100&effective_status=${statuses}`;
    const catalog = await catalogLite();
    let count = 0;
    let after = '';
    for (let page = 0; page < 5; page++) {
      const data = await graph(after ? `${base}&after=${encodeURIComponent(after)}` : base, token);
      for (const ad of data?.data || []) {
        await upsertAd(String(ad.id), adFieldsFrom(ad), 'replace', catalog);
        count++;
      }
      after = data?.paging?.next ? String(data?.paging?.cursors?.after || '') : '';
      if (!after) break;
    }
    await writeSettings({ ...(await readSettings()), lastSyncAt: new Date().toISOString(), lastSyncError: '' });
    return { count };
  } catch (error: any) {
    await writeSettings({ ...(await readSettings()), lastSyncError: String(error.message).slice(0, 220) }).catch(() => undefined);
    throw error;
  }
}

/** La empresa confirma o corrige qué productos muestra un anuncio (solo nombres del Catálogo). */
export async function setAdProducts(adId: string, input: { products?: unknown; category?: unknown }): Promise<AdRow> {
  if (!(await adsAvailable())) throw new Error(MISSING_ADS_MIGRATION);
  if (!/^\d{5,30}$/.test(adId)) throw new Error('Anuncio inválido');
  const catalog = await catalogLite();
  const byName = new Map(catalog.map(p => [plain(p.name), p]));
  const wanted = Array.isArray(input.products) ? input.products.map(String) : [];
  const products = [...new Set(wanted.map(n => byName.get(plain(n))?.name).filter(Boolean) as string[])].slice(0, 10);
  const categories = [...new Set(catalog.map(p => p.category).filter(Boolean))];
  const category = categories.find(c => plain(c) === plain(input.category)) || (products.length ? (byName.get(plain(products[0]))?.category || '') : '');
  const row = (await adRow(adId)) || await upsertAd(adId, {});
  if (!row) throw new Error('No se pudo guardar el anuncio');
  const { data, error } = await supabase.from(REGISTRY).update({ products, category, product_source: 'confirmado', updated_at: new Date().toISOString() }).eq('id', row.id).select().maybeSingle();
  if (error) throw new Error(`Error guardando el anuncio: ${error.message}`);
  return data as AdRow;
}

export async function listAds(): Promise<AdRow[]> {
  if (!(await adsAvailable())) return [];
  const { data, error } = await supabase.from(REGISTRY).select('*').filter('business_id', tenantOp(), tenantValue()).order('updated_at', { ascending: false }).limit(500);
  if (error) throw new Error(`Error leyendo los anuncios: ${error.message}`);
  return (data || []) as AdRow[];
}

// ---------- De qué anuncio vino el chat ----------

export interface AdReferral {
  adId: string; sourceType: 'ad' | 'post'; sourceUrl: string; headline: string; body: string; mediaUrl: string; ctwaClid: string;
  channel: 'whatsapp' | 'instagram' | 'messenger';
}

/**
 * Lo que Meta manda en el primer mensaje que llega desde un anuncio: en WhatsApp message.referral (source_id,
 * headline, body, ctwa_clid…); en Instagram y Messenger referral.ad_id y ads_context_data. null si no vino de uno.
 */
export function referralFrom(message: any, channel: AdReferral['channel'] = 'whatsapp'): AdReferral | null {
  const r = message?.referral;
  if (!r || typeof r !== 'object') return null;
  const ctx = r.ads_context_data || {};
  const id = String(r.source_id || r.ad_id || '').trim();
  const headline = String(r.headline || ctx.ad_title || '').trim();
  if (!id && !headline && !r.source_url) return null;
  const type = String(r.source_type || '').toLowerCase() === 'post' ? 'post' : 'ad';
  return {
    adId: /^\d{5,30}$/.test(id) ? id : '', sourceType: type, sourceUrl: String(r.source_url || '').slice(0, 500),
    headline: headline.slice(0, 300), body: String(r.body || '').slice(0, 1000),
    mediaUrl: String(r.image_url || r.thumbnail_url || r.video_url || ctx.photo_url || ctx.video_url || '').slice(0, 1000),
    ctwaClid: String(r.ctwa_clid || '').slice(0, 300), channel
  };
}

// Sin corchetes ni comillas: el texto del anuncio va dentro del aviso para la vendedora.
const safe = (text: unknown, max: number) => String(text ?? '').replace(/[[\]"“”]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);

/** Lo que la vendedora necesita saber cuando la clienta llega por un anuncio o por la web. */
export function adContext(o: { via: 'anuncio' | 'publicacion' | 'web'; products: string[]; category?: string; headline?: string; body?: string; fromAd?: boolean }): string {
  const list = [...new Set(o.products.map(p => safe(p, 80)).filter(Boolean))].slice(0, 6);
  const category = o.category ? ` (categoría ${safe(o.category, 60)})` : '';
  const how = o.via === 'web'
    ? `La clienta escribió desde la página web${o.fromAd ? ' (llegó a la web por un anuncio de Meta)' : ''}`
    : o.via === 'publicacion' ? 'La clienta escribió desde una publicación promocionada de Facebook o Instagram' : 'La clienta llegó desde un anuncio de Meta';
  const tail = o.via === 'web'
    ? ' y avanza hacia la cotización; no le expliques qué es la referencia.'
    : ' y avanza hacia la cotización; no le preguntes qué vio, ya lo sabes.';
  if (list.length > 1) return `[${how}${category}. ${o.via === 'web' ? 'Venía de un anuncio que mostraba' : 'Ese anuncio mostraba'}: ${list.join(', ')}. Muéstrale esas opciones con su precio y pregúntale cuál le gustó${tail}]`;
  if (list.length === 1) {
    const what = o.via === 'web' ? ` mientras veía el producto ${list[0]}` : ` del producto ${list[0]}`;
    return `[${how}${what}${category}. Atiéndela directo con ese producto (muéstraselo con su precio)${tail}]`;
  }
  const said = [safe(o.headline, 120), safe(o.body, 200)].filter(Boolean).join(' — ');
  if (said) return `[${how}${category}. El anuncio decía: ${said}. Atiéndela con lo que muestra ese anuncio (búscalo en el catálogo)${tail}]`;
  if (o.category) return `[${how}${category}. Atiéndela directo con opciones de esa categoría${tail}]`;
  return `[${how}. Atiéndela con normalidad${tail}]`;
}

interface OriginInput {
  source: 'anuncio' | 'web'; origin_key: string; channel?: string; ad_id?: string; campaign_id?: string; adset_id?: string; source_type?: string;
  source_url?: string; headline?: string; body?: string; media_url?: string; ctwa_clid?: string; ref_code?: string; landing_page?: string;
  utm?: Record<string, string>; products?: string[];
}

async function saveOrigin(conversationId: string, o: OriginInput) {
  const { error } = await supabase.from(ORIGINS).upsert(
    [{ ...tenantColumns(), conversation_id: conversationId, ...o, origin_key: o.origin_key.slice(0, 200) }],
    { onConflict: 'conversation_id,origin_key', ignoreDuplicates: true }
  );
  if (error) console.warn('⚠️ No se anotó de dónde llegó el chat:', error.message);
}

/** La clienta llegó desde un anuncio: el chat queda unido a él y se devuelve el aviso para la vendedora. */
export async function attributeAdReferral(conversationId: string, ref: AdReferral): Promise<string> {
  if (!(await adsAvailable())) return '';
  const isAd = ref.sourceType === 'ad' && !!ref.adId;
  const ad = isAd ? await upsertAd(ref.adId, { headline: ref.headline, body: ref.body, image_url: ref.mediaUrl, destination: ref.channel === 'whatsapp' ? 'whatsapp' : 'mensajes' }).catch(() => null) : null;
  // La primera vez que se ve el anuncio se completan nombre, campaña y producto con Meta (sin hacer esperar a la clienta).
  if (isAd && ad && !ad.campaign_id) void refreshAdFromMeta(ref.adId);
  const products = ad?.products?.length ? ad.products : suggestFor(`${ref.headline}\n${ref.body}`, await catalogLite()).products;
  await saveOrigin(conversationId, {
    source: 'anuncio', origin_key: `ad:${ref.adId || ref.sourceUrl || plain(ref.headline).slice(0, 80) || 'sin-id'}`, channel: ref.channel,
    ad_id: isAd ? ref.adId : '', campaign_id: ad?.campaign_id || '', adset_id: ad?.adset_id || '', source_type: ref.sourceType,
    source_url: ref.sourceUrl, headline: ref.headline, body: ref.body, media_url: ref.mediaUrl, ctwa_clid: ref.ctwaClid, products
  });
  console.log(`📣 Chat llegó desde ${isAd ? `el anuncio ${ref.adId}` : 'una publicación promocionada'}`);
  return adContext({ via: isAd ? 'anuncio' : 'publicacion', products, category: ad?.category || '', headline: ref.headline || ad?.headline, body: ref.body || ad?.body });
}

// ---------- Referencias de la web ----------

// Sin letras ni números que se confundan (I, L, O, 0, 1).
export const REF_PATTERN = /^[A-HJKMNP-Z2-9]{6}$/;

/** Las referencias de la web en lo que escribió la clienta ("Ref: K7M2QX" → K7M2QX). */
export function refCodesIn(text: string): string[] {
  const out: string[] = [];
  const re = /\bref(?:erencia)?\b\s*[:#.\-]?\s*([a-hjkmnp-z2-9]{6})\b/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(String(text || ''))) !== null) out.push(m[1].toUpperCase());
  return [...new Set(out)];
}

const clean = (v: unknown, max: number) => String(v ?? '').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, max);
const digitsId = (v: unknown) => (/^\d{5,30}$/.test(String(v ?? '').trim()) ? String(v).trim() : '');

/**
 * Nombre de producto que manda la web: si está en el Catálogo se usa ese nombre; si no, solo se acepta un nombre corto
 * con letras y números (lo manda cualquier navegador: nunca llega a la vendedora un texto con instrucciones).
 */
export function webProductName(raw: string, catalog: { name: string; category?: string }[]): string {
  const text = clean(raw, 120);
  if (!text) return '';
  const exact = catalog.find(p => plain(p.name) === plain(text));
  if (exact) return exact.name;
  const s = suggestFor(text, catalog);
  if (s.products.length === 1) return s.products[0];
  return /^[\p{L}\p{N} .,'&()\-]{2,60}$/u.test(text) && text.split(/\s+/).length <= 8 ? text : '';
}

export class BadWebRef extends Error {}

/** La web anota de dónde llegó la visita (anuncio, campaña) y qué producto miraba al tocar WhatsApp. */
export async function registerWebRef(input: any): Promise<void> {
  if (!(await adsAvailable())) return;
  const code = clean(input?.code, 10).toUpperCase();
  if (!REF_PATTERN.test(code)) throw new BadWebRef('Referencia inválida');
  const utm: Record<string, string> = {};
  for (const k of ['source', 'medium', 'campaign', 'content', 'term']) {
    const v = clean(input?.utm?.[k], 150);
    if (v) utm[k] = v;
  }
  const adId = digitsId(input?.adId);
  const fromMeta = !!adId || !!clean(input?.fbclid, 10) || /^(facebook|instagram|meta|fb|ig)$/i.test(utm.source || '');
  const product = webProductName(input?.product, await catalogLite());
  const clicked = input?.event === 'whatsapp';
  const { data: existing } = await supabase.from(WEB_REFS).select('*').filter('business_id', tenantOp(), tenantValue()).eq('code', code).maybeSingle();
  if (existing) {
    const changes: Record<string, any> = { updated_at: new Date().toISOString(), clicks: Number(existing.clicks || 0) + (clicked ? 1 : 0) };
    if (product) changes.product = product;
    if (!existing.ad_id && adId) Object.assign(changes, { ad_id: adId, campaign_id: digitsId(input?.campaignId), adset_id: digitsId(input?.adsetId) });
    if (fromMeta && !existing.from_meta) changes.from_meta = true;
    await supabase.from(WEB_REFS).update(changes).eq('id', existing.id);
    return;
  }
  const { error } = await supabase.from(WEB_REFS).insert([{
    ...tenantColumns(), code, ad_id: adId, campaign_id: digitsId(input?.campaignId), adset_id: digitsId(input?.adsetId), utm, from_meta: fromMeta,
    landing_page: clean(input?.landing, 300), product, clicks: clicked ? 1 : 0
  }]);
  if (error && !/duplicate/i.test(error.message)) console.warn('⚠️ No se guardó la visita de la web:', error.message);
}

/** La clienta escribió con la referencia de la web: el chat queda unido a esa visita (y a su anuncio, si vino de uno). */
export async function attributeWebRef(conversationId: string, text: string): Promise<string> {
  const codes = refCodesIn(text);
  if (codes.length === 0 || !(await adsAvailable())) return '';
  const { data } = await supabase.from(WEB_REFS).select('*').filter('business_id', tenantOp(), tenantValue()).in('code', codes).limit(1);
  const ref = data?.[0];
  if (!ref) return '';
  const ad = ref.ad_id ? await upsertAd(ref.ad_id, { destination: 'web' }).catch(() => null) : null;
  if (ad && !ad.campaign_id) void refreshAdFromMeta(ref.ad_id);
  const products = ref.product ? [ref.product] : (ad?.products || []);
  await saveOrigin(conversationId, {
    source: 'web', origin_key: `web:${ref.code}`, ad_id: ref.ad_id || '', campaign_id: ref.campaign_id || ad?.campaign_id || '',
    adset_id: ref.adset_id || ad?.adset_id || '', ref_code: ref.code, landing_page: ref.landing_page || '', utm: ref.utm || {}, products
  });
  console.log(`🌐 Chat llegó desde la web (referencia ${ref.code}${ref.ad_id ? `, anuncio ${ref.ad_id}` : ''})`);
  return adContext({ via: 'web', fromAd: !!ref.from_meta, products, category: ad?.category || '' });
}

/** De dónde llegó un chat, para mostrarlo en el CRM. */
export async function originsOf(conversationId: string) {
  if (!(await adsAvailable())) return [];
  const { data } = await supabase.from(ORIGINS).select('*').eq('conversation_id', conversationId).filter('business_id', tenantOp(), tenantValue())
    .order('created_at', { ascending: true }).limit(10);
  const rows = data || [];
  const ids = [...new Set(rows.map((o: any) => o.ad_id).filter(Boolean))];
  const { data: ads } = ids.length
    ? await supabase.from(REGISTRY).select('ad_id, ad_name, campaign_name, headline').filter('business_id', tenantOp(), tenantValue()).in('ad_id', ids)
    : { data: [] as any[] };
  const byId = new Map((ads || []).map((a: any) => [a.ad_id, a]));
  return rows.map((o: any) => {
    const ad: any = byId.get(o.ad_id) || {};
    return {
      id: o.id, source: o.source, channel: o.channel, at: o.created_at, adId: o.ad_id, adName: ad.ad_name || '', campaignName: ad.campaign_name || '',
      headline: o.headline || ad.headline || '', products: o.products || [], refCode: o.ref_code || '', landing: o.landing_page || '',
      sourceType: o.source_type || '', utmCampaign: o.utm?.campaign || ''
    };
  });
}

// ---------- Resultados por anuncio ----------

export interface AdResult {
  key: string; adId: string; adName: string; campaignName: string; adsetName: string; destination: string; status: string; headline: string;
  imageUrl: string; products: string[]; category: string; productSource: string;
  chats: number; webChats: number; quotations: number; orders: number; sales: number; revenue: number;
  spend: number | null; metaChats: number | null; clicks: number | null; costPerChat: number | null; roas: number | null;
}

const PAID = new Set(['confirmed', 'shipped', 'delivered']);
const round = (n: number) => Math.round(n * 100) / 100;

const dayIn = (date: Date) => {
  const p = localParts(date, profile().business.timezone || 'America/Guayaquil');
  return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
};

const insightsCache = new Map<string, { at: number; rows: any[] }>();

/** Lo gastado por anuncio en el período (de Meta, con 30 minutos de caché). Sin cuenta conectada: null. */
async function spendByAd(from: Date, to: Date): Promise<Map<string, any> | null> {
  const s = await readSettings();
  const token = tokenOf(s);
  if (!token || !s.accountId) return null;
  const since = dayIn(from);
  const until = dayIn(new Date(to.getTime() - 1));
  const key = `${currentTenant()?.businessId || 'velamia'}|${s.accountId}|${since}|${until}`;
  const cached = insightsCache.get(key);
  let rows = cached && Date.now() - cached.at < 30 * 60_000 ? cached.rows : null;
  if (!rows) {
    rows = [];
    const range = encodeURIComponent(JSON.stringify({ since, until }));
    let after = '';
    for (let page = 0; page < 5; page++) {
      const data = await graph(`${s.accountId}/insights?level=ad&time_range=${range}&fields=ad_id,ad_name,campaign_name,adset_name,spend,actions&limit=500${after ? `&after=${encodeURIComponent(after)}` : ''}`, token);
      rows.push(...(data?.data || []));
      after = data?.paging?.next ? String(data?.paging?.cursors?.after || '') : '';
      if (!after) break;
    }
    insightsCache.set(key, { at: Date.now(), rows });
  }
  const map = new Map<string, any>();
  for (const r of rows) {
    const actions = Object.fromEntries((r.actions || []).map((a: any) => [a.action_type, Number(a.value || 0)]));
    map.set(String(r.ad_id), {
      spend: Number(r.spend || 0), adName: r.ad_name || '', campaignName: r.campaign_name || '', adsetName: r.adset_name || '',
      metaChats: actions['onsite_conversion.messaging_conversation_started_7d'] || 0, clicks: actions['link_click'] || 0
    });
  }
  return map;
}

/**
 * Qué trajo cada anuncio en el período: chats (directos y por la web), cotizaciones, pedidos, ventas e ingresos, y si la
 * cuenta está conectada, lo gastado, el costo por chat y el retorno (ingresos ÷ gasto). Lo que pasó en el chat cuenta
 * desde que llegó por ese anuncio.
 */
export async function adResults(from: Date, to: Date): Promise<{ available: boolean; connected: boolean; results: AdResult[]; spendError: string }> {
  if (!(await adsAvailable())) return { available: false, connected: false, results: [], spendError: '' };
  const { data: originRows, error } = await supabase.from(ORIGINS).select('conversation_id, ad_id, source, created_at, headline, products')
    .filter('business_id', tenantOp(), tenantValue()).gte('created_at', from.toISOString()).lt('created_at', to.toISOString()).limit(5000);
  if (error) throw new Error(`Error leyendo de dónde llegaron los chats: ${error.message}`);
  const origins = (originRows || []) as any[];
  const convIds = [...new Set(origins.map(o => o.conversation_id))];
  const [quotes, orders] = convIds.length
    ? await Promise.all([
      supabase.from('quotations').select('conversation_id, created_at').in('conversation_id', convIds).limit(5000),
      supabase.from('orders').select('conversation_id, created_at, status, total_amount').in('conversation_id', convIds).neq('status', 'cancelled').limit(5000)
    ])
    : [{ data: [] }, { data: [] }] as any[];
  let spend: Map<string, any> | null = null;
  let spendError = '';
  try {
    spend = await spendByAd(from, to);
  } catch (e: any) {
    spendError = e.message;
  }
  const keyOf = (o: any) => o.ad_id || (o.source === 'web' ? 'web' : 'sin-id');
  const keys = new Set<string>(origins.map(keyOf));
  for (const [adId, s] of spend || []) if (s.spend > 0) keys.add(adId);
  const adIds = [...keys].filter(k => /^\d+$/.test(k));
  const registry = new Map<string, AdRow>();
  for (let i = 0; i < adIds.length; i += 100) {
    const { data } = await supabase.from(REGISTRY).select('*').filter('business_id', tenantOp(), tenantValue()).in('ad_id', adIds.slice(i, i + 100));
    for (const r of (data || []) as AdRow[]) registry.set(r.ad_id, r);
  }
  const after = (list: any[], convId: string, since: string) => list.filter(x => x.conversation_id === convId && parseDbTimestamp(x.created_at).getTime() >= parseDbTimestamp(since).getTime() - 10 * 60_000);
  const results: AdResult[] = [...keys].map(key => {
    const mine = origins.filter(o => keyOf(o) === key);
    let quotations = 0, ordersN = 0, sales = 0, revenue = 0;
    const seen = new Set<string>();
    for (const o of mine) {
      if (seen.has(o.conversation_id)) continue;
      seen.add(o.conversation_id);
      if (after(quotes.data || [], o.conversation_id, o.created_at).length) quotations++;
      const list = after(orders.data || [], o.conversation_id, o.created_at);
      if (list.length) ordersN++;
      const paid = list.filter((x: any) => PAID.has(x.status));
      if (paid.length) { sales++; revenue += paid.reduce((s: number, x: any) => s + Number(x.total_amount || 0), 0); }
    }
    const ad = registry.get(key);
    const money = spend?.get(key);
    const spent = spend ? Number(money?.spend || 0) : null;
    const chats = seen.size;
    return {
      key, adId: /^\d+$/.test(key) ? key : '',
      adName: ad?.ad_name || money?.adName || (key === 'web' ? 'Web (sin anuncio identificado)' : key === 'sin-id' ? 'Anuncio sin identificar' : `Anuncio ${key}`),
      campaignName: ad?.campaign_name || money?.campaignName || '', adsetName: ad?.adset_name || money?.adsetName || '',
      destination: ad?.destination || (key === 'web' ? 'web' : ''), status: ad?.status || '',
      headline: ad?.headline || mine.find(o => o.headline)?.headline || '', imageUrl: ad?.image_url || '',
      products: ad?.products?.length ? ad.products : [...new Set(mine.flatMap(o => o.products || []))].slice(0, 6),
      category: ad?.category || '', productSource: ad?.product_source || '',
      chats, webChats: new Set(mine.filter(o => o.source === 'web').map(o => o.conversation_id)).size,
      quotations, orders: ordersN, sales, revenue: round(revenue),
      spend: spent === null ? null : round(spent), metaChats: money ? money.metaChats : null, clicks: money ? money.clicks : null,
      costPerChat: spent !== null && chats > 0 ? round(spent / chats) : null,
      roas: spent ? round(revenue / spent) : null
    };
  });
  results.sort((a, b) => b.revenue - a.revenue || b.sales - a.sales || b.quotations - a.quotations || b.chats - a.chats || (b.spend || 0) - (a.spend || 0));
  return { available: true, connected: !!spend, results, spendError };
}

// ---------- Revisión automática ----------

const SYNC_EVERY_MS = 6 * 60 * 60 * 1000;
let syncing = false;

async function syncCurrent(who: string) {
  const s = await readSettings();
  if (!tokenOf(s) || !s.accountId) return;
  const { count } = await syncAds();
  console.log(`📣 Anuncios de ${who}: ${count} leídos de Meta`);
}

/** VELAMIA y cada empresa con su cuenta publicitaria conectada, por separado: si una falla, las demás siguen. */
export async function runAdsSync() {
  if (syncing || !(await adsAvailable().catch(() => false))) return;
  syncing = true;
  try {
    await runWithTenant(undefined, () => syncCurrent('VELAMIA')).catch(error => console.warn('⚠️ Anuncios de VELAMIA:', error.message));
    for (const tenant of await getActiveTenants().catch(() => [])) {
      await runWithTenant(tenant, () => syncCurrent(tenant.name)).catch(error => console.warn(`⚠️ Anuncios de ${tenant.name}:`, error.message));
    }
  } finally {
    syncing = false;
  }
}

export function startAdsSync() {
  const tick = () => { void runAdsSync(); };
  setTimeout(tick, 4 * 60 * 1000);
  setInterval(tick, SYNC_EVERY_MS);
}
