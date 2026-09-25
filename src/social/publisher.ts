import axios from 'axios';
import { publishingConnection, tokenInfo, PublishingConnection, PUBLISH_SCOPES } from '../services/metaChannels';
import { instagramReadyUrl, ImageKind } from './images';
import { SocialPost, PostChannel, PostStatus, PostMedia, duePosts, stuckPosts, updatePost, getSavedSettings, scheduleDrafts } from './posts';
import { planUpcomingPosts } from './planner';
import { getPublishingTenants } from '../services/supabase';
import { runWithTenant } from '../services/tenant';

/**
 * Publica en Instagram (publicación o historia) y en la página de Facebook. Cada red se intenta por separado:
 * si una falla, las otras igual se publican y la publicación queda "parcial" con el motivo a la vista en el CRM.
 */

const GRAPH_API = 'https://graph.facebook.com/v25.0';
const graph = axios.create({ timeout: 60_000 });
const metaError = (error: any) => String(error?.response?.data?.error?.message || error?.message || error);

// Instagram procesa la foto o el video antes de dejar publicarlo: se consulta hasta que esté listo.
const READY_CHECKS = 10;
// Un video tarda más: hasta ~3 minutos con la espera normal de 3 s.
const VIDEO_CHECKS = 60;
const READY_WAIT_MS = 3000;
const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

export type ChannelResult = { id?: string; permalink?: string; error?: string };

/** Lo que se publica: las fotos y videos de la biblioteca elegidos o, si no hay, las fotos de los productos. */
export function mediaOf(post: SocialPost): PostMedia[] {
  if (post.media && post.media.length > 0) return post.media.slice(0, 10);
  return post.products.slice(0, 10).map(p => ({ type: 'image' as const, url: p.image_url }));
}

async function waitUntilReady(containerId: string, token: string, waitMs: number, checks = READY_CHECKS) {
  for (let i = 0; i < checks; i++) {
    const { data } = await graph.get(`${GRAPH_API}/${containerId}`, { params: { fields: 'status_code', access_token: token } });
    if (data?.status_code === 'FINISHED') return;
    if (data?.status_code === 'ERROR' || data?.status_code === 'EXPIRED') throw new Error('Instagram no pudo procesar el archivo (revisa que el video sea MP4 o MOV)');
    await wait(waitMs);
  }
  throw new Error('Instagram tardó demasiado en procesar el archivo');
}

async function publishContainer(conn: PublishingConnection, containerId: string, waitMs: number, checks = READY_CHECKS): Promise<ChannelResult> {
  await waitUntilReady(containerId, conn.pageToken, waitMs, checks);
  const { data } = await graph.post(`${GRAPH_API}/${conn.instagramId}/media_publish`, { creation_id: containerId }, { params: { access_token: conn.pageToken } });
  const id = String(data?.id || '');
  const permalink = await graph.get(`${GRAPH_API}/${id}`, { params: { fields: 'permalink', access_token: conn.pageToken } })
    .then(r => String(r.data?.permalink || '')).catch(() => '');
  return { id, ...(permalink ? { permalink } : {}) };
}

interface PublishOptions {
  waitMs: number;
  /** Arma cada foto para Instagram (publicación 4:5 o historia 9:16, sin recortarla) y devuelve su dirección. */
  prepareImage: (url: string, kind: ImageKind) => Promise<string>;
}

/** Publicación de Instagram: una foto, un video (va como reel) o un carrusel que puede mezclar fotos y videos. */
async function instagramFeed(conn: PublishingConnection, post: SocialPost, { waitMs, prepareImage }: PublishOptions): Promise<ChannelResult> {
  const items = mediaOf(post);
  const create = (body: Record<string, unknown>) => graph.post(`${GRAPH_API}/${conn.instagramId}/media`, body, { params: { access_token: conn.pageToken } }).then(r => String(r.data.id));
  if (items.length === 1) {
    const [item] = items;
    if (item.type === 'video') {
      return publishContainer(conn, await create({ media_type: 'REELS', video_url: item.url, caption: post.caption, share_to_feed: true }), waitMs, VIDEO_CHECKS);
    }
    return publishContainer(conn, await create({ image_url: await prepareImage(item.url, 'feed'), caption: post.caption }), waitMs);
  }
  const children: { id: string; video: boolean }[] = [];
  for (const item of items) {
    const video = item.type === 'video';
    const id = video
      ? await create({ media_type: 'VIDEO', video_url: item.url, is_carousel_item: true })
      : await create({ image_url: await prepareImage(item.url, 'feed'), is_carousel_item: true });
    children.push({ id, video });
  }
  for (const child of children) await waitUntilReady(child.id, conn.pageToken, waitMs, child.video ? VIDEO_CHECKS : READY_CHECKS);
  return publishContainer(conn, await create({ media_type: 'CAROUSEL', children: children.map(c => c.id).join(','), caption: post.caption }), waitMs);
}

