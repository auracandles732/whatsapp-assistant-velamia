import { randomBytes } from 'crypto';
import { supabase, tenantOp, tenantValue, getAllProducts, getConfig, setConfig, getActiveTenants } from './supabase';
import { encryptSecret, decryptSecret, currentTenant, runWithTenant } from './tenant';
import { profile } from '../config/businessProfile';
import { plain } from '../social/posts';

/**
 * Catálogo de la página web (para todas las empresas que tengan una web conectada). El Catálogo del CRM manda: nombre,
 * precio y foto se editan aquí y la web se actualiza sola. Cada producto puede tener su versión para la web (nombre más
 * bonito, descripción, categoría de la web, sus fotos) y se muestra solo si se marca "Mostrar en la web". Ofertas,
 * etiquetas y orden siguen en el panel de la web.
 *
 * La web conectada responde dos rutas con una llave compartida (encabezado X-Sync-Key):
 *   GET  {url}/api/sync/productos  → { productos: [...] }  (lo que tiene hoy)
 *   PUT  {url}/api/sync/productos  ← { productos: [...] }  → { ids: { <id del CRM>: <id en la web> } }
 * Sin la migración 028 (columna products.web) todo sigue igual, solo que sin web.
 */

const SETTINGS_KEY = 'web_catalog';
export const MISSING_WEB_MIGRATION = 'Falta activar la conexión con la web: hay que aplicar migrations/028_catalogo_web.sql en Supabase.';

export interface ProductWeb {
  /** Id del producto en la web (null = todavía no se creó allá). */
  id: number | null;
  visible: boolean;
  name: string;
  description: string;
  /** Categoría de la web (por ejemplo "baby-shower"). Vacía = sale de la categoría del CRM. */
  category: string;
  /** Fotos propias de la web. Si cambia la foto del CRM, la web pasa a usar la nueva. */
  images: string[];
  baseImage: string;
  /** Precio que tenía la web al unirse (para revisar diferencias) y si ya se revisó. */
  price: number | null;
  priceOk: boolean;
  imported?: boolean;
}

let available: { ok: boolean; at: number } | null = null;

/** ¿Ya se aplicó la migración 028? Se revisa cada 10 minutos. */
export async function webCatalogAvailable(): Promise<boolean> {
  if (available && Date.now() - available.at < 10 * 60_000) return available.ok;
  const { error } = await supabase.from('products').select('web').limit(1);
  available = { ok: !error, at: Date.now() };
  return available.ok;
}

// ---------- Conexión ----------

interface WebSettings { url: string; key: string; enabled: boolean; lastSyncAt: string; lastError: string; lastCount: number }

async function readSettings(): Promise<WebSettings> {
  let s: any = {};
  try {
    const raw = await getConfig(SETTINGS_KEY);
    s = raw ? JSON.parse(raw) : {};
  } catch {
    s = {};
  }
  return { url: String(s.url || ''), key: String(s.key || ''), enabled: s.enabled === true, lastSyncAt: String(s.lastSyncAt || ''), lastError: String(s.lastError || ''), lastCount: Number(s.lastCount || 0) };
}

const writeSettings = (s: WebSettings) => setConfig(SETTINGS_KEY, JSON.stringify(s));

function keyOf(s: WebSettings): string {
  try {
    return decryptSecret(s.key);
  } catch {
    return '';
  }
}

export function normalizeWebUrl(value: unknown): string {
  const raw = String(value ?? '').trim().replace(/\/+$/, '');
  try {
    const u = new URL(raw);
    if (u.protocol !== 'https:' && !/^(localhost|127\.0\.0\.1)$/.test(u.hostname)) return '';
    return `${u.protocol}//${u.host}${u.pathname.replace(/\/+$/, '')}`;
  } catch {
    return '';
  }
}

/**
 * Conecta la web: guarda la dirección de su panel y crea la llave compartida (se muestra una sola vez para ponerla en
 * la web). La sincronización queda pausada hasta que se revisen los precios distintos y se active.
 */
