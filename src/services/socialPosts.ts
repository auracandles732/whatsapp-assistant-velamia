import { supabase, getConfig, setConfig, getAllProducts, tenantOp, tenantValue, tenantColumns } from './supabase';
import { writeSocialCaptions, productKey } from './openai';
import { BusinessProfile, profile } from '../config/businessProfile';

/**
 * Publicaciones en redes (servicio adicional): cada semana se preparan publicaciones con las fotos del catálogo,
 * la empresa las revisa en el CRM y se publican solas a la hora elegida (socialPublisher).
 */

export type PostChannel = 'instagram_feed' | 'instagram_story' | 'facebook';
export const POST_CHANNELS: PostChannel[] = ['instagram_feed', 'instagram_story', 'facebook'];
export type PostStatus = 'draft' | 'approved' | 'publishing' | 'published' | 'partial' | 'failed' | 'cancelled';

/** Estados en los que la empresa todavía puede cambiar la publicación. */
export const EDITABLE_STATUSES: PostStatus[] = ['draft', 'approved', 'failed'];

export interface PostProduct { name: string; image_url: string; price: number }

export interface SocialPost {
  id: string;
  scheduled_at: string;
  status: PostStatus;
  channels: PostChannel[];
  caption: string;
  products: PostProduct[];
  theme: string;
  results: Record<string, { id?: string; permalink?: string; error?: string }>;
  error: string | null;
  published_at: string | null;
}

export interface PublishingSettings {
  /** Días de la semana en que se publica: 0 = domingo … 6 = sábado. */
  days: number[];
  /** Hora local del negocio, "HH:MM". */
  hour: string;
  channels: PostChannel[];
  /** 1 = una foto; de 2 a 10 = carrusel (en historias va solo la primera). */
  photosPerPost: number;
  /** Preparar sola la semana siguiente. */
  autoPlan: boolean;
  /** Publicar sin que la empresa las apruebe. */
  autoApprove: boolean;
  /** Tono, hashtags fijos, lo que conviene destacar. */
  notes: string;
}

export const DEFAULT_SETTINGS: PublishingSettings = {
  days: [1, 3, 5],
  hour: '19:00',
  channels: ['instagram_feed', 'facebook'],
  photosPerPost: 1,
  autoPlan: true,
  autoApprove: false,
  notes: ''
};

const SETTINGS_KEY = 'social_posts_settings';

export function normalizeSettings(raw: any): PublishingSettings {
  const r = raw && typeof raw === 'object' ? raw : {};
  const days = Array.isArray(r.days) ? [...new Set(r.days.map(Number).filter((d: number) => Number.isInteger(d) && d >= 0 && d <= 6))].sort() as number[] : DEFAULT_SETTINGS.days;
  const hour = /^([01]\d|2[0-3]):[0-5]\d$/.test(String(r.hour)) ? String(r.hour) : DEFAULT_SETTINGS.hour;
  const channels = Array.isArray(r.channels) ? POST_CHANNELS.filter(c => r.channels.includes(c)) : DEFAULT_SETTINGS.channels;
  const photos = Math.round(Number(r.photosPerPost));
  return {
    days,
    hour,
    channels: channels.length ? channels : DEFAULT_SETTINGS.channels,
    photosPerPost: Number.isFinite(photos) ? Math.min(10, Math.max(1, photos)) : DEFAULT_SETTINGS.photosPerPost,
    autoPlan: typeof r.autoPlan === 'boolean' ? r.autoPlan : DEFAULT_SETTINGS.autoPlan,
    autoApprove: typeof r.autoApprove === 'boolean' ? r.autoApprove : DEFAULT_SETTINGS.autoApprove,
    notes: typeof r.notes === 'string' ? r.notes.trim().slice(0, 1000) : ''
  };
}

/** La configuración guardada, o null si la empresa nunca la guardó (entonces no se prepara nada sola). */
export async function getSavedSettings(): Promise<PublishingSettings | null> {
  const raw = await getConfig(SETTINGS_KEY);
  if (!raw) return null;
  try {
    return normalizeSettings(JSON.parse(raw));
  } catch {
    return null;
  }
}

export async function saveSettings(raw: unknown): Promise<PublishingSettings> {
  const settings = normalizeSettings(raw);
  await setConfig(SETTINGS_KEY, JSON.stringify(settings));
  return settings;
}

// ---------- Calendario ----------

