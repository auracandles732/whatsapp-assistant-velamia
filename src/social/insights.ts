import axios from 'axios';
import { supabase, tenantOp, tenantValue, tenantColumns, getPublishingTenants } from '../services/supabase';
import { publishingConnection, PublishingConnection } from '../services/metaChannels';
import { currentTenant, runWithTenant } from '../services/tenant';
import { SocialPost, PostChannel } from './posts';

/**
 * Resultados de cada publicación por red: me gusta, comentarios, visualizaciones, alcance, guardados y compartidos.
 * Se consultan cada hora durante 14 días. Las historias de Instagram solo dan datos mientras están activas (24 h):
 * se guardan en cada revisión y el último dato queda como el final. Si falta un permiso de Meta, se muestra en el CRM.
 */

const GRAPH_API = 'https://graph.facebook.com/v25.0';
const graph = axios.create({ timeout: 30_000 });
const TABLE = 'social_metrics';
const TRACK_DAYS = 14;
const STORY_HOURS = 24;
const CHECK_EVERY_MS = 60 * 60 * 1000;

export interface Metrics { likes: number | null; comments: number | null; views: number | null; reach: number | null; saves: number | null; shares: number | null }
const empty = (): Metrics => ({ likes: null, comments: null, views: null, reach: null, saves: null, shares: null });

// Último problema de permisos por empresa (se muestra en Resultados).
const problems = new Map<string, string>();
const tenantKey = () => currentTenant()?.businessId || 'velamia';
export const insightsProblem = () => problems.get(tenantKey()) || '';

const metaError = (error: any) => String(error?.response?.data?.error?.message || error?.message || error);
const isPermission = (error: any) => [10, 200, 190].includes(error?.response?.data?.error?.code) || /permission|insights/i.test(metaError(error));

/** Valor de una métrica en la respuesta de /insights (Meta la entrega en values[0].value o total_value.value). */
function valueOf(item: any): number | null {
  const v = item?.total_value?.value ?? item?.values?.[0]?.value;
  return typeof v === 'number' ? v : null;
}

/** Pide varias métricas juntas y, si Meta rechaza alguna, una por una (así una métrica no disponible no borra las demás). */
async function insights(id: string, metrics: string[], token: string, path = 'insights'): Promise<Record<string, number | null>> {
  const read = async (list: string[]) => {
    const { data } = await graph.get(`${GRAPH_API}/${id}/${path}`, { params: { metric: list.join(','), access_token: token } });
    return Object.fromEntries((data?.data || []).map((item: any) => [item.name, valueOf(item)]));
  };
  try {
    return await read(metrics);
  } catch (error: any) {
    if (isPermission(error) && /permission/i.test(metaError(error))) throw error;
    const out: Record<string, number | null> = {};
    for (const metric of metrics) {
      try {
        Object.assign(out, await read([metric]));
      } catch (inner: any) {
        if (isPermission(inner) && /permission/i.test(metaError(inner))) throw inner;
      }
    }
    return out;
  }
}

async function instagramMetrics(conn: PublishingConnection, mediaId: string, story: boolean): Promise<Metrics> {
  const m = empty();
  if (!story) {
    const { data } = await graph.get(`${GRAPH_API}/${mediaId}`, { params: { fields: 'like_count,comments_count', access_token: conn.pageToken } });
    m.likes = typeof data?.like_count === 'number' ? data.like_count : null;
    m.comments = typeof data?.comments_count === 'number' ? data.comments_count : null;
  }
  const values = await insights(mediaId, story ? ['reach', 'views', 'replies', 'shares'] : ['reach', 'views', 'saved', 'shares'], conn.pageToken);
  m.reach = values.reach ?? null;
  m.views = values.views ?? null;
  m.shares = values.shares ?? null;
  if (story) m.comments = values.replies ?? null;
  else m.saves = values.saved ?? null;
  return m;
}

async function facebookMetrics(conn: PublishingConnection, id: string): Promise<Metrics> {
  const m = empty();
  const { data } = await graph.get(`${GRAPH_API}/${id}`, {
    params: { fields: 'reactions.summary(total_count).limit(0),comments.summary(total_count).limit(0),shares', access_token: conn.pageToken }
  });
  m.likes = data?.reactions?.summary?.total_count ?? null;
  m.comments = data?.comments?.summary?.total_count ?? null;
  m.shares = data?.shares?.count ?? 0;
  const values = await insights(id, ['post_impressions_unique', 'post_impressions'], conn.pageToken).catch(error => {
    if (isPermission(error)) throw error;
    return {} as Record<string, number | null>;
  });
  m.reach = values.post_impressions_unique ?? null;
  m.views = values.post_impressions ?? null;
  return m;
}