export async function connectWeb(input: { url?: unknown }): Promise<{ key: string }> {
  const url = normalizeWebUrl(input.url);
  if (!url) throw new Error('La dirección del panel de la web debe empezar con https://');
  const key = `nxw_${randomBytes(24).toString('base64url')}`;
  const s = await readSettings();
  await writeSettings({ ...s, url, key: encryptSecret(key), enabled: false, lastError: '' });
  return { key };
}

export async function disconnectWeb() {
  const s = await readSettings();
  await writeSettings({ ...s, url: '', key: '', enabled: false, lastError: '' });
}

// ---------- Cómo se ve cada producto en la web ----------

const SMALL = new Set(['de', 'del', 'la', 'el', 'los', 'las', 'en', 'con', 'y', 'o', 'a', 'para', 'por', 'al']);

/** "VELA DE ANGELITO CON ROSARIO" → "Vela de Angelito con Rosario". */
export function titleCase(name: string): string {
  return String(name || '').toLowerCase().split(/\s+/).filter(Boolean)
    .map((w, i) => (i > 0 && SMALL.has(w) ? w : w.charAt(0).toUpperCase() + w.slice(1))).join(' ');
}

/** Categoría del CRM → categoría de la web: la que ya usan sus productos en la web o, si no hay, "baby-shower". */
export function slugOf(category: string, known: Map<string, string> = new Map()): string {
  const key = plain(category).trim();
  if (known.has(key)) return known.get(key)!;
  return key.replace(/[^a-z0-9ñ]+/g, '-').replace(/^-+|-+$/g, '');
}

/** La categoría de la web que más usan los productos de cada categoría del CRM. */
export function slugMapFrom(products: { category?: string; web?: ProductWeb | null }[]): Map<string, string> {
  const votes = new Map<string, Map<string, number>>();
  for (const p of products) {
    if (!p.web?.category || !p.category) continue;
    const key = plain(p.category).trim();
    const m = votes.get(key) || new Map<string, number>();
    m.set(p.web.category, (m.get(p.web.category) || 0) + 1);
    votes.set(key, m);
  }
  const out = new Map<string, string>();
  for (const [k, m] of votes) out.set(k, [...m.entries()].sort((a, b) => b[1] - a[1])[0][0]);
  return out;
}

export interface WebProductOut {
  crm_id: string; id: number | null; nombre: string; descripcion: string; precio: number; categoria: string;
  unidad: 'docena' | 'unidad'; imagenes: string[]; oculto: boolean;
}

