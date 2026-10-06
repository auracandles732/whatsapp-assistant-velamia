import { supabase, tenantColumns, tenantOp, tenantValue, parseDbTimestamp, getAllConversations } from '../services/supabase';
import { plain } from './posts';

/**
 * Atribución comercial del agente de redes (para todas las empresas). Cada publicación lleva un código corto en su
 * llamado a la acción ("Escríbenos BAUTIZO07"); cuando una clienta lo escribe, o responde a esa historia, el chat queda
 * unido a la publicación y se sabe qué contenido trae chats, cotizaciones, pedidos y ventas. Si no usa el código, se
 * estima (llegó poco después de la publicación y preguntó por esa categoría o producto) y se marca como estimada.
 * Los totales no se guardan: se calculan, así siempre cuadran aunque se cancele un pedido o se borre un chat.
 * Sin la migración 026 todo sigue funcionando, solo que sin códigos.
 */

const TRACKING = 'content_tracking';
const ATTRIBUTIONS = 'content_attributions';

export type ContentGoal = 'alcance' | 'interaccion' | 'confianza' | 'consulta' | 'venta';
export const CONTENT_GOALS: ContentGoal[] = ['alcance', 'interaccion', 'confianza', 'consulta', 'venta'];
export type AttributionMethod = 'exacta' | 'historia' | 'estimada';

export interface TrackingRow {
  id: string; code: string; post_id: string; category: string; product_name: string; content_type: string;
  content_goal: string; cta: string; source: string; platforms: string[]; publish_at: string | null;
}

let available: { ok: boolean; at: number } | null = null;
let warned = false;

/** ¿Ya se aplicó la migración 026? Se revisa cada 10 minutos. */
export async function trackingAvailable(): Promise<boolean> {
  if (available && Date.now() - available.at < 10 * 60_000) return available.ok;
  const { error } = await supabase.from(TRACKING).select('id').limit(1);
  const ok = !error;
  if (!ok && !warned) {
    console.warn('⚠️ Atribución de contenido apagada: falta aplicar migrations/026_atribucion_de_contenido.sql en Supabase');
    warned = true;
  }
  available = { ok, at: Date.now() };
  return ok;
}

// Palabras que no sirven de prefijo: "Vela de bautizo" → BAUTIZO.
const FILLER = new Set(['vela', 'velas', 'velita', 'velitas', 'recuerdo', 'recuerdos', 'de', 'del', 'para', 'con', 'nuestros', 'nuestras', 'productos', 'producto', 'la', 'el', 'los', 'las', 'y', 'en', 'mi', 'tu']);

/** Prefijo del código según la categoría (sin tildes, de 3 a 11 letras); sin categoría útil, el nombre de la empresa. */
export function codePrefix(theme: string, business: string): string {
  const word = plain(theme).replace(/[^a-z\s]/g, ' ').split(/\s+/).find(w => w.length >= 3 && !FILLER.has(w))
    || plain(business).replace(/[^a-z]/g, '') || 'post';
  return word.toUpperCase().slice(0, 11);
}

export const formatCode = (prefix: string, n: number) => `${prefix.toUpperCase()}${String(n).padStart(2, '0')}`;

