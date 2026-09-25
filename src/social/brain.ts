import { BusinessProfile } from '../config/businessProfile';
import { productKey } from '../services/openai';
import { writeCaptions, CaptionRequest, planWithAi, AiPlanItem, AiPlanRequest } from './ai';
import {
  pickProducts, CatalogItem, PublishingSettings, LibraryItem, isSeasonal, plain, titleCase, zonedTime, toHour,
  MAX_CAROUSEL, MAX_POSTS_PER_DAY, MAX_STORIES_PER_DAY
} from './posts';

/**
 * El "cerebro" del agente de redes: decide qué publicar, cuándo y en qué formato, y escribe los textos. Es independiente
 * del asistente que responde los mensajes: su propia clave de OpenAI y su propio modelo (ai.ts).
 * - Con "La IA decide" (postsPerDay = 0) la IA planifica la semana: cuántas publicaciones por día, a qué hora, de qué
 *   categoría, en qué formato (carrusel, foto, reel, historia) y por qué. Los productos, precios y fotos siempre salen
 *   del Catálogo (resolveAiPlan): la IA nunca inventa productos.
 * - Con un número fijo por día (o si la IA no responde) decide con reglas: lo que menos ha salido, variando la categoría
 *   y dando prioridad a la temporada.
 */

export type PostFormat = 'carrusel' | 'foto' | 'reel' | 'historia';

export interface PlanInput {
  /** Horas libres para el plan con reglas (n por día). */
  slots: Date[];
  /** Días de publicación sin nada programado, "AAAA-MM-DD" en la zona del negocio. */
  days: string[];
  catalog: CatalogItem[];
  /** Productos publicados últimamente, del más nuevo al más viejo. */
  recent: string[];
  /** Temas publicados últimamente, para no repetir (la IA los ve). */
  recentThemes: { day: string; theme: string }[];
  library: LibraryItem[];
  settings: PublishingSettings;
  month: number;
  now: Date;
  timeZone: string;
  profile: BusinessProfile;
}

export interface PlannedPost {
  theme: string;
  products: CatalogItem[];
  /** Cuándo sale. */
  at: Date;
  format: PostFormat;
  /** Por qué (se muestra en la planificación del CRM). */
  reason: string;
  /** Video de la biblioteca de un reel o una historia. */
  video?: LibraryItem;
}

export interface Plan { posts: PlannedPost[]; summary: string }

export interface SocialBrain {
  name: string;
  /** Qué publicar en los días y horas libres (puede devolver menos si no hay qué publicar). */
  plan(input: PlanInput): Promise<Plan>;
  /** Un texto por publicación, en el mismo orden. */
  write(posts: CaptionRequest[], profile: BusinessProfile): Promise<string[]>;
}

// Los textos los escribe la IA propia del agente (su clave y su modelo, nunca los del asistente de mensajes).
const write = (posts: CaptionRequest[], profile: BusinessProfile) => writeCaptions(posts, profile);

export const ruleBrain: SocialBrain = {
  name: 'reglas',
  async plan({ slots, catalog, recent, settings, month }) {
    const picks = pickProducts(catalog, recent, slots.length, settings.photosPerPost, month);
    const seasonal = picks.some(p => isSeasonal(p.products[0]?.category || '', month));
    return {
      posts: picks.map((pick, i) => ({
        ...pick,
        at: slots[i],
        format: pick.products.length > 1 ? 'carrusel' as const : 'foto' as const,
        reason: isSeasonal(pick.products[0]?.category || '', month) ? 'Es temporada: sale primero' : 'Lo que hace más tiempo no se publica'
      })),
      summary: `${settings.postsPerDay > 1 ? `${settings.postsPerDay} publicaciones` : 'Una publicación'} en cada día elegido, turnando las categorías y empezando por lo que hace más tiempo no sale${seasonal ? ', con la temporada primero' : ''}.`
    };
  },
  write
};

const WEEKDAYS = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];

/** Lo que ve la IA para planificar: categorías con cuántos productos tienen y cuánto se publicaron, videos y lo reciente. */
export function aiPlanRequest(input: PlanInput): AiPlanRequest {
  const { catalog, recent, recentThemes, library, settings, days, now, timeZone } = input;
  const recentKeys = recent.map(productKey);
  const categories = new Map<string, { productos: number; publicadosHace30Dias: number }>();
  for (const c of catalog.filter(c => c.image_url)) {
    const name = String(c.category || '').trim() || 'Productos';
    const entry = categories.get(name) || { productos: 0, publicadosHace30Dias: 0 };
    entry.productos++;
    if (recentKeys.includes(productKey(c.name))) entry.publicadosHace30Dias++;
    categories.set(name, entry);
  }
  const today = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
  return {
    hoy: `${today} (${WEEKDAYS[new Date(today + 'T12:00:00Z').getUTCDay()]})`,
    dias: days.map(dia => ({ dia, semana: WEEKDAYS[new Date(dia + 'T12:00:00Z').getUTCDay()] })),
    horaPreferida: settings.hour,
    maxPorDia: MAX_POSTS_PER_DAY,
    maxHistoriasPorDia: MAX_STORIES_PER_DAY,
    historias: settings.channels.includes('instagram_story'),
    publicaciones: settings.channels.some(c => c !== 'instagram_story'),
    categorias: [...categories.entries()].map(([categoria, v]) => ({ categoria, ...v })),
    videos: library.filter(a => a.kind === 'video').slice(0, 30).map(a => ({ id: a.id, producto: a.product_name || '' })),
    recientes: recentThemes.slice(0, 20).map(r => ({ dia: r.day, tema: r.theme }))
  };
}