/** Fecha y hora local de un instante en la zona del negocio. */
function localParts(date: Date, timeZone: string) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', weekday: 'short', hourCycle: 'h23'
  }).formatToParts(date).map(p => [p.type, p.value]));
  return {
    year: Number(parts.year), month: Number(parts.month), day: Number(parts.day),
    hour: Number(parts.hour), minute: Number(parts.minute),
    weekday: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(parts.weekday)
  };
}

/** Instante en que el reloj del negocio marca ese día y hora (sin librerías: se corrige el desfase de la zona). */
export function zonedTime(year: number, month: number, day: number, hour: number, minute: number, timeZone: string): Date {
  const wanted = Date.UTC(year, month - 1, day, hour, minute);
  let guess = wanted;
  for (let i = 0; i < 2; i++) {
    const p = localParts(new Date(guess), timeZone);
    guess += wanted - Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute);
  }
  return new Date(guess);
}

export const localDay = (date: Date | string, timeZone: string) => {
  const p = localParts(new Date(date), timeZone);
  return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
};

/**
 * Próximos días de publicación desde `from`. Se deja al menos una hora de margen: no se programa algo para dentro de
 * cinco minutos, que la empresa no alcanzaría a revisar.
 */
export function publishingSlots(settings: PublishingSettings, from: Date, days: number, timeZone: string): Date[] {
  const [hh, mm] = settings.hour.split(':').map(Number);
  const start = localParts(from, timeZone);
  const slots: Date[] = [];
  for (let i = 0; i < days; i++) {
    const noon = new Date(Date.UTC(start.year, start.month - 1, start.day + i, 12));
    const weekday = noon.getUTCDay();
    if (!settings.days.includes(weekday)) continue;
    const slot = zonedTime(noon.getUTCFullYear(), noon.getUTCMonth() + 1, noon.getUTCDate(), hh, mm, timeZone);
    if (slot.getTime() >= from.getTime() + 60 * 60 * 1000) slots.push(slot);
  }
  return slots;
}

// ---------- Qué productos mostrar ----------

interface CatalogItem { name: string; category?: string | null; image_url?: string | null; price: number }

// Temporadas: sus categorías salen primero cuando se acerca la fecha. Palabras sin tildes, en minúsculas.
const SEASONS: { months: number[]; words: string[] }[] = [
  { months: [10, 11, 12], words: ['navidad', 'navideno', 'christmas'] },
  { months: [1, 2], words: ['amor', 'valentin', 'enamorad'] },
  { months: [4, 5], words: ['madre', 'mama'] },
  { months: [5, 6, 7], words: ['graduacion', 'grado', 'padre', 'papa'] },
  { months: [9, 10], words: ['halloween', 'difunto'] }
];

const plain = (text: unknown) => String(text ?? '').normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase();
export const isSeasonal = (category: string, month: number) =>
  SEASONS.some(s => s.months.includes(month) && s.words.some(w => plain(category).includes(w)));

const titleCase = (text: string) => plain(text).length ? text.charAt(0).toUpperCase() + text.slice(1).toLowerCase() : text;

/**
 * Elige qué mostrar en cada publicación: primero lo que nunca se publicó y lo que hace más tiempo que no sale,
 * variando la categoría de una publicación a otra y dando prioridad a la temporada (Navidad en noviembre, etc.).
 * `recent` son los nombres ya publicados, del más nuevo al más viejo.
 */
