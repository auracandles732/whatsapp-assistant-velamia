import { BusinessProfile } from '../config/businessProfile';
import { productKey } from '../services/openai';
import { writeCaptions, CaptionRequest, planWithAi, AiAssignment, AiPlanRequest } from './ai';
import { pickProducts, CatalogItem, PublishingSettings, LibraryItem, isSeasonal, plain, titleCase, localParts, DaySlot } from './posts';

/**
 * El "cerebro" del agente de redes: decide QUÉ mostrar en cada tanda y escribe los textos. Cuántas fotos, cuándo y dónde
 * lo decide el sistema (daySlots en posts.ts) para llegar a la meta de fotos de cada día: así el plan siempre se cumple y
 * se entiende. Cada tanda es de una sola categoría y los productos, precios y fotos salen del Catálogo.
 * - Con la IA (postsPerDay = 0, o si la dueña escribe un pedido) la IA elige la categoría de cada tanda y explica por qué.
 * - Con reglas (o si la IA no responde): lo que menos ha salido, variando la categoría y con la temporada primero.
 */

export type PostFormat = 'carrusel' | 'foto' | 'reel' | 'historia';

export interface PlanInput {
  /** Tandas a llenar (día, hora, publicación o historias, cuántas fotos). */
  slots: DaySlot[];
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
  /** Lo que la dueña pidió para esta planificación. */
  request?: string;
}

export interface PlannedPost {
  theme: string;
  products: CatalogItem[];
  /** Cuándo sale. */
  at: Date;
  format: PostFormat;
  /** Por qué (se muestra en la planificación del CRM). */
  reason: string;
  /** Video de la biblioteca (ya no lo elige el plan; se conserva para publicaciones hechas a mano). */
  video?: LibraryItem;
}

export interface Plan { posts: PlannedPost[]; summary: string; /** Cosas que la dueña puede hacer (grabar un video…). */ tasks?: string[] }

export interface SocialBrain {
  name: string;
  /** Qué mostrar en cada tanda (puede devolver menos si no hay qué publicar). */
  plan(input: PlanInput): Promise<Plan>;
  /** Un texto por publicación, en el mismo orden. */
  write(posts: CaptionRequest[], profile: BusinessProfile): Promise<string[]>;
}

// Los textos los escribe la IA propia del agente (su clave y su modelo, nunca los del asistente de mensajes).
const write = (posts: CaptionRequest[], profile: BusinessProfile) => writeCaptions(posts, profile);

/** Historias para las tandas de historias; en publicaciones, carrusel si lleva más de una foto. */
export const formatOf = (slot: DaySlot, photos: number): PostFormat => (slot.kind === 'story' ? 'historia' : photos > 1 ? 'carrusel' : 'foto');

/** Qué se planificó, en palabras simples: fotos por día y cómo se reparten. */
export function planSummary(posts: PlannedPost[], settings: PublishingSettings): string {
  if (posts.length === 0) return 'No hay nada que agregar.';
  const photos = posts.reduce((sum, p) => sum + p.products.length, 0);
  const stories = posts.filter(p => p.format === 'historia').length;
  const days = new Set(posts.map(p => p.at.toISOString().slice(0, 10))).size;
  const parts = [`${posts.length - stories} publicación(es)`, `${stories} tanda(s) de historias`].filter(x => !x.startsWith('0 '));
  return `Se agregan ${photos} fotos en ${days} día(s) (${parts.join(' y ')}) para llegar a ${settings.photosPerDay} fotos por día, contando lo que ya tenías programado. Cada tanda es de una sola categoría.`;
}

export const ruleBrain: SocialBrain = {
  name: 'reglas',
  async plan({ slots, catalog, recent, settings, month }) {
    const picks = pickProducts(catalog, recent, slots.length, slots.map(s => s.count), month);
    const posts = picks.map((pick, i) => ({
      ...pick,
      at: slots[i].at,
      format: formatOf(slots[i], pick.products.length),
      reason: isSeasonal(pick.products[0]?.category || '', month) ? 'Es temporada: sale primero' : 'Lo que hace más tiempo no se publica'
    }));
    return { posts, summary: planSummary(posts, settings) };
  },
  write
};

