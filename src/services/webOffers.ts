import { getAllProducts, getConfig, setConfig, getActiveTenants } from './supabase';
import { currentTenant, runWithTenant } from './tenant';

/**
 * Ofertas de la página web (precio por tiempo limitado que se pone en el panel de la web). Se leen del catálogo público
 * de la web y el asistente cotiza con ese precio a cualquier cliente que pida el producto, igual que en la web (decisión
 * de Aura, 10-oct-2026: una clienta llegó por la oferta de $19.99 y el asistente le dijo $30). Solo se usan para vender:
 * nunca se mandan de vuelta a la web, que conserva su precio normal y su oferta.
 */

export interface WebOffer { price: number; regular: number; text: string }
interface OffersState { source: string; updatedAt: string; offers: Record<string, WebOffer> }

const OFFERS_KEY = 'web_offers';
const round2 = (n: number) => Math.round(n * 100) / 100;

/** Del catálogo público de la web (sitio.json): número del panel de cada producto → su oferta vigente. */
export function offersFromSite(site: any): Map<number, WebOffer> {
  const out = new Map<number, WebOffer>();
  for (const entry of Array.isArray(site?.productos) ? site.productos : []) {
    const p = entry?.producto || entry;
    const pid = Number(p?.pid ?? p?.id);
    const sale = Number(p?.salePrice);
    const regular = Number(p?.originalPrice || p?.price);
    if (!p?.onSale || p?.oculto || !Number.isFinite(pid) || !(sale > 0) || !(regular > sale)) continue;
    out.set(pid, { price: round2(sale), regular: round2(regular), text: String(p.saleText || 'Oferta por tiempo limitado').trim().slice(0, 80) });
  }
  return out;
}

/** Une las ofertas de la web con los productos del CRM (cada producto guarda en web.id su número del panel). */
export function offersByProduct(products: any[], byPanelId: Map<number, WebOffer>): Record<string, WebOffer> {
  const out: Record<string, WebOffer> = {};
  for (const p of products) {
    const offer = byPanelId.get(Number(p?.web?.id));
    if (p?.id && offer) out[p.id] = offer;
  }
  return out;
}

/** El catálogo con el precio de oferta: price = oferta y regular_price = precio normal (para decir "antes $30"). */
export function withOffers<T extends { id?: string; price: number }>(products: T[], offers: Record<string, WebOffer>): (T & { regular_price?: number; offer_text?: string })[] {
  return products.map(p => {
    const offer = p.id ? offers[p.id] : undefined;
    return offer && offer.price < Number(p.price) ? { ...p, price: offer.price, regular_price: Number(p.price), offer_text: offer.text } : p;
  });
}

async function readState(): Promise<OffersState> {
  try {
    const s = JSON.parse((await getConfig(OFFERS_KEY)) || '{}');
    return { source: String(s.source || ''), updatedAt: String(s.updatedAt || ''), offers: s.offers && typeof s.offers === 'object' ? s.offers : {} };
  } catch {
    return { source: '', updatedAt: '', offers: {} };
  }
}

const cache = new Map<string, { at: number; offers: Record<string, WebOffer> }>();
const tenantKey = () => currentTenant()?.businessId || 'velamia';

/** Lee de nuevo las ofertas de la web. Si la web no responde se quedan las últimas (una oferta vieja se borra en 2 días). */
export async function refreshWebOffers(): Promise<number> {
  const s = await readState();
  if (!s.source) return 0;
  try {
    const res = await fetch(s.source, { signal: AbortSignal.timeout(20_000), headers: { 'Cache-Control': 'no-cache' } });
    if (!res.ok) throw new Error(`la web respondió ${res.status}`);
    const offers = offersByProduct(await getAllProducts(), offersFromSite(await res.json()));
    await setConfig(OFFERS_KEY, JSON.stringify({ ...s, updatedAt: new Date().toISOString(), offers }));
    cache.delete(tenantKey());
    return Object.keys(offers).length;
  } catch (error: any) {
    if (s.updatedAt && Date.now() - Date.parse(s.updatedAt) > 2 * 24 * 3600_000 && Object.keys(s.offers).length) {
      await setConfig(OFFERS_KEY, JSON.stringify({ ...s, offers: {} }));
      cache.delete(tenantKey());
    }
    console.warn('⚠️ Ofertas de la web:', error.message);
    return 0;
  }
}

async function currentOffers(): Promise<Record<string, WebOffer>> {
  const key = tenantKey();
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < 5 * 60_000) return hit.offers;
  const offers = (await readState().catch(() => null))?.offers || {};
  cache.set(key, { at: Date.now(), offers });
  return offers;
}

/** El catálogo para vender (asistente, cotizaciones y pedidos): con el precio de oferta de la web donde lo haya. */
export async function getSellingCatalog(): Promise<any[]> {
  const [products, offers] = await Promise.all([getAllProducts(), currentOffers()]);
  return withOffers(products, offers);
}

/** Cada 30 minutos: VELAMIA y cada empresa que tenga su web conectada como fuente de ofertas. */
export function startWebOffers() {
  const tick = async () => {
    await runWithTenant(undefined, refreshWebOffers).catch(() => undefined);
    for (const tenant of await getActiveTenants().catch(() => [])) await runWithTenant(tenant, refreshWebOffers).catch(() => undefined);
  };
  setTimeout(() => { void tick(); }, 60_000);
  setInterval(() => { void tick(); }, 30 * 60_000);
}
