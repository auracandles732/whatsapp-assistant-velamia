import { getAllProducts, getConfig, setConfig } from '../services/supabase';
import { profile } from '../config/businessProfile';
import { currentBrain, PostFormat, PlannedPost } from './brain';
import {
  SocialPost, PublishingSettings, PostChannel, PostProduct, PostMedia, DEFAULT_SETTINGS, getSavedSettings, daySlots,
  publishingDays, listPosts, localDay, localParts, recentActivity, insertPosts, fallbackCaption, toPostProduct, withLibraryMedia,
  LibraryItem, postsBetween, postFingerprint, isStoryChannel, pendingDrafts, getPost, updatePost, deletePost, plain, titleCase, pickProducts,
  CatalogItem, zonedTime, catalogPhotosOf, MAX_CAROUSEL, MIN_SET
} from './posts';
import { productKey } from '../services/openai';
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
function channelsFor(format: PostFormat, settings: PublishingSettings, _byAi: boolean): PostChannel[] {
  // Historias en Instagram y/o Facebook (las que estén elegidas); lo demás, en el feed y la página.
  const stories = settings.channels.filter(isStoryChannel);
  if (format === 'historia') return stories.length ? stories : ['instagram_story'];
  const feed = settings.channels.filter(c => !isStoryChannel(c));
  return feed.length ? feed : settings.channels;
}