/** Historia de Instagram: la primera foto (armada en 9:16) o el primer video. */
async function instagramStory(conn: PublishingConnection, post: SocialPost, { waitMs, prepareImage }: PublishOptions): Promise<ChannelResult> {
  const [item] = mediaOf(post);
  const body = item.type === 'video'
    ? { media_type: 'STORIES', video_url: item.url }
    : { media_type: 'STORIES', image_url: await prepareImage(item.url, 'story') };
  const { data } = await graph.post(`${GRAPH_API}/${conn.instagramId}/media`, body, { params: { access_token: conn.pageToken } });
  return publishContainer(conn, String(data.id), waitMs, item.type === 'video' ? VIDEO_CHECKS : READY_CHECKS);
}

/** Página de Facebook: un video (si la publicación lleva uno) o una o varias fotos originales. */
async function facebookPage(conn: PublishingConnection, post: SocialPost): Promise<ChannelResult> {
  const params = { access_token: conn.pageToken };
  const link = (id: string) => `https://www.facebook.com/${id}`;
  const items = mediaOf(post);
  const video = items.find(item => item.type === 'video');
  if (video) {
    const { data } = await graph.post(`${GRAPH_API}/${conn.pageId}/videos`, { file_url: video.url, description: post.caption, published: true }, { params });
    const id = String(data.id);
    return { id, permalink: link(id) };
  }
  // Facebook acepta PNG: se usa la foto original.
  if (items.length === 1) {
    const { data } = await graph.post(`${GRAPH_API}/${conn.pageId}/photos`, { url: items[0].url, caption: post.caption, published: true }, { params });
    const id = String(data.post_id || data.id);
    return { id, permalink: link(id) };
  }
  const media: string[] = [];
  for (const item of items) {
    const { data } = await graph.post(`${GRAPH_API}/${conn.pageId}/photos`, { url: item.url, published: false }, { params });
    media.push(String(data.id));
  }
  const { data } = await graph.post(`${GRAPH_API}/${conn.pageId}/feed`, { message: post.caption, attached_media: media.map(id => ({ media_fbid: id })) }, { params });
  const id = String(data.id);
  return { id, permalink: link(id) };
}

type PublishOutcome = { status: PostStatus; results: Record<string, ChannelResult>; error: string | null };

/** Publica en cada red elegida con esa conexión y esos permisos. Resultado: todo bien = publicada; algo falló = parcial; nada = fallida. */
export async function publishToChannels(conn: PublishingConnection, scopes: string[], post: SocialPost, options: PublishOptions): Promise<PublishOutcome> {
  const results: Record<string, ChannelResult> = {};
  if (mediaOf(post).length === 0) return { status: 'failed', results, error: 'La publicación no tiene fotos ni videos.' };
  if (!post.channels.length) return { status: 'failed', results, error: 'Elige al menos una red donde publicar.' };

  for (const channel of post.channels) {
    try {
      if (channel !== 'facebook' && !conn.instagramId) throw new Error('La página no tiene una cuenta de Instagram profesional conectada.');
      const needed = channel === 'facebook' ? PUBLISH_SCOPES.facebook : PUBLISH_SCOPES.instagram;
      if (!scopes.includes(needed)) throw new Error(`Falta el permiso ${needed}: vuelve a conectar con Facebook y acéptalo.`);
      results[channel] = channel === 'instagram_feed' ? await instagramFeed(conn, post, options)
        : channel === 'instagram_story' ? await instagramStory(conn, post, options)
          : await facebookPage(conn, post);
    } catch (error: any) {
      results[channel] = { error: metaError(error) };
    }
  }

  const ok = post.channels.filter(c => !results[c]?.error);
  const status: PostStatus = ok.length === post.channels.length ? 'published' : ok.length > 0 ? 'partial' : 'failed';
  const failed = post.channels.filter(c => results[c]?.error).map(c => `${CHANNEL_NAMES[c]}: ${results[c].error}`);
  return { status, results, error: failed.length ? failed.join(' · ') : null };
}