export function pickProducts(catalog: CatalogItem[], recent: string[], slots: number, perPost: number, month: number): { theme: string; products: CatalogItem[] }[] {
  const withPhoto = catalog.filter(c => c.image_url && Number(c.price) >= 0);
  if (withPhoto.length === 0 || slots <= 0) return [];
  const lastSeen = new Map<string, number>();
  recent.forEach((name, i) => { if (!lastSeen.has(productKey(name))) lastSeen.set(productKey(name), i); });
  // Cuanto más alto, más tiempo sin publicarse (nunca publicado = lo más alto).
  const age = (c: CatalogItem) => lastSeen.has(productKey(c.name)) ? lastSeen.get(productKey(c.name))! : Number.MAX_SAFE_INTEGER;

  const byCategory = new Map<string, CatalogItem[]>();
  for (const c of withPhoto) {
    const cat = String(c.category || '').trim() || 'Productos';
    byCategory.set(cat, [...(byCategory.get(cat) || []), c]);
  }
  const used = new Set<string>();
  const timesUsed = new Map<string, number>();
  const picks: { theme: string; products: CatalogItem[] }[] = [];
  let previous = '';
  for (let i = 0; i < slots; i++) {
    const available = [...byCategory.entries()]
      .map(([cat, items]) => ({ cat, items: items.filter(c => !used.has(productKey(c.name))).sort((a, b) => age(b) - age(a)) }))
      .filter(x => x.items.length > 0);
    if (available.length === 0) break;
    // La temporada puede salir una publicación sí y otra no; el resto de categorías se turnan antes de repetirse.
    const weight = (cat: string) => (isSeasonal(cat, month) ? 0 : timesUsed.get(cat) || 0);
    available.sort((a, b) =>
      Number(a.cat === previous) - Number(b.cat === previous)
      || weight(a.cat) - weight(b.cat)
      || Number(isSeasonal(b.cat, month)) - Number(isSeasonal(a.cat, month))
      || age(b.items[0]) - age(a.items[0])
      || b.items.length - a.items.length);
    const chosen = available[0];
    const products = chosen.items.slice(0, perPost);
    products.forEach(p => used.add(productKey(p.name)));
    timesUsed.set(chosen.cat, (timesUsed.get(chosen.cat) || 0) + 1);
    picks.push({ theme: titleCase(chosen.cat), products });
    previous = chosen.cat;
  }
  return picks;
}

/** Texto de respaldo si la IA no responde: igual se puede publicar. */
export function fallbackCaption(post: { theme: string; products: { name: string; price: number }[] }, p: BusinessProfile = profile()): string {
  const s = p.sales, b = p.business;
  const body = [
    `${b.productEmoji} ${post.theme}`,
    ...post.products.map(x => `${titleCase(x.name)}: $${Number(x.price).toFixed(2)} ${s.priceSuffix}`),
    s.personalization && s.personalizationExamples ? `🎨 Se personalizan: ${s.personalizationExamples}.` : '',
    p.shipping.mode !== 'none' && p.shipping.coverage ? `📦 Envíos a ${p.shipping.coverage}.` : '',
    '📲 Escríbenos por WhatsApp o mensaje directo para tu pedido.'
  ].filter(Boolean).join('\n');
  const hashtags = [b.name, post.theme, b.city].map(t => `#${plain(t).replace(/[^a-z0-9]/g, '')}`).filter(t => t.length > 1).join(' ');
  return hashtags ? `${body}\n\n${hashtags}` : body;
}

// ---------- Base de datos ----------

const POSTS = 'social_posts';

export async function listPosts(fromIso: string, toIso: string): Promise<SocialPost[]> {
  const { data, error } = await supabase.from(POSTS).select('*')
    .filter('business_id', tenantOp(), tenantValue())
    .gte('scheduled_at', fromIso).lte('scheduled_at', toIso)
    .order('scheduled_at', { ascending: true });
  if (error) throw new Error(`Error leyendo publicaciones: ${error.message}`);
  return (data || []) as SocialPost[];
}

export async function getPost(id: string): Promise<SocialPost | null> {
  const { data, error } = await supabase.from(POSTS).select('*').eq('id', id).filter('business_id', tenantOp(), tenantValue()).maybeSingle();
  if (error) throw new Error(`Error leyendo la publicación: ${error.message}`);
  return data as SocialPost | null;
}

/** Productos publicados (o por publicar) últimamente, del más nuevo al más viejo: para no repetirlos. */
async function recentProductNames(): Promise<string[]> {
  const { data, error } = await supabase.from(POSTS).select('products, scheduled_at')
    .filter('business_id', tenantOp(), tenantValue())
    .neq('status', 'cancelled')
    .order('scheduled_at', { ascending: false })
    .limit(60);
  if (error) throw new Error(`Error leyendo publicaciones: ${error.message}`);
  return (data || []).flatMap((row: any) => (Array.isArray(row.products) ? row.products : []).map((p: any) => String(p.name || '')));
}

export async function insertPosts(rows: Partial<SocialPost>[]): Promise<SocialPost[]> {
  if (rows.length === 0) return [];
  const now = new Date().toISOString();
  const { data, error } = await supabase.from(POSTS)
    .insert(rows.map(r => ({ ...r, ...tenantColumns(), created_at: now, updated_at: now })))
    .select();
  if (error) throw new Error(`Error guardando publicaciones: ${error.message}`);
  return (data || []) as SocialPost[];
}