/** Lo que se manda a la web por cada producto del CRM que tiene versión para la web. Sin efectos. */
export function toWebProduct(p: any, slugs: Map<string, string>, unitSingular = 'docena'): WebProductOut {
  const web: ProductWeb = p.web;
  const unit = String(p.sale_unit || unitSingular || '').toLowerCase();
  const ownImages = (web.images || []).filter(u => /^https:\/\//.test(u));
  const photoChanged = !!p.image_url && !!web.baseImage && web.baseImage !== p.image_url;
  const imagenes = ownImages.length && !photoChanged ? ownImages : (p.image_url ? [p.image_url] : ownImages);
  return {
    crm_id: String(p.id),
    id: Number.isFinite(Number(web.id)) && web.id !== null ? Number(web.id) : null,
    nombre: (web.name || titleCase(p.name)).slice(0, 120),
    descripcion: String(web.description || '').slice(0, 600),
    precio: Math.round(Number(p.price) * 100) / 100,
    categoria: web.category || slugOf(p.category || '', slugs),
    unidad: /unidad|pieza|unit/.test(unit) && !/docena/.test(unit) ? 'unidad' : 'docena',
    imagenes,
    oculto: !web.visible
  };
}

// ---------- Guardar la versión para la web ----------

async function saveWeb(productId: string, web: ProductWeb | null) {
  const { error } = await supabase.from('products').update({ web }).eq('id', productId).filter('business_id', tenantOp(), tenantValue());
  if (error) throw new Error(`Error guardando el producto para la web: ${error.message}`);
}

const emptyWeb = (): ProductWeb => ({ id: null, visible: false, name: '', description: '', category: '', images: [], baseImage: '', price: null, priceOk: true });

/** Mostrar u ocultar en la web y su nombre, descripción y categoría allá. */
export async function setProductWeb(productId: string, input: { visible?: unknown; name?: unknown; description?: unknown; category?: unknown }) {
  if (!(await webCatalogAvailable())) throw new Error(MISSING_WEB_MIGRATION);
  const { data: p } = await supabase.from('products').select('id, web').eq('id', productId).filter('business_id', tenantOp(), tenantValue()).maybeSingle();
  if (!p) throw new Error('Producto no encontrado');
  const web: ProductWeb = { ...emptyWeb(), ...(p.web || {}) };
  if (input.visible !== undefined) web.visible = input.visible === true;
  if (input.name !== undefined) web.name = String(input.name || '').replace(/\s+/g, ' ').trim().slice(0, 120);
  if (input.description !== undefined) web.description = String(input.description || '').trim().slice(0, 600);
  if (input.category !== undefined) web.category = slugOf(String(input.category || ''));
  await saveWeb(productId, web);
  scheduleWebPush();
  return web;
}

/** Precio distinto al unir: se queda el de la web (cambia el del CRM) o el del CRM (la web pasa a ese). */
export async function resolveWebPrice(productId: string, use: 'web' | 'crm') {
  const { data: p } = await supabase.from('products').select('id, price, web').eq('id', productId).filter('business_id', tenantOp(), tenantValue()).maybeSingle();
  if (!p?.web) throw new Error('Producto no encontrado');
  const web: ProductWeb = { ...emptyWeb(), ...p.web, priceOk: true };
  if (use === 'web' && Number(p.web.price) > 0) {
    const { error } = await supabase.from('products').update({ price: Number(p.web.price), web }).eq('id', productId).filter('business_id', tenantOp(), tenantValue());
    if (error) throw new Error(`Error guardando el precio: ${error.message}`);
  } else {
    await saveWeb(productId, web);
  }
  scheduleWebPush();
}

export const priceConflict = (p: any) => !!p.web && p.web.price !== null && p.web.price !== undefined && !p.web.priceOk && Math.abs(Number(p.web.price) - Number(p.price)) > 0.009;

/** Estado para el CRM: conexión, cuántos están en la web y los precios distintos por revisar. */
export async function webOverview() {
  const s = await readSettings();
  const ok = await webCatalogAvailable();
  const products = ok ? await getAllProducts().catch(() => []) : [];
  const onWeb = products.filter((p: any) => p.web?.visible);
  const slugs = slugMapFrom(products);
  const categories = [...new Set([...products.map((p: any) => p.web?.category).filter(Boolean), ...slugs.values()])].sort();
  return {
    available: ok,
    connected: !!(s.url && keyOf(s)), url: s.url, enabled: s.enabled, lastSyncAt: s.lastSyncAt || null, lastError: s.lastError, lastCount: s.lastCount,
    counts: { total: products.length, linked: products.filter((p: any) => p.web).length, visible: onWeb.length, imported: products.filter((p: any) => p.web?.imported).length },
    categories,
    conflicts: products.filter(priceConflict).map((p: any) => ({ id: p.id, name: p.name, webName: p.web.name, crmPrice: Number(p.price), webPrice: Number(p.web.price), image: p.image_url }))
  };
}

/** Activar o pausar la sincronización. Para activarla no pueden quedar precios distintos sin revisar. */
export async function setWebEnabled(enabled: boolean) {
  const s = await readSettings();
  if (enabled) {
    if (!s.url || !keyOf(s)) throw new Error('Conecta primero la web.');
    const pending = (await getAllProducts()).filter(priceConflict).length;
    if (pending) throw new Error(`Faltan ${pending} precio(s) distintos por revisar antes de activar.`);
  }
  await writeSettings({ ...s, enabled, lastError: '' });
  if (enabled) await pushToWeb();
}

// ---------- Mandar a la web ----------

async function callWeb(s: WebSettings, method: 'GET' | 'PUT', body?: unknown): Promise<any> {
  const res = await fetch(`${s.url}/api/sync/productos`, {
    method,
    headers: { 'Content-Type': 'application/json', 'X-Sync-Key': keyOf(s) },
    body: body ? JSON.stringify(body) : undefined,
    // El panel puede estar dormido (Render gratis tarda en despertar).
    signal: AbortSignal.timeout(120_000)
  });
  const data: any = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error || `La web respondió ${res.status}`);
  return data;
}