/** Revisa los resultados de lo publicado en los últimos 14 días de la empresa actual. */
export async function collectMetricsForCurrent(now = new Date()) {
  const conn = await publishingConnection();
  if (!conn) return 0;
  const since = new Date(now.getTime() - TRACK_DAYS * 86_400_000).toISOString();
  const { data, error } = await supabase.from('social_posts').select('*')
    .filter('business_id', tenantOp(), tenantValue())
    .in('status', ['published', 'partial'])
    .gte('published_at', since);
  if (error) throw new Error(`Error leyendo publicaciones: ${error.message}`);
  let saved = 0;
  let problem = '';
  for (const post of (data || []) as SocialPost[]) {
    for (const [channel, result] of Object.entries(post.results || {}) as [PostChannel, any][]) {
      if (!result?.id || result.error) continue;
      const story = channel === 'instagram_story';
      if (story && post.published_at && now.getTime() - new Date(post.published_at).getTime() > STORY_HOURS * 3_600_000) continue;
      try {
        const metrics = channel === 'facebook' ? await facebookMetrics(conn, result.id) : await instagramMetrics(conn, result.id, story);
        const { error: upsertError } = await supabase.from(TABLE).upsert({
          ...tenantColumns(), post_id: post.id, channel, media_id: String(result.id), ...metrics, collected_at: now.toISOString()
        }, { onConflict: 'post_id,channel' });
        if (upsertError) throw new Error(upsertError.message);
        saved++;
      } catch (err: any) {
        if (isPermission(err)) {
          problem = channel === 'facebook'
            ? 'Para ver los resultados de Facebook falta el permiso read_insights: agrégalo en la App de Meta y vuelve a conectar con Facebook.'
            : 'Para ver los resultados de Instagram falta el permiso instagram_manage_insights: agrégalo en la App de Meta y vuelve a conectar con Facebook.';
        } else {
          console.warn(`⚠️ Resultados de ${channel} (${post.id}):`, metaError(err));
        }
      }
    }
  }
  if (problem) problems.set(tenantKey(), problem); else problems.delete(tenantKey());
  return saved;
}

/** Publicaciones de los últimos días con sus resultados por red, para la pestaña Resultados. */
export async function listResults(days = 30) {
  const since = new Date(Date.now() - days * 86_400_000).toISOString();
  const [posts, metrics] = await Promise.all([
    supabase.from('social_posts').select('*').filter('business_id', tenantOp(), tenantValue())
      .in('status', ['published', 'partial']).gte('published_at', since).order('published_at', { ascending: false }),
    supabase.from(TABLE).select('*').filter('business_id', tenantOp(), tenantValue()).gte('collected_at', since)
  ]);
  if (posts.error) throw new Error(`Error leyendo publicaciones: ${posts.error.message}`);
  if (metrics.error) throw new Error(`Error leyendo resultados: ${metrics.error.message}`);
  const byPost = new Map<string, any[]>();
  for (const row of metrics.data || []) byPost.set(row.post_id, [...(byPost.get(row.post_id) || []), row]);
  return {
    problem: insightsProblem(),
    posts: (posts.data || []).map((post: any) => ({ ...post, metrics: byPost.get(post.id) || [] }))
  };
}

let running = false;

/** VELAMIA y cada empresa con el servicio, por separado. */
export async function runMetrics(now = new Date()) {
  if (running) return;
  running = true;
  try {
    await runWithTenant(undefined, () => collectMetricsForCurrent(now)).catch(error => console.error('❌ Resultados de VELAMIA:', error.message));
    for (const tenant of await getPublishingTenants().catch(() => [])) {
      await runWithTenant(tenant, () => collectMetricsForCurrent(now)).catch(error => console.error(`❌ Resultados de ${tenant.name}:`, error.message));
    }
  } finally {
    running = false;
  }
}

export function startMetricsCollector() {
  setTimeout(() => { void runMetrics(); }, 3 * 60 * 1000);
  setInterval(() => { void runMetrics(); }, CHECK_EVERY_MS);
  console.log('📊 Resultados de redes: revisión cada hora');
}