/** Cambia una publicación de la empresa actual; con `onlyIf` solo si sigue en uno de esos estados (evita publicar dos veces). */
export async function updatePost(id: string, changes: Partial<SocialPost>, onlyIf?: PostStatus[]): Promise<SocialPost | null> {
  let query = supabase.from(POSTS).update({ ...changes, updated_at: new Date().toISOString() })
    .eq('id', id).filter('business_id', tenantOp(), tenantValue());
  if (onlyIf) query = query.in('status', onlyIf);
  const { data, error } = await query.select().maybeSingle();
  if (error) throw new Error(`Error actualizando la publicación: ${error.message}`);
  return data as SocialPost | null;
}

/** Publicaciones aprobadas cuya hora ya llegó. */
export async function duePosts(now: Date): Promise<SocialPost[]> {
  const { data, error } = await supabase.from(POSTS).select('*')
    .filter('business_id', tenantOp(), tenantValue())
    .eq('status', 'approved')
    .lte('scheduled_at', now.toISOString())
    .order('scheduled_at', { ascending: true })
    .limit(10);
  if (error) throw new Error(`Error leyendo publicaciones pendientes: ${error.message}`);
  return (data || []) as SocialPost[];
}

/** Publicaciones que quedaron "publicando" (el servidor se reinició a la mitad): se marcan para revisar. */
export async function stuckPosts(olderThan: Date): Promise<SocialPost[]> {
  const { data, error } = await supabase.from(POSTS).select('*')
    .filter('business_id', tenantOp(), tenantValue())
    .eq('status', 'publishing')
    .lte('updated_at', olderThan.toISOString())
    .limit(10);
  if (error) throw new Error(`Error leyendo publicaciones: ${error.message}`);
  return (data || []) as SocialPost[];
}

// ---------- Preparar la semana ----------

export const toPostProduct = (c: CatalogItem): PostProduct => ({ name: c.name, image_url: String(c.image_url || ''), price: Number(c.price) });

/**
 * Prepara las publicaciones de los próximos días de publicación que todavía no tienen una. Un día que la empresa
 * descartó no se vuelve a llenar. Si la IA no responde, cada publicación lleva un texto de respaldo.
 */
export async function planUpcomingPosts(now = new Date(), days = 7, settingsParam?: PublishingSettings): Promise<SocialPost[]> {
  const settings = settingsParam || (await getSavedSettings()) || DEFAULT_SETTINGS;
  const p = profile();
  const tz = p.business.timezone;
  const slots = publishingSlots(settings, now, days, tz);
  if (slots.length === 0) return [];

  const existing = await listPosts(new Date(slots[0].getTime() - 86_400_000).toISOString(), new Date(slots[slots.length - 1].getTime() + 86_400_000).toISOString());
  const taken = new Set(existing.map(post => localDay(post.scheduled_at, tz)));
  const free = slots.filter(slot => !taken.has(localDay(slot, tz)));
  if (free.length === 0) return [];

  const [catalog, recent] = await Promise.all([getAllProducts(), recentProductNames()]);
  const picks = pickProducts(catalog, recent, free.length, settings.photosPerPost, localParts(now, tz).month);
  if (picks.length === 0) return [];

  let captions: string[] = [];
  try {
    captions = await writeSocialCaptions(picks.map(x => ({ theme: x.theme, products: x.products.map(c => ({ name: c.name, price: Number(c.price) })) })), settings.notes, p);
  } catch (error: any) {
    console.warn('⚠️ La IA no escribió los textos de las publicaciones; se usa el texto de respaldo:', error.message);
  }

  return insertPosts(picks.map((pick, i) => ({
    scheduled_at: free[i].toISOString(),
    status: settings.autoApprove ? 'approved' : 'draft',
    channels: settings.channels,
    caption: captions[i] || fallbackCaption(pick, p),
    products: pick.products.map(toPostProduct),
    theme: pick.theme,
    results: {},
    error: null
  })));
}

/** Otro texto para una publicación (botón "Otro texto" del CRM). */
export async function rewriteCaption(post: SocialPost, notes: string): Promise<string> {
  const [caption] = await writeSocialCaptions([{ theme: post.theme || 'Nuestros productos', products: post.products.map(x => ({ name: x.name, price: x.price })) }], notes);
  if (!caption) throw new Error('La IA no devolvió un texto');
  return caption;
}