/** Los códigos que aparecen en lo que escribió la clienta, ya normalizados ("bautizo 7" → BAUTIZO07). */
export function codesIn(text: string): string[] {
  const out: string[] = [];
  // Una fecha ("bautizo 15 de noviembre", "bautizo 15/11") no es un código.
  const re = /(?<![a-zñ])([a-zñ]{3,11})\s*[-#°º.]?\s*0*(\d{1,3})(?!\d)(?!\s*(de\s+)?(ene|feb|mar|abr|may|jun|jul|ago|sep|oct|nov|dic)|\s*[/-]\s*\d)/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(plain(text))) !== null) out.push(formatCode(m[1], Number(m[2])));
  return [...new Set(out)];
}

/** Siguiente código libre para cada tema (BAUTIZO07, BAUTIZO08…), sin repetir dentro de la empresa. */
export async function nextCodes(themes: string[], business: string): Promise<string[]> {
  const { data, error } = await supabase.from(TRACKING).select('code').filter('business_id', tenantOp(), tenantValue()).limit(10000);
  if (error) throw new Error(`Error leyendo los códigos: ${error.message}`);
  const max = new Map<string, number>();
  for (const row of data || []) {
    const m = String(row.code).match(/^([A-Z]+)(\d+)$/);
    if (m) max.set(m[1], Math.max(max.get(m[1]) || 0, Number(m[2])));
  }
  return themes.map(theme => {
    const prefix = codePrefix(theme, business);
    const n = (max.get(prefix) || 0) + 1;
    max.set(prefix, n);
    return formatCode(prefix, n);
  });
}

export interface TrackingInput {
  code: string; postId: string; category: string; productName: string; contentType: string; goal: string; cta: string;
  source: string; platforms: string[]; publishAt: string;
}

/** Guarda el código de cada publicación nueva. Nunca frena la planificación: si falla, solo se registra. */
export async function saveTracking(rows: TrackingInput[]): Promise<void> {
  if (rows.length === 0 || !(await trackingAvailable())) return;
  const { error } = await supabase.from(TRACKING).insert(rows.map(r => ({
    ...tenantColumns(), code: r.code, post_id: r.postId, category: r.category.slice(0, 80), product_name: r.productName.slice(0, 160),
    content_type: r.contentType, content_goal: r.goal, cta: r.cta.slice(0, 200), source: r.source, platforms: r.platforms, publish_at: r.publishAt
  })));
  if (error) console.warn('⚠️ No se guardaron los códigos de las publicaciones:', error.message);
}

export async function trackingForPosts(postIds: string[]): Promise<TrackingRow[]> {
  if (postIds.length === 0 || !(await trackingAvailable())) return [];
  const rows: TrackingRow[] = [];
  for (let i = 0; i < postIds.length; i += 100) {
    const { data, error } = await supabase.from(TRACKING).select('*').filter('business_id', tenantOp(), tenantValue()).in('post_id', postIds.slice(i, i + 100));
    if (error) throw new Error(`Error leyendo los códigos: ${error.message}`);
    rows.push(...((data || []) as TrackingRow[]));
  }
  return rows;
}

async function attribute(conversationId: string, trackingId: string, method: AttributionMethod) {
  const { error } = await supabase.from(ATTRIBUTIONS).upsert(
    [{ ...tenantColumns(), conversation_id: conversationId, tracking_id: trackingId, method }],
    { onConflict: 'conversation_id,tracking_id', ignoreDuplicates: true }
  );
  if (error) console.warn('⚠️ No se anotó de qué publicación vino el chat:', error.message);
}

/**
 * Lo que la vendedora necesita saber cuando la clienta llega por una publicación. products = lo que mostraba la
 * publicación; seen = el producto exacto de la historia a la que respondió (si se sabe).
 */
export function codeContext(row: Pick<TrackingRow, 'code' | 'category' | 'product_name' | 'platforms'>, products: string[] = [], seen = '', viaStory = false): string {
  const where = (row.platforms || []).some(p => p.startsWith('facebook')) && !(row.platforms || []).some(p => p.startsWith('instagram')) ? 'Facebook' : 'Instagram o Facebook';
  const how = viaStory ? `La clienta respondió a una historia (código ${row.code})` : `La clienta escribió ${row.code}, el código de una publicación de ${where}`;
  const category = row.category && !/nuestros productos/i.test(row.category) ? ` (categoría ${row.category})` : '';
  const list = [...new Set(products.filter(Boolean))].slice(0, 6);
  if (seen) return `[${how} del producto ${seen}${category}. Atiéndela directo con ese producto (muéstraselo con su precio) y avanza hacia la cotización; no le expliques qué es el código.]`;
  if (list.length > 1) return `[${how}${category}. Esa publicación mostraba: ${list.join(', ')}. Muéstrale esas opciones con su precio y pregúntale cuál le gustó, y avanza hacia la cotización; no le expliques qué es el código.]`;
  const one = list[0] || row.product_name;
  return `[${how}${one ? ` del producto ${one}` : ''}${category}. Atiéndela directo con ${one ? 'ese producto (muéstraselo con su precio)' : 'opciones de esa categoría'} y avanza hacia la cotización; no le expliques qué es el código.]`;
}

/** Los productos que mostraba una publicación (en orden). */
async function postProducts(postId: string): Promise<{ names: string[]; media: any[] }> {
  const { data } = await supabase.from('social_posts').select('products, media').eq('id', postId).filter('business_id', tenantOp(), tenantValue()).maybeSingle();
  return { names: (data?.products || []).map((p: any) => String(p?.name || '')).filter(Boolean), media: data?.media || [] };
}

/**
 * Si la clienta escribió el código de una publicación, el chat queda unido a ella (atribución exacta). Devuelve el
 * aviso para la vendedora ('' si no había código).
 */
export async function attributeByCode(conversationId: string, text: string): Promise<string> {
  const codes = codesIn(text);
  if (codes.length === 0 || !(await trackingAvailable())) return '';
  const { data, error } = await supabase.from(TRACKING).select('*').filter('business_id', tenantOp(), tenantValue()).in('code', codes).limit(1);
  if (error || !data || data.length === 0) return '';
  const row = data[0] as TrackingRow;
  await attribute(conversationId, row.id, 'exacta');
  console.log(`🔖 Chat atribuido a la publicación ${row.code}`);
  return codeContext(row, (await postProducts(row.post_id).catch(() => ({ names: [] as string[] }))).names);
}

/** La clienta respondió a una historia de Instagram o Facebook: se busca qué publicación era (atribución exacta). */
export async function attributeStoryReply(conversationId: string, storyId: string): Promise<string> {
  if (!storyId || !(await trackingAvailable())) return '';
  const since = new Date(Date.now() - 3 * 86_400_000).toISOString();
  const { data: posts } = await supabase.from('social_posts').select('id, results').filter('business_id', tenantOp(), tenantValue())
    .gte('scheduled_at', since).in('status', ['published', 'partial']).limit(200);
  const post = (posts || []).find((p: any) => Object.values(p.results || {}).some((r: any) => r && (r.id === storyId || (Array.isArray(r.ids) && r.ids.includes(storyId)))));
  if (!post) return '';
  const [row] = await trackingForPosts([post.id]);
  if (!row) return '';
  await attribute(conversationId, row.id, 'historia');
  console.log(`🔖 Respuesta a la historia ${row.code}: chat atribuido`);
  // Cada foto de la tanda es una historia: la posición de la historia dice qué producto vio (solo con fotos del Catálogo).
  const { names, media } = await postProducts(row.post_id).catch(() => ({ names: [] as string[], media: [] as any[] }));
  const ids = (Object.values(post.results || {}) as any[]).find(r => r && (r.id === storyId || (Array.isArray(r.ids) && r.ids.includes(storyId))));
  const at = Array.isArray(ids?.ids) ? ids.ids.indexOf(storyId) : -1;
  const seen = at >= 0 && !media.length && names[at] ? names[at] : '';
  return codeContext(row, names, seen, true);
}

/**
 * Atribución estimada: chats nuevos sin código que llegaron hasta 24 horas después de una publicación y preguntaron por
 * esa categoría o ese producto. Se marca aparte para no confundirla con la exacta.
 */
export async function estimateAttributions(now = new Date()): Promise<number> {
  if (!(await trackingAvailable())) return 0;
  const since = new Date(now.getTime() - 3 * 86_400_000);
  const fresh = (await getAllConversations()).filter((c: any) => c.created_at && parseDbTimestamp(c.created_at) >= since);
  if (fresh.length === 0) return 0;
  const ids = fresh.map((c: any) => c.id as string);
  const { data: done } = await supabase.from(ATTRIBUTIONS).select('conversation_id').in('conversation_id', ids);
  const already = new Set((done || []).map((d: any) => d.conversation_id));
  const pending = fresh.filter((c: any) => !already.has(c.id));
  if (pending.length === 0) return 0;
  const { data: tracking } = await supabase.from(TRACKING).select('*').filter('business_id', tenantOp(), tenantValue())
    .gte('publish_at', new Date(since.getTime() - 86_400_000).toISOString()).lte('publish_at', now.toISOString()).limit(1000);
  const published = (tracking || []) as TrackingRow[];
  if (published.length === 0) return 0;
  const { data: msgs } = await supabase.from('messages').select('conversation_id, content, timestamp').in('conversation_id', pending.map((c: any) => c.id))
    .eq('sender', 'customer').order('timestamp', { ascending: true }).limit(2000);
  let count = 0;
  for (const conv of pending) {
    const startedAt = parseDbTimestamp(conv.created_at).getTime();
    const said = plain((msgs || []).filter((m: any) => m.conversation_id === conv.id).slice(0, 8).map((m: any) => m.content).join(' '));
    if (!said) continue;
    const match = estimateFor(said, startedAt, published);
    if (!match) continue;
    await attribute(conv.id, match.id, 'estimada');
    count++;
  }
  return count;
}

/** La publicación más reciente (hasta 24 h antes del chat) cuyo producto o categoría nombró la clienta. Sin efectos. */
export function estimateFor(saidPlain: string, startedAt: number, published: Pick<TrackingRow, 'id' | 'category' | 'product_name' | 'publish_at'>[]) {
  const words = (text: string) => plain(text).replace(/[^a-z0-9ñ\s]/g, ' ').split(/\s+/).filter(w => w.length >= 4 && !FILLER.has(w));
  return published
    .filter(t => t.publish_at && parseDbTimestamp(t.publish_at).getTime() <= startedAt && startedAt - parseDbTimestamp(t.publish_at).getTime() <= 24 * 3_600_000)
    .filter(t => {
      const product = plain(t.product_name || '').trim();
      if (product && saidPlain.includes(product)) return true;
      return words(t.category).some(w => saidPlain.includes(w));
    })
    .sort((a, b) => String(b.publish_at).localeCompare(String(a.publish_at)))[0] || null;
}

// ---------- Resultados por contenido ----------

export interface ContentResult {
  code: string; postId: string; category: string; productName: string; contentType: string; goal: string; cta: string; publishAt: string | null;
  reach: number; views: number; interactions: number;
  chats: number; exactChats: number; quotations: number; orders: number; sales: number; revenue: number;
}

const PAID = new Set(['confirmed', 'shipped', 'delivered']);

/**
 * Qué trajo cada publicación de un período: alcance e interacciones (de Meta) y chats, cotizaciones, pedidos, ventas e
 * ingresos (de las atribuciones). Lo que pasó en el chat cuenta desde que llegó por esa publicación.
 */
export async function contentResults(from: Date, to: Date): Promise<ContentResult[]> {
  if (!(await trackingAvailable())) return [];
  const { data: rows, error } = await supabase.from(TRACKING).select('*').filter('business_id', tenantOp(), tenantValue())
    .gte('publish_at', from.toISOString()).lt('publish_at', to.toISOString()).limit(2000);
  if (error) throw new Error(`Error leyendo los códigos: ${error.message}`);
  const tracking = (rows || []) as TrackingRow[];
  if (tracking.length === 0) return [];
  const trackingIds = tracking.map(t => t.id);
  const postIds = tracking.map(t => t.post_id);
  const [attrs, metrics] = await Promise.all([
    supabase.from(ATTRIBUTIONS).select('conversation_id, tracking_id, method, created_at').in('tracking_id', trackingIds).limit(5000),
    supabase.from('social_metrics').select('post_id, channel, likes, comments, views, reach, saves, shares').in('post_id', postIds).limit(5000)
  ]);
  const attributions = (attrs.data || []) as { conversation_id: string; tracking_id: string; method: string; created_at: string }[];
  const convIds = [...new Set(attributions.map(a => a.conversation_id))];
  const [quotes, orders] = convIds.length
    ? await Promise.all([
      supabase.from('quotations').select('conversation_id, created_at').in('conversation_id', convIds).limit(5000),
      supabase.from('orders').select('conversation_id, created_at, status, total_amount').in('conversation_id', convIds).neq('status', 'cancelled').limit(5000)
    ])
    : [{ data: [] }, { data: [] }] as any[];
  const byPost = new Map<string, any[]>();
  for (const m of metrics.data || []) byPost.set(m.post_id, [...(byPost.get(m.post_id) || []), m]);
  return tracking.map(t => {
    const mine = attributions.filter(a => a.tracking_id === t.id);
    const after = (list: any[], convId: string, since: string) => list.filter(x => x.conversation_id === convId && parseDbTimestamp(x.created_at).getTime() >= parseDbTimestamp(since).getTime() - 10 * 60_000);
    let quotations = 0, ordersN = 0, sales = 0, revenue = 0;
    for (const a of mine) {
      if (after(quotes.data || [], a.conversation_id, a.created_at).length) quotations++;
      const o = after(orders.data || [], a.conversation_id, a.created_at);
      if (o.length) ordersN++;
      const paid = o.filter((x: any) => PAID.has(x.status));
      if (paid.length) { sales++; revenue += paid.reduce((s: number, x: any) => s + Number(x.total_amount || 0), 0); }
    }
    const m = byPost.get(t.post_id) || [];
    const sum = (k: string) => m.reduce((s, x) => s + Number(x[k] || 0), 0);
    return {
      code: t.code, postId: t.post_id, category: t.category, productName: t.product_name, contentType: t.content_type, goal: t.content_goal, cta: t.cta, publishAt: t.publish_at,
      reach: sum('reach'), views: sum('views'), interactions: sum('likes') + sum('comments') + sum('shares') + sum('saves'),
      chats: mine.length, exactChats: mine.filter(a => a.method !== 'estimada').length, quotations, orders: ordersN, sales, revenue: Math.round(revenue * 100) / 100
    };
  });
}

export interface CategoryResult { category: string; posts: number; reach: number; interactions: number; chats: number; quotations: number; orders: number; sales: number; revenue: number; enoughData: boolean }

/** Suma por categoría. "Datos suficientes" = al menos 3 publicaciones con métricas: si no, no se sacan conclusiones. */
export function byCategory(results: ContentResult[]): CategoryResult[] {
  const map = new Map<string, CategoryResult>();
  for (const r of results) {
    const key = r.category || 'Sin categoría';
    const c = map.get(key) || { category: key, posts: 0, reach: 0, interactions: 0, chats: 0, quotations: 0, orders: 0, sales: 0, revenue: 0, enoughData: false };
    c.posts++; c.reach += r.reach; c.interactions += r.interactions; c.chats += r.chats; c.quotations += r.quotations; c.orders += r.orders; c.sales += r.sales; c.revenue += r.revenue;
    map.set(key, c);
  }
  return [...map.values()].map(c => ({ ...c, revenue: Math.round(c.revenue * 100) / 100, enoughData: c.posts >= 3 })).sort((a, b) => b.quotations - a.quotations || b.chats - a.chats || b.reach - a.reach);
}

/**
 * Hasta 3 recomendaciones con reglas (sin IA), solo cuando hay datos: con pocas publicaciones o sin chats atribuidos,
 * "SIN DATOS SUFICIENTES" (nunca se inventa rendimiento).
 */
export function recommendations(categories: CategoryResult[], results: ContentResult[]): string[] {
  const enough = categories.filter(c => c.enoughData);
  const chats = results.reduce((s, r) => s + r.chats, 0);
  if (enough.length < 2 || chats < 5) return ['SIN DATOS SUFICIENTES: todavía hay pocas publicaciones con código o pocos chats atribuidos para sacar conclusiones. El agente sigue decidiendo por temporada, variedad y antigüedad.'];
  const out: string[] = [];
  const rate = (c: CategoryResult) => c.chats / c.posts;
  const best = [...enough].sort((a, b) => b.quotations / b.posts - a.quotations / a.posts || rate(b) - rate(a))[0];
  if (best && (best.quotations > 0 || best.chats > 0)) out.push(`${best.category} es la que más consultas y cotizaciones trae por publicación: conviene subir ligeramente su frecuencia (sin quitar las demás).`);
  const reachNoSales = [...enough].sort((a, b) => b.reach / b.posts - a.reach / a.posts).find(c => c.chats === 0 && c !== best);
  if (reachNoSales) out.push(`${reachNoSales.category} tiene buen alcance pero no trae chats: prueba un llamado a la acción más directo (cantidad, fecha o "escríbenos el código").`);
  const exact = results.reduce((s, r) => s + r.exactChats, 0);
  if (exact < chats / 2) out.push('La mayoría de chats llegan sin el código: dale más visibilidad al código en las historias (al final de la tanda) para medir mejor.');
  return out.slice(0, 3);
}