/**
 * Convierte lo que decidió la IA en publicaciones de verdad: solo días libres y horas futuras, categorías y videos que
 * existen, productos del Catálogo (lo que hace más tiempo no sale, sin repetir en la semana) y los topes por día.
 * Lo que no cuadra se descarta.
 */
export function resolveAiPlan(items: AiPlanItem[], input: PlanInput): PlannedPost[] {
  const { catalog, recent, library, settings, days, now, timeZone } = input;
  const lastSeen = new Map<string, number>();
  recent.forEach((name, i) => { if (!lastSeen.has(productKey(name))) lastSeen.set(productKey(name), i); });
  const age = (c: CatalogItem) => (lastSeen.has(productKey(c.name)) ? lastSeen.get(productKey(c.name))! : Number.MAX_SAFE_INTEGER);
  const groups = new Map<string, { name: string; items: CatalogItem[] }>();
  for (const c of catalog.filter(c => c.image_url)) {
    const name = String(c.category || '').trim() || 'Productos';
    const group = groups.get(plain(name)) || { name, items: [] };
    group.items.push(c);
    groups.set(plain(name), group);
  }
  const storiesOn = settings.channels.includes('instagram_story');
  const feedOn = settings.channels.some(c => c !== 'instagram_story');
  const usedProducts = new Set<string>();
  const usedVideos = new Set<string>();
  const perDay = new Map<string, { feed: number; stories: number; times: number[] }>();
  const out: PlannedPost[] = [];

  for (const item of items.slice(0, days.length * (MAX_POSTS_PER_DAY + MAX_STORIES_PER_DAY))) {
    if (!days.includes(String(item.dia))) continue;
    let format: PostFormat = (['carrusel', 'foto', 'reel', 'historia'] as PostFormat[]).includes(item.formato as PostFormat) ? item.formato as PostFormat : 'foto';
    if (format === 'historia' ? !storiesOn : !feedOn) continue;
    const day = perDay.get(item.dia) || { feed: 0, stories: 0, times: [] };
    if (format === 'historia' ? day.stories >= MAX_STORIES_PER_DAY : day.feed >= MAX_POSTS_PER_DAY) continue;

    // Hora: entre 8:00 y 21:30, sin chocar con otra del mismo día (al menos 1 hora entre ellas).
    const match = String(item.hora || '').match(/^(\d{1,2}):(\d{2})$/);
    let minutes = match ? Number(match[1]) * 60 + Number(match[2]) : Number(settings.hour.slice(0, 2)) * 60 + Number(settings.hour.slice(3));
    minutes = Math.min(21 * 60 + 30, Math.max(8 * 60, minutes));
    while (day.times.some(t => Math.abs(t - minutes) < 60)) minutes += 60;
    if (minutes > 22 * 60) continue;
    const [y, m, d] = item.dia.split('-').map(Number);
    const [hh, mm] = toHour(minutes).split(':').map(Number);
    const at = zonedTime(y, m, d, hh, mm, timeZone);
    if (at.getTime() < now.getTime() + 60 * 60 * 1000) continue;

    // Reel o historia con video: el video de la biblioteca (y el producto que muestra, para el texto).
    const video = format === 'reel' || format === 'historia'
      ? library.find(a => a.kind === 'video' && a.id === item.video && !usedVideos.has(a.id))
      : undefined;
    if (format === 'reel' && !video) format = 'carrusel';
    let group = groups.get(plain(item.categoria));
    let products: CatalogItem[] = [];
    if (video) {
      const shown = catalog.find(c => video.product_name && productKey(c.name) === productKey(video.product_name));
      if (shown) {
        products = [shown];
        group = group || groups.get(plain(String(shown.category || '').trim() || 'Productos'));
      }
    } else {
      if (!group) continue;
      const want = format === 'carrusel' ? Math.min(MAX_CAROUSEL, Math.max(2, Math.round(Number(item.cantidad) || 3))) : 1;
      products = group.items.filter(c => !usedProducts.has(productKey(c.name))).sort((a, b) => age(b) - age(a)).slice(0, want);
      if (products.length === 0) continue;
      if (format === 'carrusel' && products.length === 1) format = 'foto';
    }

    products.forEach(p => usedProducts.add(productKey(p.name)));
    if (video) usedVideos.add(video.id);
    day.times.push(minutes);
    if (format === 'historia') day.stories++; else day.feed++;
    perDay.set(item.dia, day);
    out.push({ theme: group ? titleCase(group.name) : 'Nuestros productos', products, at, format, reason: String(item.motivo || '').trim().slice(0, 240), video });
  }
  return out.sort((a, b) => a.at.getTime() - b.at.getTime());
}

export const aiBrain: SocialBrain = {
  name: 'ia',
  async plan(input) {
    try {
      const plan = await planWithAi(aiPlanRequest(input), input.profile);
      const posts = resolveAiPlan(plan.publicaciones, input);
      if (posts.length) return { posts, summary: plan.resumen };
      console.warn('⚠️ La planificación de la IA no trajo publicaciones válidas; se usan las reglas');
    } catch (error: any) {
      console.warn('⚠️ La IA no pudo planificar; se usan las reglas:', error.message);
    }
    const fallback = await ruleBrain.plan(input);
    return { ...fallback, summary: `La IA no respondió, así que se usaron las reglas: ${fallback.summary}` };
  },
  write
};

let override: SocialBrain | null = null;

/** El cerebro que toca: "La IA decide" planifica con IA; un número fijo por día, con reglas. */
export const currentBrain = (settings?: PublishingSettings) => override || (settings && settings.postsPerDay === 0 ? aiBrain : ruleBrain);

/** Fija un cerebro (lo usan las pruebas); null vuelve al de la configuración. */
export function useBrain(next: SocialBrain | null) {
  override = next;
}