/** Lo que tiene hoy la web (para unir productos). */
export async function readWebProducts(): Promise<any[]> {
  const s = await readSettings();
  if (!s.url || !keyOf(s)) throw new Error('Conecta primero la web.');
  return (await callWeb(s, 'GET'))?.productos || [];
}

/**
 * Manda a la web todos los productos con versión para la web (los demás no se tocan; los que se borraron del CRM la web
 * los oculta). Guarda el id que la web le dio a cada producto nuevo.
 */
export async function pushToWeb(): Promise<{ count: number }> {
  const s = await readSettings();
  if (!s.enabled || !s.url || !keyOf(s) || !(await webCatalogAvailable())) return { count: 0 };
  try {
    const products = await getAllProducts();
    const slugs = slugMapFrom(products);
    const unitSingular = profile().sales.unitSingular || 'docena';
    const list = products.filter((p: any) => p.web && p.price > 0).map((p: any) => toWebProduct(p, slugs, unitSingular));
    const result = await callWeb(s, 'PUT', { productos: list });
    const ids: Record<string, number> = result?.ids || {};
    for (const p of products.filter((x: any) => x.web)) {
      const id = Number(ids[p.id]);
      if (Number.isFinite(id) && id > 0 && p.web.id !== id) await saveWeb(p.id, { ...p.web, id });
    }
    await writeSettings({ ...(await readSettings()), lastSyncAt: new Date().toISOString(), lastError: '', lastCount: list.length });
    return { count: list.length };
  } catch (error: any) {
    await writeSettings({ ...(await readSettings()), lastError: String(error.message).slice(0, 220) }).catch(() => undefined);
    throw error;
  }
}

// Un cambio en el Catálogo se manda a la web un momento después (si se editan varios, sale todo junto).
const pending = new Map<string, NodeJS.Timeout>();

export function scheduleWebPush(delayMs = 45_000) {
  const tenant = currentTenant();
  const key = tenant?.businessId || 'velamia';
  clearTimeout(pending.get(key));
  pending.set(key, setTimeout(() => {
    pending.delete(key);
    void runWithTenant(tenant, () => pushToWeb()).catch(error => console.warn(`⚠️ Catálogo de la web (${tenant?.name || 'VELAMIA'}):`, error.message));
  }, delayMs));
}

/** Cada hora, por si algo no salió (web dormida, sin conexión): VELAMIA y cada empresa con su web conectada. */
export function startWebCatalogSync() {
  const tick = async () => {
    await runWithTenant(undefined, () => pushToWeb()).catch(error => console.warn('⚠️ Catálogo de la web de VELAMIA:', error.message));
    for (const tenant of await getActiveTenants().catch(() => [])) {
      await runWithTenant(tenant, () => pushToWeb()).catch(error => console.warn(`⚠️ Catálogo de la web de ${tenant.name}:`, error.message));
    }
  };
  setTimeout(() => { void tick(); }, 6 * 60 * 1000);
  setInterval(() => { void tick(); }, 60 * 60 * 1000);
}