/** Arma lo que se publica: el video (reel o historia) o las fotos del Catálogo con lo suyo de la biblioteca. */
function buildMedia(pick: PlannedPost, library: LibraryItem[], usedAssets: Set<string>) {
  const products = pick.products.map(toPostProduct);
  if (pick.library?.length) {
    pick.library.forEach(a => usedAssets.add(a.id));
    return { products, media: pick.library.map(a => ({ type: a.kind, url: a.url, asset_id: a.id })) as PostMedia[], items: pick.library.map(a => ({ asset: a.id })) };
  }
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

/** Minutos del día (hora local) de una fecha. */
const minutesOf = (at: Date, timeZone: string) => { const p = localParts(at, timeZone); return p.hour * 60 + p.minute; };

/**
 * Una hora libre ese día (a una hora o más de lo ya programado y de lo planificado), entre las candidatas en orden, de
 * 8:00 a 22:00 y al menos una hora después de ahora.
 */
function freeTimeOn(day: string, candidates: number[], planned: PlannedPost[], live: Pick<SocialPost, 'scheduled_at'>[], now: Date, timeZone: string): Date | undefined {
  const taken = [
    ...planned.filter(p => localDay(p.at, timeZone) === day).map(p => minutesOf(p.at, timeZone)),
    ...live.filter(p => localDay(p.scheduled_at, timeZone) === day).map(p => minutesOf(new Date(p.scheduled_at), timeZone))
  ];
  const [y, m, d] = day.split('-').map(Number);
  return candidates
    .filter(t => t >= 8 * 60 && t <= 22 * 60 && !taken.some(x => Math.abs(x - t) < 60))
    .map(t => zonedTime(y, m, d, Math.floor(t / 60), t % 60, timeZone))
    .find(date => date.getTime() >= now.getTime() + 60 * 60 * 1000);
}

/** Lo mismo subido dos veces (mismo nombre de archivo y tamaño) cuenta como un solo archivo. */
const twinKey = (a: LibraryItem) => (a.title && a.width && a.height ? `${a.kind}|${plain(a.title)}|${a.width}x${a.height}` : a.id);
/** Lo que salió hace menos de esto no vuelve a salir todavía. */
const LIBRARY_REST_DAYS = 7;

/**
 * Fotos y videos de la biblioteca en la planificación: cada día de publicación lleva una tanda propia ("De tu biblioteca
 * por día", aparte de la meta de fotos del Catálogo) con lo que menos ha salido: primero lo que nunca se publicó y luego
 * lo que hace más tiempo no sale. Con solo historias la tanda empieza con un video; con publicaciones en el feed los
 * videos salen como reels (libraryReels) y la tanda lleva fotos. Nada se repite mientras esté programado ni en los 7 días
 * después de salir, y lo subido dos veces cuenta una sola vez. Un día que ya tiene algo de la biblioteca no lleva otra.
 * Antes solo entraban las fotos marcadas con el nombre exacto de un producto: la biblioteca casi nunca se usaba.
 */
export function libraryTandas(
  planned: PlannedPost[], library: LibraryItem[], posts: Pick<SocialPost, 'scheduled_at' | 'status' | 'media'>[],
  settings: PublishingSettings, now: Date, timeZone: string, publishDays: string[]
): PlannedPost[] {
  const goal = Math.min(MAX_CAROUSEL, Math.max(0, Math.round(settings.libraryPerDay || 0)));
  const storiesOn = settings.channels.some(isStoryChannel);
  const feedOn = settings.channels.some(c => !isStoryChannel(c));
  if (!goal || library.length === 0 || (!storiesOn && !feedOn)) return [];
  const live = posts.filter(p => p.status !== 'failed' && p.status !== 'cancelled');
  // Cuándo salió (o saldrá) cada archivo por última vez.
  const lastUse = new Map<string, number>();
  for (const post of live) {
    const at = new Date(post.scheduled_at).getTime();
    for (const m of post.media || []) if (m.asset_id) lastUse.set(m.asset_id, Math.max(lastUse.get(m.asset_id) || 0, at));
  }
  const usedAt = (a: LibraryItem) => lastUse.get(a.id) ?? (a.last_used_at ? new Date(a.last_used_at).getTime() || 0 : 0);
  const resting = new Set<string>();
  const restSince = now.getTime() - LIBRARY_REST_DAYS * 86_400_000;
  for (const a of library) if (lastUse.has(a.id) && lastUse.get(a.id)! > restSince) resting.add(twinKey(a));
  const order = (a: LibraryItem, b: LibraryItem) =>
    usedAt(a) - usedAt(b) || (a.used_count || 0) - (b.used_count || 0) || String(a.created_at || '').localeCompare(String(b.created_at || ''));
  const pool = (kind: LibraryItem['kind']) => library.filter(a => a.kind === kind && a.url && !resting.has(twinKey(a))).sort(order);
  const photos = pool('image');
  const videos = pool('video');
  const chosen = new Set<string>();
  const take = (list: LibraryItem[]) => {
    while (list.length) {
      const asset = list.shift()!;
      if (chosen.has(twinKey(asset))) continue;
      chosen.add(twinKey(asset));
      return asset;
    }
    return null;
  };
  const [hh, mm] = settings.hour.split(':').map(Number);
  const h = hh * 60 + mm;
  const candidates = [h + 60, h - 60, h + 120, h - 120, h + 180, h - 180, h + 240, 10 * 60, 12 * 60, 15 * 60, 18 * 60, 20 * 60];
  const out: PlannedPost[] = [];
  for (const day of [...new Set(publishDays)].sort()) {
    const hasLibrary = live.some(p => localDay(p.scheduled_at, timeZone) === day && (p.media || []).some(m => m.asset_id))
      || planned.some(p => localDay(p.at, timeZone) === day && (p.library?.length || p.video));
    if (hasLibrary) continue;
    const at = freeTimeOn(day, candidates, [...planned, ...out], live, now, timeZone);
    if (!at) continue;
    const items: LibraryItem[] = [];
    // Solo historias: la tanda abre con un video (con publicaciones, los videos van como reels).
    if (!feedOn) { const video = take(videos); if (video) items.push(video); }
    while (items.length < goal) { const photo = take(photos); if (!photo) break; items.push(photo); }
    if (!feedOn) while (items.length < goal) { const video = take(videos); if (!video) break; items.push(video); }
    // Nunca una tanda de 1 o 2 sueltas para completar: si ya no alcanza, se deja para cuando suban más.
    if (items.length === 0 || items.length < Math.min(MIN_SET, goal)) break;
    const fresh = items.some(a => !usedAt(a) && !(a.used_count || 0));
    out.push({
      theme: 'Nuestros productos',
      products: [],
      at,
      format: storiesOn ? 'historia' : items.length > 1 ? 'carrusel' : items[0].kind === 'video' ? 'reel' : 'foto',
      reason: fresh ? 'Fotos y videos de tu biblioteca que todavía no se publican' : 'Lo de tu biblioteca que hace más tiempo no sale',
      library: items
    });
  }
  return out;
}

/**
 * Videos de la biblioteca en la planificación: un reel por día de publicación con el video que menos ha salido (si ese
 * día no lleva ya un video), a una hora libre. Si el video tiene marcado su producto, el reel habla de ese producto; si
 * no, de la marca. Antes solo entraban los videos marcados con el nombre exacto de un producto, dentro de un carrusel,
 * y los demás había que programarlos a mano.
 */
export function libraryReels(
  planned: PlannedPost[], library: LibraryItem[], existing: Pick<SocialPost, 'scheduled_at' | 'status' | 'media'>[],
  catalog: CatalogItem[], settings: PublishingSettings, now: Date, timeZone: string, publishDays: string[]
): PlannedPost[] {
  if (!settings.channels.some(c => !isStoryChannel(c))) return [];
  const live = existing.filter(p => p.status !== 'failed' && p.status !== 'cancelled');
  const busy = new Set(live.flatMap(p => (p.media || []).map(m => m.asset_id).filter(Boolean) as string[]));
  const videos = library
    .filter(a => a.kind === 'video' && !busy.has(a.id))
    .sort((a, b) => (a.used_count || 0) - (b.used_count || 0) || String(a.last_used_at || '').localeCompare(String(b.last_used_at || '')));
  if (videos.length === 0) return [];
  const withVideo = new Set(live.filter(p => (p.media || []).some(m => m.type === 'video')).map(p => localDay(p.scheduled_at, timeZone)));
  const days = [...new Set(publishDays)].filter(day => !withVideo.has(day)).sort();
  const [hh, mm] = settings.hour.split(':').map(Number);
  const reels: PlannedPost[] = [];
  for (const day of days) {
    if (videos.length === 0) break;
    // Dos horas antes de la hora elegida (a las 17:00 si se publica a las 19:00), lejos de las demás tandas del día.
    const candidates = [hh * 60 + mm - 120, hh * 60 + mm - 60, hh * 60 + mm + 60, hh * 60 + mm - 180, hh * 60 + mm - 240, 12 * 60, 10 * 60];
    const at = freeTimeOn(day, candidates, [...planned, ...reels], live, now, timeZone);
    if (!at) continue;
    const video = videos.shift()!;
    const product = video.product_name ? catalog.find(c => productKey(c.name) === productKey(String(video.product_name))) : undefined;
    const theme = product?.category ? titleCase(String(product.category)) : String(video.title || '').trim() || 'Video de la marca';
    reels.push({
      theme,
      products: product ? [product] : [],
      at,
      format: 'reel',
      reason: (video.used_count || 0) > 0 ? 'El video de tu biblioteca que menos ha salido' : 'Video de tu biblioteca que todavía no se publica',
      video
    });
  }
  return reels;
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
  // Dos meses hacia atrás: así se sabe qué fotos y videos de la biblioteca hace más tiempo que no salen.
  const history = await listPosts(new Date(now.getTime() - 60 * 86_400_000).toISOString(), new Date(now.getTime() + (days + 1) * 86_400_000).toISOString());
  const existing = history.filter(post => new Date(post.scheduled_at).getTime() >= now.getTime() - 86_400_000);
  const used = existing.filter(post => post.status !== 'failed').map(post => {
    const at = localParts(new Date(post.scheduled_at), tz);
    return { day: localDay(post.scheduled_at, tz), minutes: at.hour * 60 + at.minute, photos: catalogPhotosOf(post) };
  });
  const slots = daySlots(settings, allDays, used, now, tz);
  const full = `Los próximos días ya tienen sus ${settings.photosPerDay} fotos (o no queda hora libre hoy).`;

  // Sin la migración 025 no hay biblioteca: se publica solo con las fotos del Catálogo.
  const [catalog, recent, library] = await Promise.all([getAllProducts(), recentActivity(tz), listAssets().catch(() => [])]);
  // Con las fotos del día completas igual pueden entrar los videos de la biblioteca (reels).
  const plan = slots.length
    ? await brain.plan({
      slots, catalog, recent: recent.names, recentThemes: recent.themes, library,
      settings, month: localParts(now, tz).month, now, timeZone: tz, profile: p, request
    })
    : { posts: [] as PlannedPost[], summary: full, tasks: [] as string[] };
  // La biblioteca tiene su propia tanda cada día (fotos y, con solo historias, un video), aparte de las fotos del Catálogo.
  const fromLibrary = libraryTandas(plan.posts, library, history, settings, now, tz, allDays);
  const inTandas = new Set(fromLibrary.flatMap(t => t.library!.map(a => a.id)));
  // Con publicaciones en el feed, los videos salen además como reels (uno por día).
  const reels = libraryReels([...plan.posts, ...fromLibrary], library.filter(a => !inTandas.has(a.id)), existing, catalog, settings, now, tz, allDays);
  const extras = [...fromLibrary, ...reels];
  if (extras.length) {
    plan.posts.push(...extras);
    plan.posts.sort((a, b) => a.at.getTime() - b.at.getTime());
    const notes = [
      fromLibrary.length && `${fromLibrary.length} tanda(s) con ${fromLibrary.reduce((n, t) => n + t.library!.length, 0)} fotos y videos de tu biblioteca`,
      reels.length && `${reels.length} reel(s) con videos de tu biblioteca`
    ].filter(Boolean);
    const base = slots.length ? plan.summary : '';
    plan.summary = [base, `Además, ${notes.join(' y ')} (primero lo que nunca salió y lo que hace más tiempo no sale).`].filter(Boolean).join(' ');
  }
  if (plan.posts.length === 0) {
    const noLibrary = settings.libraryPerDay > 0 && library.length > 0 ? ' Lo de tu biblioteca ya está programado esos días o salió hace menos de una semana.' : '';
    return empty((slots.length ? plan.summary || 'No hay productos con foto para publicar.' : full) + noLibrary);
  }

  // Lo de la biblioteca ya elegido no se repite dentro de un carrusel de la misma planificación.
  const usedAssets = new Set<string>([...inTandas, ...reels.map(r => r.video!.id)]);
  const built = plan.posts.map(pick => buildMedia(pick, library, usedAssets));
  const byAi = brain.name === 'ia';
  const channels = plan.posts.map(pick => channelsFor(pick.format, settings, byAi));
  // Las historias no llevan texto: solo se escribe para lo que va al feed o a Facebook.
  const needsText = plan.posts.map((_, i) => channels[i].some(c => !isStoryChannel(c)));
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

// ---------- Planificación para aprobar ----------

const REPORT_KEY = 'social_plan_report';

/** La última planificación que armó el agente para aprobar: resumen, tareas y el porqué de cada tanda. */
export interface PlanReport { at: string; mode: string; summary: string; tasks: string[]; reasons: Record<string, string> }

export async function lastPlanReport(): Promise<PlanReport | null> {
  try {
    const raw = await getConfig(REPORT_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

/**
 * Arma la planificación (las tandas que faltan para la meta de cada día) y la guarda "por aprobar": la dueña la revisa en
 * el CRM (o en el PDF) y la acepta o la rechaza. Nada sale hasta que la acepta. Con replace se descarta la propuesta
 * anterior sin aprobar. No manda mensajes.
 */
export async function proposePlan(now = new Date(), settingsParam?: PublishingSettings, options: { days?: number; replace?: boolean; request?: string } = {}): Promise<{ created: number; summary: string }> {
  const settings = settingsParam || (await getSavedSettings()) || DEFAULT_SETTINGS;
  if (options.replace) for (const draft of await pendingDrafts(now)) await deletePost(draft.id);
  const days = options.days || (settings.planMode === 'diario' ? 2 : 8);
  const proposal = await draftUpcomingPosts(now, days, settings, String(options.request || '').slice(0, 600));
  if (proposal.drafts.length === 0) return { created: 0, summary: proposal.summary };
  const withMedia = proposal.drafts.some(d => d.media.length > 0);
  const posts = await insertPosts(proposal.drafts.map(d => ({
    scheduled_at: d.scheduled_at, status: 'draft' as const, channels: d.channels, caption: d.caption, products: d.products,
    ...(withMedia ? { media: d.media } : {}), theme: d.theme, results: {}, error: null
  })));
  const reasons: Record<string, string> = {};
  posts.forEach((post, i) => { reasons[post.id] = proposal.drafts[i]?.reason || ''; });
  const previous = options.replace ? null : await lastPlanReport();
  const report: PlanReport = { at: now.toISOString(), mode: settings.planMode, summary: proposal.summary, tasks: proposal.tasks, reasons: { ...(previous?.reasons || {}), ...reasons } };
  await setConfig(REPORT_KEY, JSON.stringify(report));
  return { created: posts.length, summary: proposal.summary };
}

/** Lo que espera aprobación, con el porqué de cada tanda. */
export async function pendingPlan(now = new Date()) {
  const [posts, report] = await Promise.all([pendingDrafts(now), lastPlanReport()]);
  return { posts: posts.map(p => ({ ...p, reason: report?.reasons?.[p.id] || '' })), summary: report?.summary || '', tasks: report?.tasks || [], at: report?.at || null };
}

/** Aprueba la planificación (toda o las tandas indicadas): desde ahí sale sola a su hora. */
export async function approvePlan(ids?: string[], now = new Date()): Promise<number> {
  let approved = 0;
  const assets: string[] = [];
  for (const post of await pendingDrafts(now)) {
    if (ids && !ids.includes(post.id)) continue;
    if (await updatePost(post.id, { status: 'approved', error: null }, ['draft'])) {
      approved++;
      assets.push(...(post.media || []).map(m => m.asset_id).filter(Boolean) as string[]);
    }
  }
  // Lo aprobado de la biblioteca cuenta como usado: la próxima planificación empieza por otras fotos y videos.
  if (assets.length) await markAssetsUsed([...new Set(assets)]).catch(() => {});
  return approved;
}

/** Rechaza la planificación (toda o las tandas indicadas): se descarta y no se publica nada de eso. */
export async function rejectPlan(ids?: string[], now = new Date()): Promise<number> {
  let rejected = 0;
  for (const post of await pendingDrafts(now)) {
    if (ids && !ids.includes(post.id)) continue;
    await deletePost(post.id);
    rejected++;
  }
  return rejected;
}

/**
 * Cambia las fotos de una tanda: otras de la misma categoría o de la categoría que se elija, sin repetir lo que ya sale
 * en los próximos días. La tanda mantiene su hora, su lugar y su cantidad de fotos.
 */
export async function swapPost(id: string, category = '', now = new Date()): Promise<SocialPost> {
  const post = await getPost(id);
  if (!post || !['draft', 'approved'].includes(post.status)) throw new Error('Esa tanda ya no se puede cambiar');
  const catalog = (await getAllProducts()).filter((c: any) => c.image_url);
  const wanted = plain(category || post.theme);
  const upcoming = await listPosts(now.toISOString(), new Date(now.getTime() + 15 * 86_400_000).toISOString());
  const taken = new Set(upcoming.flatMap(p => p.products.map(x => plain(x.name))));
  const current = new Set(post.products.map(x => plain(x.name)));
  const count = Math.max(1, post.products.length);
  const pool = catalog.filter((c: any) => plain(c.category) === wanted);
  if (pool.length === 0) throw new Error('Esa categoría no tiene productos con foto');
  const recent = (await recentActivity()).names;
  // Primero lo que no sale en ninguna tanda; luego lo que no está en esta; y solo si no alcanza, lo que ya tenía. Siempre
  // con la misma cantidad de fotos (dentro de cada grupo, lo que hace más tiempo no sale).
  const month = localParts(now, profile().business.timezone).month;
  const oldestFirst = (list: any[]) => (list.length ? pickProducts(list, recent, 1, list.length, month)[0]?.products || [] : []);
  const tiers = [
    pool.filter((c: any) => !taken.has(plain(c.name))),
    pool.filter((c: any) => !current.has(plain(c.name))),
    pool
  ];
  const seen = new Set<string>();
  const chosen = tiers.flatMap(oldestFirst).filter((c: any) => !seen.has(plain(c.name)) && seen.add(plain(c.name))).slice(0, count);
  if (chosen.length === 0) throw new Error('No hay otras fotos de esa categoría');
  const pick = { products: chosen };
  const products = pick.products.map(toPostProduct);
  const needsText = post.channels.some(c => !isStoryChannel(c));
  const caption = needsText ? fallbackCaption({ theme: titleCase(pick.products[0]?.category || category || post.theme), products }) : '';
  const updated = await updatePost(id, { products, media: [], theme: titleCase(String(pick.products[0]?.category || post.theme)), ...(needsText ? { caption } : {}) }, ['draft', 'approved']);
  if (!updated) throw new Error('Esa tanda cambió mientras tanto: recarga');
  return updated;
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