const WEEKDAYS = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];
const hhmm = (at: Date, timeZone: string) => { const p = localParts(at, timeZone); return `${String(p.hour).padStart(2, '0')}:${String(p.minute).padStart(2, '0')}`; };

/** Lo que ve la IA: las tandas ya armadas (solo elige la categoría de cada una), las categorías y lo reciente. */
export function aiPlanRequest(input: PlanInput): AiPlanRequest {
  const { catalog, recent, recentThemes, slots, now, timeZone } = input;
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
    tandas: slots.map((s, i) => ({ n: i + 1, dia: s.day, semana: WEEKDAYS[new Date(s.day + 'T12:00:00Z').getUTCDay()], hora: hhmm(s.at, timeZone), donde: s.kind === 'story' ? 'historias' : 'publicación', fotos: s.count })),
    categorias: [...categories.entries()].map(([categoria, v]) => ({ categoria, ...v })),
    recientes: recentThemes.slice(0, 20).map(r => ({ dia: r.day, tema: r.theme })),
    pedido: String(input.request || '').trim().slice(0, 600)
  };
}

/**
 * Llena cada tanda con la categoría que eligió la IA: productos del Catálogo de esa categoría, lo que hace más tiempo no
 * sale y sin repetir en el plan. Si la categoría no existe o ya no le quedan productos, esa tanda se llena con reglas.
 */
export function resolveAiPlan(assignments: AiAssignment[], input: PlanInput): PlannedPost[] {
  const { catalog, recent, slots, month } = input;
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
  const used = new Set<string>();
  const out: PlannedPost[] = [];
  slots.forEach((slot, i) => {
    const chosen = assignments.find(a => Number(a.n) === i + 1);
    const group = chosen ? groups.get(plain(chosen.categoria)) : undefined;
    let theme = group ? titleCase(group.name) : '';
    let products = group ? group.items.filter(c => !used.has(productKey(c.name))).sort((a, b) => age(b) - age(a)).slice(0, slot.count) : [];
    let reason = String(chosen?.motivo || '').trim().slice(0, 240);
    if (products.length === 0) {
      const [pick] = pickProducts(catalog.filter(c => !used.has(productKey(c.name))), recent, 1, slot.count, month);
      if (!pick) return;
      theme = pick.theme;
      products = pick.products;
      reason = isSeasonal(products[0]?.category || '', month) ? 'Es temporada' : 'Lo que hace más tiempo no se publica';
    }
    products.forEach(p => used.add(productKey(p.name)));
    out.push({ theme, products, at: slot.at, format: formatOf(slot, products.length), reason });
  });
  return out;
}

export const aiBrain: SocialBrain = {
  name: 'ia',
  async plan(input) {
    try {
      const plan = await planWithAi(aiPlanRequest(input), input.profile);
      const posts = resolveAiPlan(plan.asignaciones, input);
      if (posts.length) return { posts, summary: [plan.resumen, planSummary(posts, input.settings)].filter(Boolean).join(' '), tasks: plan.tareas };
      console.warn('⚠️ La planificación de la IA no trajo publicaciones válidas; se usan las reglas');
    } catch (error: any) {
      console.warn('⚠️ La IA no pudo planificar; se usan las reglas:', error.message);
    }
    const fallback = await ruleBrain.plan(input);
    return { ...fallback, summary: `La IA no respondió, así que se eligió con reglas. ${fallback.summary}` };
  },
  write
};

let override: SocialBrain | null = null;

/** El cerebro que toca: "La IA elige" (o un pedido escrito por la dueña) planifica con IA; si no, con reglas. */
export const currentBrain = (settings?: PublishingSettings, request?: string) =>
  override || ((settings && settings.postsPerDay === 0) || String(request || '').trim() ? aiBrain : ruleBrain);

/** Fija un cerebro (lo usan las pruebas); null vuelve al de la configuración. */
export function useBrain(next: SocialBrain | null) {
  override = next;
}
