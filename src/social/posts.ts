import { supabase, getConfig, setConfig, tenantOp, tenantValue, tenantColumns } from '../services/supabase';
import { productKey } from '../services/openai';
import { BusinessProfile, profile } from '../config/businessProfile';

/**
 * Publicaciones en redes (servicio adicional): la empresa programa publicaciones con las fotos del catálogo (o, en modo
 * automático, la IA las prepara cada semana) y se publican solas a la hora elegida (socialPublisher), sin aprobaciones.
 */

export type PostChannel = 'instagram_feed' | 'instagram_story' | 'facebook';
export const POST_CHANNELS: PostChannel[] = ['instagram_feed', 'instagram_story', 'facebook'];
export type PostStatus = 'draft' | 'approved' | 'publishing' | 'published' | 'partial' | 'failed' | 'cancelled';

/** Estados en los que la empresa todavía puede cambiar la publicación. */
export const EDITABLE_STATUSES: PostStatus[] = ['draft', 'approved', 'failed'];

export interface PostProduct { name: string; image_url: string; price: number }

/** Foto o video de la biblioteca que lleva la publicación (si no, van las fotos de los productos). */
export interface PostMedia { type: 'image' | 'video'; url: string; asset_id?: string }

/** Instagram acepta hasta 10 fotos o videos (o una mezcla) en un carrusel. */
export const MAX_CAROUSEL = 10;

/** Tope por día cuando decide la IA (o el máximo fijo que se puede elegir): más que eso ya cansa a los seguidores. */
export const MAX_POSTS_PER_DAY = 3;
export const MAX_STORIES_PER_DAY = 2;

/** Meta de fotos por día (Instagram deja publicar hasta 50 cosas al día por la API: queda muy por debajo). */
export const MAX_PHOTOS_PER_DAY = 30;
/** Tandas por día como máximo: más que eso satura a los seguidores. */
export const MAX_SETS_PER_DAY = 6;

export interface SocialPost {
  id: string;
  scheduled_at: string;
  status: PostStatus;
  channels: PostChannel[];
  caption: string;
  products: PostProduct[];
  media?: PostMedia[];
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
  /** Fotos por tanda como máximo: 1 = una foto; de 2 a 10 = carrusel o varias historias seguidas. */
  photosPerPost: number;
  /**
   * Fotos al día que busca el modo automático, sumando lo que ya está programado ese día (lo tuyo cuenta). Se reparten
   * en tandas de una sola categoría: publicaciones y/o historias según los canales elegidos.
   */
  photosPerDay: number;
  /** Modo automático: la IA elige los productos, escribe el texto y programa cada semana sola. */
  autoPlan: boolean;
  /**
   * Publicaciones por día: 0 = decide la IA (cuántas, a qué hora, de qué y en qué formato, hasta MAX_POSTS_PER_DAY
   * más historias); de 1 a 3 = fijas, a la hora elegida y cada 3 horas antes.
   */
  postsPerDay: number;
  /** Ya no se usa: todo lo programado se publica sin aprobación. Se conserva para leer configuraciones guardadas. */
  autoApprove: boolean;
  /**
   * Ya no se edita: el agente tiene un solo prompt (Cerebro IA, ai.ts). Se conserva solo para pasar ahí lo que se
   * había escrito en el cuadro viejo "Indicaciones para Nexly".
   */
  notes: string;
}

export const DEFAULT_SETTINGS: PublishingSettings = {
  days: [1, 3, 5],
  hour: '19:00',
  channels: ['instagram_feed', 'facebook'],
  photosPerPost: 5,
  photosPerDay: 10,
  autoPlan: false,
  postsPerDay: 0,
  autoApprove: true,
  notes: ''
};

const SETTINGS_KEY = 'social_posts_settings';

