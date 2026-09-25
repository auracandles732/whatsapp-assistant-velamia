import { getAllProducts, getConfig, setConfig } from '../services/supabase';
import { profile } from '../config/businessProfile';
import { currentBrain, PostFormat, PlannedPost } from './brain';
import {
  SocialPost, PublishingSettings, PostChannel, PostProduct, PostMedia, DEFAULT_SETTINGS, getSavedSettings, daySlots, photosOf,
  publishingDays, listPosts, localDay, localParts, recentActivity, insertPosts, fallbackCaption, toPostProduct, withLibraryMedia,
  LibraryItem, postsBetween, postFingerprint
} from './posts';
import { listAssets, markAssetsUsed } from './library';

/**
 * Prepara las publicaciones de los próximos días de publicación que todavía no tienen ninguna (un día cuya publicación
 * se eliminó vuelve a quedar libre). Qué mostrar, cuándo y en qué formato lo decide el cerebro del agente (brain.ts);
 * si la IA no escribe los textos, cada publicación lleva uno de respaldo. Los videos y fotos de la biblioteca que
 * muestran esos productos se suman al carrusel (hasta 10).
 *
 * draftUpcomingPosts solo propone (la planificación que se ve en el CRM); planUpcomingPosts además la programa (modo
 * automático).
 */

/** Una publicación propuesta, todavía sin guardar. */
export interface PlanDraft {
  scheduled_at: string;
  format: PostFormat;
  channels: PostChannel[];
  theme: string;
  /** Por qué la eligió el agente. */
  reason: string;
  caption: string;
  products: PostProduct[];
  /** Lo que se publica, en orden (vacío = las fotos de los productos). */
  media: PostMedia[];
  /** Lo mismo en el formato que acepta "Programar": fotos del Catálogo por nombre y archivos de la biblioteca por id. */
  items: ({ product: string } | { asset: string })[];
}

export interface PlanProposal { drafts: PlanDraft[]; summary: string; brain: string; tasks: string[]; days: number }

const SUMMARY_KEY = 'social_plan_summary';

/** Redes de cada formato: las historias van solo a historias; lo demás, a las redes elegidas (sin historias si la IA planifica aparte). */
function channelsFor(format: PostFormat, settings: PublishingSettings, byAi: boolean): PostChannel[] {
  if (format === 'historia') return ['instagram_story'];
  if (!byAi) return settings.channels;
  const feed = settings.channels.filter(c => c !== 'instagram_story');
  return feed.length ? feed : settings.channels;
}

/** Arma lo que se publica: el video (reel o historia) o las fotos del Catálogo con lo suyo de la biblioteca. */
function buildMedia(pick: PlannedPost, library: LibraryItem[], usedAssets: Set<string>) {
  const products = pick.products.map(toPostProduct);
  if (pick.video) {
    usedAssets.add(pick.video.id);
    return { products, media: [{ type: pick.video.kind, url: pick.video.url, asset_id: pick.video.id }] as PostMedia[], items: [{ asset: pick.video.id }] };
  }
  // Historias: cada foto sale como una historia, una detrás de otra.
  if (pick.format === 'historia') return { products, media: [] as PostMedia[], items: products.map(p => ({ product: p.name })) };
  const built = withLibraryMedia(products, library, usedAssets);
  if (!built.media.length) return { products: built.products, media: [] as PostMedia[], items: built.products.map(p => ({ product: p.name })) };
  let next = 0;
  const items = built.media.map(m => (m.asset_id ? { asset: m.asset_id } : { product: built.products[next++].name }));
  return { products: built.products, media: built.media, items };
}