/** Publica con la conexión de la empresa actual. */
export async function publishNow(post: SocialPost): Promise<PublishOutcome> {
  const conn = await publishingConnection();
  if (!conn) return { status: 'failed', results: {}, error: 'Facebook e Instagram no están conectados: conéctalos en Publicaciones.' };
  const scopes = (await tokenInfo(conn.pageToken)).scopes;
  return publishToChannels(conn, scopes, post, { waitMs: READY_WAIT_MS, prepareImage: instagramReadyUrl });
}

export const CHANNEL_NAMES: Record<PostChannel, string> = { instagram_feed: 'Instagram', instagram_story: 'Historia de Instagram', facebook: 'Facebook' };

/** Publica una publicación reservándola antes: si dos revisiones coinciden, solo una la publica. */
export async function claimAndPublish(post: SocialPost, from: PostStatus[] = ['approved']): Promise<SocialPost | null> {
  const claimed = await updatePost(post.id, { status: 'publishing' }, from);
  if (!claimed) return null;
  const outcome = await publishNow(claimed);
  return updatePost(post.id, {
    status: outcome.status,
    results: outcome.results,
    error: outcome.error,
    published_at: outcome.status === 'failed' ? null : new Date().toISOString()
  });
}

// ---------- Revisión automática ----------

// Una publicación que se pasó más de esto (servidor apagado, sin conexión) ya no sale sola: la empresa decide.
const LATE_LIMIT_MS = 6 * 60 * 60 * 1000;
const CHECK_EVERY_MS = 5 * 60 * 1000;
const PLAN_EVERY_MS = 60 * 60 * 1000;

async function runForCurrent(now: Date, plan: boolean) {
  let published = 0;
  // Lo que quedó "por revisar" de antes: ahora todo lo programado sale solo.
  await scheduleDrafts();
  for (const post of await stuckPosts(new Date(now.getTime() - 30 * 60 * 1000))) {
    await updatePost(post.id, { status: 'failed', error: 'Se interrumpió mientras se publicaba. Revisa en tus redes si salió y vuelve a intentarlo si hace falta.' }, ['publishing']);
  }
  for (const post of await duePosts(now)) {
    if (now.getTime() - new Date(post.scheduled_at).getTime() > LATE_LIMIT_MS) {
      await updatePost(post.id, { status: 'failed', error: 'No se publicó a su hora (el servidor no estaba disponible). Elige otra hora o publícala ahora.' }, ['approved']);
      continue;
    }
    const done = await claimAndPublish(post);
    if (done) {
      published++;
      console.log(`📣 Publicación ${done.status === 'published' ? 'publicada' : done.status}: ${done.theme}${done.error ? ` (${done.error})` : ''}`);
    }
  }
  if (plan) {
    const settings = await getSavedSettings();
    if (settings?.autoPlan) {
      const created = await planUpcomingPosts(now, 7, settings);
      if (created.length) console.log(`📣 ${created.length} publicación(es) programadas por la IA`);
    }
  }
  return published;
}

let running = false;
let lastPlan = 0;
let warnedMissingTable = false;

// Sin la migración 024 la tabla no existe: se avisa una vez en lugar de llenar el registro cada 5 minutos.
function reportError(who: string, error: any) {
  const message = String(error?.message || error);
  if (/social_posts|addons/.test(message) && /does not exist|schema cache|could not find/i.test(message)) {
    if (!warnedMissingTable) console.warn('⚠️ Publicaciones en redes apagadas: falta aplicar migrations/024_publicaciones_en_redes.sql en Supabase');
    warnedMissingTable = true;
    return;
  }
  console.error(`❌ Publicaciones de ${who}:`, message);
}

/** VELAMIA y cada empresa con el servicio de publicaciones, por separado: si una falla, las demás siguen. */
export async function runSocialPosts(now = new Date()) {
  if (running) return;
  running = true;
  const plan = now.getTime() - lastPlan >= PLAN_EVERY_MS;
  if (plan) lastPlan = now.getTime();
  try {
    await runWithTenant(undefined, () => runForCurrent(now, plan)).catch(error => reportError('VELAMIA', error));
    const tenants = await getPublishingTenants().catch(error => {
      reportError('las empresas', error);
      return [];
    });
    for (const tenant of tenants) {
      await runWithTenant(tenant, () => runForCurrent(now, plan)).catch(error => reportError(tenant.name, error));
    }
  } finally {
    running = false;
  }
}

export function startSocialPostsScheduler() {
  const tick = () => { void runSocialPosts(); };
  setTimeout(tick, 90 * 1000);
  setInterval(tick, CHECK_EVERY_MS);
  console.log('📣 Publicaciones en redes: revisión cada 5 min');
}