export function normalizeSettings(raw: any): PublishingSettings {
  const r = raw && typeof raw === 'object' ? raw : {};
  const days = Array.isArray(r.days) ? [...new Set(r.days.map(Number).filter((d: number) => Number.isInteger(d) && d >= 0 && d <= 6))].sort() as number[] : DEFAULT_SETTINGS.days;
  const hour = /^([01]\d|2[0-3]):[0-5]\d$/.test(String(r.hour)) ? String(r.hour) : DEFAULT_SETTINGS.hour;
  const channels = Array.isArray(r.channels) ? POST_CHANNELS.filter(c => r.channels.includes(c)) : DEFAULT_SETTINGS.channels;
  const photos = Math.round(Number(r.photosPerPost));
  const perDay = r.postsPerDay === undefined || r.postsPerDay === null || r.postsPerDay === '' ? NaN : Math.round(Number(r.postsPerDay));
  const photosDay = Math.round(Number(r.photosPerDay));
  return {
    days,
    hour,
    channels: channels.length ? channels : DEFAULT_SETTINGS.channels,
    photosPerPost: Number.isFinite(photos) ? Math.min(MAX_CAROUSEL, Math.max(1, photos)) : DEFAULT_SETTINGS.photosPerPost,
    photosPerDay: Number.isFinite(photosDay) && photosDay >= 1 ? Math.min(MAX_PHOTOS_PER_DAY, photosDay) : DEFAULT_SETTINGS.photosPerDay,
    autoPlan: typeof r.autoPlan === 'boolean' ? r.autoPlan : DEFAULT_SETTINGS.autoPlan,
    postsPerDay: Number.isFinite(perDay) && perDay >= 0 && perDay <= MAX_POSTS_PER_DAY ? perDay : DEFAULT_SETTINGS.postsPerDay,
    autoApprove: true,
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
export function localParts(date: Date, timeZone: string) {
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

const toMinutes = (hour: string) => { const [hh, mm] = hour.split(':').map(Number); return hh * 60 + mm; };
export const toHour = (minutes: number) => `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;

/** Horas de un día con n publicaciones: la elegida y, antes, cada 3 horas (13:00, 16:00, 19:00), nunca antes de las 8:00. */
export function dayHours(hour: string, n: number): string[] {
  const base = toMinutes(hour);
  const hours = new Set<number>();
  for (let k = n - 1; k >= 0; k--) {
    const t = base - k * 180;
    hours.add(t >= 480 ? t : 480 + (n - 1 - k) * 180);
  }
  return [...hours].sort((a, b) => a - b).map(toHour);
}

/** Días de publicación ("AAAA-MM-DD" en la zona del negocio) desde hoy. */
export function publishingDays(settings: PublishingSettings, from: Date, days: number, timeZone: string): string[] {
  const start = localParts(from, timeZone);
  const list: string[] = [];
  for (let i = 0; i < days; i++) {
    const noon = new Date(Date.UTC(start.year, start.month - 1, start.day + i, 12));
    if (settings.days.includes(noon.getUTCDay())) list.push(noon.toISOString().slice(0, 10));
  }
  return list;
}

/**
 * Próximas horas de publicación desde `from` (perDay por día de publicación). Se deja al menos una hora de margen: no
 * se programa algo para dentro de cinco minutos, que la empresa no alcanzaría a revisar.
 */
export function publishingSlots(settings: PublishingSettings, from: Date, days: number, timeZone: string, perDay = 1): Date[] {
  const slots: Date[] = [];
  for (const day of publishingDays(settings, from, days, timeZone)) {
    const [y, m, d] = day.split('-').map(Number);
    for (const hour of dayHours(settings.hour, perDay)) {
      const [hh, mm] = hour.split(':').map(Number);
      const slot = zonedTime(y, m, d, hh, mm, timeZone);
      if (slot.getTime() >= from.getTime() + 60 * 60 * 1000) slots.push(slot);
    }
  }
  return slots;
}

// ---------- Tandas del día ----------

/** Una tanda que el plan debe llenar: cuándo sale, dónde (publicación o historias) y cuántas fotos lleva. */
export interface DaySlot { day: string; at: Date; kind: 'feed' | 'story'; count: number }
/** Lo que ya está programado: día, hora local en minutos y cuántas fotos lleva. */
export interface DayUse { day: string; minutes: number; photos: number }

/** Horas de n tandas en un día: la última cerca de la hora elegida, cada 3 horas (o menos si no caben), de 8:00 a 21:30. */
export function setTimes(hour: string, n: number): number[] {
  const preferred = toMinutes(hour);
  const start = Math.max(8 * 60, Math.min(21 * 60 + 30, preferred) - 180 * (n - 1));
  const step = n > 1 ? Math.min(180, Math.floor((21 * 60 + 30 - start) / (n - 1))) : 0;
  return Array.from({ length: n }, (_, i) => start + step * i);
}

/**
 * Las tandas que faltan para llegar a la meta de fotos de cada día, contando lo que ya está programado (nunca se toca).
 * Cada tanda lleva hasta photosPerPost fotos; con publicaciones e historias activas, se turnan (primero la publicación).
 * Nunca a menos de una hora de otra publicación de ese día, ni en el pasado.
 */
export function daySlots(settings: PublishingSettings, days: string[], used: DayUse[], now: Date, timeZone: string): DaySlot[] {
  const storiesOn = settings.channels.includes('instagram_story');
  const feedOn = settings.channels.some(c => c !== 'instagram_story');
  if (!storiesOn && !feedOn) return [];
  const size = Math.min(MAX_CAROUSEL, Math.max(1, settings.photosPerPost));
  const slots: DaySlot[] = [];
  for (const day of days) {
    const today = used.filter(u => u.day === day);
    const missing = settings.photosPerDay - today.reduce((sum, u) => sum + u.photos, 0);
    if (missing <= 0) continue;
    const n = Math.min(MAX_SETS_PER_DAY, Math.ceil(missing / size));
    const counts = Array.from({ length: n }, (_, i) => Math.min(MAX_CAROUSEL, Math.floor(missing / n) + (i < missing % n ? 1 : 0)));
    const taken = today.map(u => u.minutes);
    const [y, m, d] = day.split('-').map(Number);
    setTimes(settings.hour, n).forEach((minutes, i) => {
      let t = minutes;
      while (taken.some(x => Math.abs(x - t) < 60)) t += 60;
      if (t > 22 * 60) return;
      const at = zonedTime(y, m, d, Math.floor(t / 60), t % 60, timeZone);
      if (at.getTime() < now.getTime() + 60 * 60 * 1000) return;
      taken.push(t);
      const kind: DaySlot['kind'] = storiesOn && feedOn ? (i % 2 === 0 ? 'feed' : 'story') : feedOn ? 'feed' : 'story';
      slots.push({ day, at, kind, count: counts[i] });
    });
  }
  return slots.sort((a, b) => a.at.getTime() - b.at.getTime());
}

/** Fotos que lleva una publicación (en historias, cada foto sale como una historia). */
export const photosOf = (post: Pick<SocialPost, 'media' | 'products'>) => Math.min(MAX_CAROUSEL, (post.media && post.media.length) || post.products.length || 0);

// ---------- Qué productos mostrar ----------

export interface CatalogItem { name: string; category?: string | null; image_url?: string | null; price: number }

// Temporadas: sus categorías salen primero cuando se acerca la fecha. Palabras sin tildes, en minúsculas.
const SEASONS: { months: number[]; words: string[] }[] = [
  { months: [10, 11, 12], words: ['navidad', 'navideno', 'christmas'] },
  { months: [1, 2], words: ['amor', 'valentin', 'enamorad'] },
  { months: [4, 5], words: ['madre', 'mama'] },
  { months: [5, 6, 7], words: ['graduacion', 'grado', 'padre', 'papa'] },
  { months: [9, 10], words: ['halloween', 'difunto'] }
];

export const plain = (text: unknown) => String(text ?? '').normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase();
export const isSeasonal = (category: string, month: number) =>
  SEASONS.some(s => s.months.includes(month) && s.words.some(w => plain(category).includes(w)));

export const titleCase = (text: string) => plain(text).length ? text.charAt(0).toUpperCase() + text.slice(1).toLowerCase() : text;

/**
 * Elige qué mostrar en cada publicación: primero lo que nunca se publicó y lo que hace más tiempo que no sale,
 * variando la categoría de una publicación a otra y dando prioridad a la temporada (Navidad en noviembre, etc.).
 * `recent` son los nombres ya publicados, del más nuevo al más viejo.
 */
export function pickProducts(catalog: CatalogItem[], recent: string[], slots: number, perPost: number | number[], month: number): { theme: string; products: CatalogItem[] }[] {
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
    const want = Array.isArray(perPost) ? perPost[i] || 1 : perPost;
    // La temporada puede salir una publicación sí y otra no; el resto de categorías se turnan antes de repetirse.
    // Primero las que alcanzan para llenar la tanda (una categoría por tanda, nunca mezcladas).
    const weight = (cat: string) => (isSeasonal(cat, month) ? 0 : timesUsed.get(cat) || 0);
    const fills = (x: { items: CatalogItem[] }) => Number(x.items.length >= Math.min(want, 3));
    available.sort((a, b) =>
      fills(b) - fills(a)
      || Number(a.cat === previous) - Number(b.cat === previous)
      || weight(a.cat) - weight(b.cat)
      || Number(isSeasonal(b.cat, month)) - Number(isSeasonal(a.cat, month))
      || age(b.items[0]) - age(a.items[0])
      || b.items.length - a.items.length);
    const chosen = available[0];
    const products = chosen.items.slice(0, want);
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
    // Las eliminadas no se muestran y su día queda libre para programar otra.
    .neq('status', 'cancelled')
    .order('scheduled_at', { ascending: true });
  if (error) throw new Error(`Error leyendo publicaciones: ${error.message}`);
  return (data || []) as SocialPost[];
}

/** Borra una publicación que todavía no salió (ni se está publicando). Devuelve false si ya no se podía. */
export async function deletePost(id: string): Promise<boolean> {
  const { data, error } = await supabase.from(POSTS).delete()
    .eq('id', id).filter('business_id', tenantOp(), tenantValue())
    .in('status', [...EDITABLE_STATUSES, 'cancelled'])
    .select('id');
  if (error) throw new Error(`Error eliminando la publicación: ${error.message}`);
  return (data || []).length > 0;
}

export async function getPost(id: string): Promise<SocialPost | null> {
  const { data, error } = await supabase.from(POSTS).select('*').eq('id', id).filter('business_id', tenantOp(), tenantValue()).maybeSingle();
  if (error) throw new Error(`Error leyendo la publicación: ${error.message}`);
  return data as SocialPost | null;
}

/** Productos publicados (o por publicar) últimamente, del más nuevo al más viejo: para no repetirlos. */
export async function recentProductNames(): Promise<string[]> {
  return (await recentActivity()).names;
}

/** Lo publicado (o programado) últimamente, del más nuevo al más viejo: productos y temas por día. */
export async function recentActivity(timeZone = profile().business.timezone): Promise<{ names: string[]; themes: { day: string; theme: string }[] }> {
  const { data, error } = await supabase.from(POSTS).select('products, scheduled_at, theme')
    .filter('business_id', tenantOp(), tenantValue())
    .neq('status', 'cancelled')
    .order('scheduled_at', { ascending: false })
    .limit(60);
  if (error) throw new Error(`Error leyendo publicaciones: ${error.message}`);
  const rows = (data || []) as any[];
  return {
    names: rows.flatMap(row => (Array.isArray(row.products) ? row.products : []).map((p: any) => String(p.name || ''))),
    themes: rows.map(row => ({ day: localDay(row.scheduled_at, timeZone), theme: String(row.theme || '') }))
  };
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

/** Lo que quedó "por revisar" (antes había que aprobar cada publicación) pasa a programado. */
export async function scheduleDrafts(): Promise<void> {
  const { error } = await supabase.from(POSTS).update({ status: 'approved', updated_at: new Date().toISOString() })
    .filter('business_id', tenantOp(), tenantValue())
    .eq('status', 'draft');
  if (error) throw new Error(`Error programando publicaciones: ${error.message}`);
  // Las "descartadas" de antes ya no sirven: se borran para que su día se pueda volver a llenar.
  const { error: purgeError } = await supabase.from(POSTS).delete()
    .filter('business_id', tenantOp(), tenantValue())
    .eq('status', 'cancelled');
  if (purgeError) throw new Error(`Error limpiando publicaciones: ${purgeError.message}`);
}

/** Publicaciones (no eliminadas) entre dos horas: para no guardar dos veces la misma. */
export async function postsBetween(fromIso: string, toIso: string): Promise<SocialPost[]> {
  const { data, error } = await supabase.from(POSTS).select('*')
    .filter('business_id', tenantOp(), tenantValue())
    .gte('scheduled_at', fromIso).lte('scheduled_at', toIso)
    .neq('status', 'cancelled');
  if (error) throw new Error(`Error leyendo publicaciones: ${error.message}`);
  return (data || []) as SocialPost[];
}

/** Huella de una publicación: misma hora, redes, texto y fotos = la misma. */
export function postFingerprint(post: { scheduled_at: string; channels: string[]; caption: string; products?: { image_url: string }[]; media?: { url: string }[] }): string {
  const items = (post.media && post.media.length ? post.media.map(m => m.url) : (post.products || []).map(p => p.image_url)).join(',');
  return [new Date(post.scheduled_at).toISOString(), [...post.channels].sort().join(','), post.caption.trim(), items].join('|');
}

/** Publicaciones programadas cuya hora ya llegó. */
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

export interface LibraryItem { id: string; kind: 'image' | 'video'; url: string; product_name: string | null; used_count?: number }

/**
 * Carrusel del modo automático: cada foto del Catálogo va seguida de los videos y fotos de la biblioteca que muestran
 * ese producto (los videos y los menos usados primero), hasta 10. Un archivo se usa una sola vez por tanda (taken).
 * Si no cabe todo, el producto que queda fuera tampoco se nombra en el texto. Sin archivos de esos productos, media
 * va vacío y se publican solo las fotos del Catálogo, como siempre.
 */
export function withLibraryMedia(products: PostProduct[], library: LibraryItem[], taken: Set<string>): { products: PostProduct[]; media: PostMedia[] } {
  const media: PostMedia[] = [];
  const kept: PostProduct[] = [];
  const picked: string[] = [];
  for (const product of products) {
    if (media.length >= MAX_CAROUSEL) break;
    kept.push(product);
    media.push({ type: 'image', url: product.image_url });
    const linked = library
      .filter(a => a.product_name && productKey(a.product_name) === productKey(product.name) && !taken.has(a.id) && !picked.includes(a.id))
      .sort((a, b) => Number(b.kind === 'video') - Number(a.kind === 'video') || (a.used_count || 0) - (b.used_count || 0));
    for (const asset of linked) {
      if (media.length >= MAX_CAROUSEL) break;
      media.push({ type: asset.kind, url: asset.url, asset_id: asset.id });
      picked.push(asset.id);
    }
  }
  picked.forEach(id => taken.add(id));
  return { products: kept, media: picked.length ? media : [] };
}