export async function draftUpcomingPosts(now = new Date(), days = 7, settingsParam?: PublishingSettings, request = ''): Promise<PlanProposal> {
  const settings = settingsParam || (await getSavedSettings()) || DEFAULT_SETTINGS;
  const p = profile();
  const tz = p.business.timezone;
  const brain = currentBrain(settings, request);
  const empty = (summary: string) => ({ drafts: [], summary, brain: brain.name, tasks: [], days });

  const allDays = publishingDays(settings, now, days, tz);
  if (allDays.length === 0) return empty('No hay días de publicación elegidos.');
  // Lo ya programado (tuyo o de antes) cuenta para la meta del día y nunca se toca; lo que falló no salió, no cuenta.
  const existing = await listPosts(new Date(now.getTime() - 86_400_000).toISOString(), new Date(now.getTime() + (days + 1) * 86_400_000).toISOString());
  const used = existing.filter(post => post.status !== 'failed').map(post => {
    const at = localParts(new Date(post.scheduled_at), tz);
    return { day: localDay(post.scheduled_at, tz), minutes: at.hour * 60 + at.minute, photos: photosOf(post) };
  });
  const slots = daySlots(settings, allDays, used, now, tz);
  if (slots.length === 0) return empty(`Los próximos días ya tienen sus ${settings.photosPerDay} fotos (o no queda hora libre hoy).`);

  // Sin la migración 025 no hay biblioteca: se publica solo con las fotos del Catálogo.
  const [catalog, recent, library] = await Promise.all([getAllProducts(), recentActivity(tz), listAssets().catch(() => [])]);
  const plan = await brain.plan({
    slots, catalog, recent: recent.names, recentThemes: recent.themes, library,
    settings, month: localParts(now, tz).month, now, timeZone: tz, profile: p, request
  });
  if (plan.posts.length === 0) return empty(plan.summary || 'No hay productos con foto para publicar.');

  const usedAssets = new Set<string>();
  const built = plan.posts.map(pick => buildMedia(pick, library, usedAssets));
  const byAi = brain.name === 'ia';
  const channels = plan.posts.map(pick => channelsFor(pick.format, settings, byAi));
  // Las historias no llevan texto: solo se escribe para lo que va al feed o a Facebook.
  const needsText = plan.posts.map((_, i) => channels[i].some(c => c !== 'instagram_story'));
  let captions: string[] = [];
  try {
    const requests = plan.posts.map((pick, i) => ({ theme: pick.theme, products: built[i].products.map(c => ({ name: c.name, price: c.price })) })).filter((_, i) => needsText[i]);
    const written = requests.length ? await brain.write(requests, p) : [];
    let next = 0;
    captions = plan.posts.map((_, i) => (needsText[i] ? written[next++] || '' : ''));
  } catch (error: any) {
    console.warn('⚠️ La IA no escribió los textos de las publicaciones; se usa el texto de respaldo:', error.message);
  }

  return {
    summary: plan.summary,
    brain: brain.name,
    tasks: plan.tasks || [],
    days,
    drafts: plan.posts.map((pick, i) => ({
      scheduled_at: pick.at.toISOString(),
      format: pick.format,
      channels: channels[i],
      theme: pick.theme,
      reason: pick.reason,
      caption: needsText[i] ? captions[i] || fallbackCaption({ theme: pick.theme, products: built[i].products }, p) : '',
      products: built[i].products,
      media: built[i].media,
      items: built[i].items
    }))
  };
}

/** Guarda publicaciones ya armadas como programadas (salen solas a su hora) y anota la estrategia de la semana. */
export async function schedulePlan(all: Omit<PlanDraft, 'items' | 'format' | 'reason'>[], summary: string, tasks: string[] = []): Promise<SocialPost[]> {
  if (all.length === 0) return [];
  // Confirmar dos veces la misma propuesta (se cortó la respuesta y se volvió a tocar) no la duplica: lo que ya está
  // programado igual (misma hora, redes, texto y fotos) se salta.
  const times = all.map(d => new Date(d.scheduled_at).getTime());
  const already = await postsBetween(new Date(Math.min(...times)).toISOString(), new Date(Math.max(...times)).toISOString());
  const seen = new Set(already.map(postFingerprint));
  const drafts = all.filter(d => {
    const key = postFingerprint(d);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  if (drafts.length < all.length) console.log(`📣 ${all.length - drafts.length} publicación(es) ya estaban programadas: no se duplican`);
  if (drafts.length === 0) return [];
  // Todas las filas llevan las mismas columnas (media no acepta vacío): "media" va en todas o en ninguna.
  const withMedia = drafts.some(d => d.media.length > 0);
  const posts = await insertPosts(drafts.map(d => ({
    scheduled_at: d.scheduled_at,
    status: 'approved' as const,
    channels: d.channels,
    caption: d.caption,
    products: d.products,
    ...(withMedia ? { media: d.media } : {}),
    theme: d.theme,
    results: {},
    error: null
  })));
  const assets = drafts.flatMap(d => d.media.filter(m => m.asset_id).map(m => m.asset_id!));
  if (assets.length) await markAssetsUsed([...new Set(assets)]).catch(() => {});
  if (summary) await setConfig(SUMMARY_KEY, JSON.stringify({ at: new Date().toISOString(), summary, tasks: tasks.slice(0, 5) })).catch(() => {});
  return posts;
}

/** La estrategia de la última planificación (se muestra en el CRM). */
export async function lastPlanSummary(): Promise<{ at: string; summary: string; tasks?: string[] } | null> {
  try {
    const raw = await getConfig(SUMMARY_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

/** Prepara y programa de una vez (modo automático y "Programar" sin revisar). */
export async function planUpcomingPosts(now = new Date(), days = 7, settingsParam?: PublishingSettings): Promise<SocialPost[]> {
  const proposal = await draftUpcomingPosts(now, days, settingsParam);
  return schedulePlan(proposal.drafts, proposal.drafts.length ? proposal.summary : '', proposal.tasks);
}

/** Otro texto para una publicación (botón "Otro texto" del CRM). */
export async function rewriteCaption(post: Pick<SocialPost, 'theme' | 'products'>): Promise<string> {
  const [caption] = await currentBrain().write([{ theme: post.theme || 'Nuestros productos', products: post.products.map(x => ({ name: x.name, price: x.price })) }], profile());
  if (!caption) throw new Error('La IA no devolvió un texto');
  return caption;
}
