import axios from 'axios';
import { createHmac, randomBytes, timingSafeEqual } from 'crypto';
import { currentTenant, encryptSecret, decryptSecret, VELAMIA_ID } from './tenant';
import { maskPhone } from './privacy';
import { getConfig, setConfig } from './supabase';

/**
 * Instagram y Messenger (Facebook). Los chats se guardan igual que los de WhatsApp, pero en lugar del número llevan
 * "ig:<id>" o "fb:<id>": así el asistente, el CRM y los avisos los atienden por el mismo camino.
 */

const GRAPH_API = 'https://graph.facebook.com/v25.0';
const graph = axios.create({ timeout: 30_000 });

export type SocialChannel = 'instagram' | 'messenger';

const PREFIX: Record<SocialChannel, string> = { instagram: 'ig:', messenger: 'fb:' };
// Instagram corta los mensajes de más de 1000 caracteres y Messenger los de más de 2000.
const TEXT_LIMIT: Record<SocialChannel, number> = { instagram: 1000, messenger: 2000 };

export const socialAddress = (channel: SocialChannel, userId: string) => `${PREFIX[channel]}${userId}`;

export function parseSocialAddress(address: unknown): { channel: SocialChannel; userId: string } | null {
  const match = /^(ig|fb):(\d+)$/.exec(String(address ?? ''));
  if (!match) return null;
  return { channel: match[1] === 'ig' ? 'instagram' : 'messenger', userId: match[2] };
}

export const isSocialAddress = (address: unknown) => !!parseSocialAddress(address);

export const channelName = (channel: SocialChannel) => (channel === 'instagram' ? 'Instagram' : 'Messenger');

/** Cómo se muestra el contacto en los avisos: el número de WhatsApp o el canal. */
export function contactLabel(address: string): string {
  const social = parseSocialAddress(address);
  return social ? channelName(social.channel) : `+${address}`;
}

/** Parte un texto largo en mensajes que el canal acepte, cortando entre párrafos o líneas. */
export function splitForChannel(text: string, limit: number): string[] {
  const parts: string[] = [];
  let rest = text.trim();
  while (rest.length > limit) {
    const slice = rest.slice(0, limit);
    // Se prefiere cortar entre párrafos, luego entre líneas, oraciones y por último entre palabras.
    const cut = [slice.lastIndexOf('\n\n'), slice.lastIndexOf('\n'), slice.lastIndexOf('. ') + 1, slice.lastIndexOf(' ')].find(i => i > limit / 3);
    const at = cut ?? limit;
    parts.push(rest.slice(0, at).trim());
    rest = rest.slice(at).trim();
  }
  if (rest) parts.push(rest);
  return parts;
}

// ---------- Credenciales ----------

interface PageCredentials {
  pageId: string;
  pageToken: string;
  instagramId: string;
}

let cached: { key: string; creds: PageCredentials } | null = null;
let lastCredentialsError = '';

const metaError = (error: any) => String(error?.response?.data?.error?.message || error?.message || error);

/**
 * Página de Facebook (y su Instagram conectado) de VELAMIA. Primero la conexión hecha con el botón del CRM; si no hay,
 * META_PAGE_ID y META_PAGE_TOKEN de Render (clave de la página o de un usuario del sistema, que se cambia por la de la
 * página). Las demás empresas todavía no tienen estos canales: sin credenciales, nada cambia para ellas.
 */
export async function pageCredentials(): Promise<PageCredentials | null> {
  if (currentTenant()) return null;
  const stored = await storedCredentials();
  if (stored.creds) return stored.creds;
  // Al pegar en Render es fácil que se cuele un espacio o un salto de línea.
  const pageId = (process.env.META_PAGE_ID || '').trim();
  const token = (process.env.META_PAGE_TOKEN || '').trim();
  if (!pageId || !token) return null;
  const key = `${pageId}:${token}`;
  if (cached?.key === key) return cached.creds;

  // Solo una clave de usuario puede pedir la de la página; si ya es de la página, se usa tal cual.
  const exchanged = await graph.get(`${GRAPH_API}/${pageId}`, { params: { fields: 'access_token', access_token: token } })
    .then(r => String(r.data?.access_token || ''))
    .catch(() => '');
  const pageToken = exchanged || token;

  const info = await tokenInfo(pageToken);
  if (!info.valid) {
    lastCredentialsError = info.error || 'Meta dice que la clave no es válida';
    console.warn('⚠️ META_PAGE_TOKEN no es válida:', lastCredentialsError);
    return null;
  }

  // La cuenta de Instagram se lee de la página; si a la clave le falta ese permiso, sale de los permisos concedidos.
  let instagramId = (process.env.INSTAGRAM_ACCOUNT_ID || '').trim();
  if (!instagramId) {
    instagramId = await graph.get(`${GRAPH_API}/${pageId}`, { params: { fields: 'instagram_business_account', access_token: pageToken } })
      .then(r => String(r.data?.instagram_business_account?.id || ''))
      .catch(error => {
        lastCredentialsError = metaError(error);
        return info.instagramIds[0] || '';
      });
  }
  cached = { key, creds: { pageId, pageToken, instagramId } };
  return cached.creds;
}

// Lo que el asistente necesita para mensajes y comentarios en los dos canales. Responder en público un comentario de
// Facebook además pide pages_manage_engagement, que la App aún no tiene: sin él solo sale el mensaje privado.
export const REQUIRED_SCOPES = [
  'pages_messaging', 'pages_manage_metadata', 'pages_read_engagement',
  'instagram_basic', 'instagram_manage_messages', 'instagram_manage_comments'
];

/** Qué dice Meta de una clave: si sirve, cuándo vence, qué permisos tiene y a qué Instagram le dan acceso. */
export async function tokenInfo(token: string) {
  try {
    const { data } = await graph.get(`${GRAPH_API}/debug_token`, { params: { input_token: token, access_token: token } });
    const d = data?.data || {};
    const granular: { scope: string; target_ids?: string[] }[] = d.granular_scopes || [];
    return {
      valid: d.is_valid !== false,
      error: String(d.error?.message || ''),
      expiresAt: Number(d.expires_at || 0),
      dataAccessExpiresAt: Number(d.data_access_expires_at || 0),
      scopes: (d.scopes || []) as string[],
      instagramIds: granular.filter(g => g.scope.startsWith('instagram_')).flatMap(g => g.target_ids || [])
    };
  } catch (error: any) {
    return { valid: false, error: metaError(error), expiresAt: 0, dataAccessExpiresAt: 0, scopes: [] as string[], instagramIds: [] as string[] };
  }
}

async function requireCredentials(): Promise<PageCredentials> {
  const creds = await pageCredentials();
  if (!creds) throw new Error('Instagram y Messenger no están conectados (faltan META_PAGE_ID y META_PAGE_TOKEN)');
  return creds;
}

/** ¿El aviso de Meta es de nuestra página o de nuestro Instagram? Devuelve el canal, o null si no es nuestro. */
export async function channelForAccount(object: string, accountId: string): Promise<SocialChannel | null> {
  const creds = await pageCredentials();
  if (!creds || !accountId) return null;
  if (object === 'page' && accountId === creds.pageId) return 'messenger';
  if (object === 'instagram' && accountId === creds.instagramId) return 'instagram';
  return null;
}

// ---------- Envío ----------

// Ids de lo que envió el sistema: Meta lo devuelve como "eco" y no debe confundirse con un mensaje del equipo.
const sentByUs = new Set<string>();
function rememberSent(id: string | undefined) {
  if (!id) return;
  sentByUs.add(id);
  if (sentByUs.size > 2000) sentByUs.delete(sentByUs.values().next().value as string);
}
export const wasSentByUs = (id: string) => sentByUs.has(id);

async function postToPage(payload: Record<string, any>, label: string, to: string) {
  const creds = await requireCredentials();
  try {
    const { data } = await graph.post(`${GRAPH_API}/${creds.pageId}/messages`, payload, { params: { access_token: creds.pageToken } });
    rememberSent(data.message_id);
    console.log(`✅ ${label} enviado a ${maskPhone(to)}`);
    return data as { recipient_id?: string; message_id?: string };
  } catch (error: any) {
    console.error(`Error enviando ${label}:`, error.response?.data || error.message);
    throw error;
  }
}

async function sendToUser(to: string, message: Record<string, any>, label: string) {
  const target = parseSocialAddress(to);
  if (!target) throw new Error(`Contacto inválido: ${to}`);
  const payload: Record<string, any> = { recipient: { id: target.userId }, message };
  if (target.channel === 'messenger') payload.messaging_type = 'RESPONSE';
  const data = await postToPage(payload, `${label} (${channelName(target.channel)})`, to);
  // Misma forma que la respuesta de WhatsApp, para guardar el id igual en todos los canales.
  return { messages: [{ id: data.message_id }] };
}

export async function sendSocialText(to: string, text: string) {
  const target = parseSocialAddress(to);
  const parts = splitForChannel(text, TEXT_LIMIT[target?.channel || 'instagram']);
  let first: { messages: { id?: string }[] } | undefined;
  for (const part of parts) {
    const sent = await sendToUser(to, { text: part }, 'Mensaje');
    first = first || sent;
  }
  return first || { messages: [{ id: undefined }] };
}

/** Instagram y Messenger no llevan texto debajo de la foto: el nombre y el precio van en un mensaje aparte. */
export async function sendSocialImage(to: string, imageUrl: string, caption?: string) {
  const target = parseSocialAddress(to);
  const payload = target?.channel === 'messenger' ? { url: imageUrl, is_reusable: true } : { url: imageUrl };
  const sent = await sendToUser(to, { attachment: { type: 'image', payload } }, 'Imagen');
  if (caption) await sendSocialText(to, caption);
  return sent;
}

/** "Visto" y "escribiendo…". Es solo un detalle de naturalidad: nunca lanza error. */
export async function showSocialTyping(to: string) {
  const target = parseSocialAddress(to);
  if (!target) return;
  try {
    const creds = await requireCredentials();
    for (const action of ['mark_seen', 'typing_on']) {
      await graph.post(`${GRAPH_API}/${creds.pageId}/messages`, { recipient: { id: target.userId }, sender_action: action }, { params: { access_token: creds.pageToken } });
    }
  } catch (error: any) {
    console.warn('No se pudo mostrar "escribiendo…":', error.response?.data?.error?.message || error.message);
  }
}

// ---------- Comentarios ----------

/** Mensaje privado a quien comentó. Meta permite uno solo por comentario hasta que la persona conteste. */
export async function sendPrivateReply(channel: SocialChannel, commentId: string, text: string) {
  const [first] = splitForChannel(text, TEXT_LIMIT[channel]);
  const data = await postToPage({ recipient: { comment_id: commentId }, message: { text: first } }, `Mensaje privado (${channelName(channel)})`, commentId);
  if (!data.recipient_id) throw new Error('Meta no devolvió a quién se envió el mensaje privado');
  return { address: socialAddress(channel, String(data.recipient_id)), messageId: data.message_id };
}

export async function replyToCommentPublicly(channel: SocialChannel, commentId: string, text: string) {
  const creds = await requireCredentials();
  const path = channel === 'instagram' ? 'replies' : 'comments';
  const { data } = await graph.post(`${GRAPH_API}/${commentId}/${path}`, { message: text }, { params: { access_token: creds.pageToken } });
  if (data?.id) rememberSent(String(data.id));
  console.log(`✅ Respuesta pública al comentario en ${channelName(channel)}`);
  return data?.id ? String(data.id) : undefined;
}

/** Texto de la publicación comentada: le da contexto a la IA ("¿precio?" de qué modelo). */
export async function postText(channel: SocialChannel, postId: string): Promise<string> {
  try {
    const creds = await requireCredentials();
    const field = channel === 'instagram' ? 'caption' : 'message';
    const { data } = await graph.get(`${GRAPH_API}/${postId}`, { params: { fields: field, access_token: creds.pageToken } });
    return String(data?.[field] || '');
  } catch {
    return '';
  }
}

// ---------- Datos del cliente y archivos ----------

export async function socialProfileName(address: string): Promise<string> {
  const target = parseSocialAddress(address);
  if (!target) return '';
  try {
    const creds = await requireCredentials();
    const fields = target.channel === 'instagram' ? 'name,username' : 'first_name,last_name';
    const { data } = await graph.get(`${GRAPH_API}/${target.userId}`, { params: { fields, access_token: creds.pageToken } });
    return target.channel === 'instagram'
      ? String(data?.name || (data?.username ? `@${data.username}` : ''))
      : [data?.first_name, data?.last_name].filter(Boolean).join(' ');
  } catch {
    return '';
  }
}

const META_MEDIA_HOSTS = /(^|\.)(fbcdn\.net|fbsbx\.com|cdninstagram\.com|facebook\.com|instagram\.com)$/;

export function isMetaMediaUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' && META_MEDIA_HOSTS.test(parsed.hostname);
  } catch {
    return false;
  }
}

/** Fotos y audios que envía la clienta: Instagram y Messenger los dan con un enlace directo y temporal. */
export async function downloadSocialMedia(url: string): Promise<{ buffer: Buffer; mimeType: string }> {
  // Solo servidores de Meta: el servidor nunca descarga de una dirección cualquiera que venga en un mensaje.
  if (!isMetaMediaUrl(url)) throw new Error('Enlace de archivo inválido');
  const response = await axios.get(url, { responseType: 'arraybuffer', timeout: 60_000, maxContentLength: 25 * 1024 * 1024 });
  const mimeType = String(response.headers['content-type'] || 'application/octet-stream').split(';')[0].trim();
  return { buffer: Buffer.from(response.data), mimeType };
}

let statusCache: { at: number; value: Record<string, string> } | null = null;

/** Estado de Instagram y Messenger para /health (nunca muestra la clave): conexión, vencimiento y permisos concedidos. */
export async function socialStatus(): Promise<Record<string, string>> {
  if (currentTenant()) return { estado: 'no disponible para esta empresa' };
  if (statusCache && Date.now() - statusCache.at < 10 * 60 * 1000) return statusCache.value;
  const stored = await storedCredentials();
  if (!stored.creds && (!process.env.META_PAGE_ID || !process.env.META_PAGE_TOKEN)) return { estado: 'sin configurar' };
  const creds = await pageCredentials();
  let value: Record<string, string> = { estado: 'la clave no funciona', motivo: lastCredentialsError };
  let complete = false;
  if (creds) {
    const info = await tokenInfo(creds.pageToken);
    const missing = REQUIRED_SCOPES.filter(s => !info.scopes.includes(s));
    complete = missing.length === 0 && !!creds.instagramId;
    value = {
      estado: missing.length ? 'conectado, pero faltan permisos' : 'conectado',
      origen: stored.creds ? 'botón Conectar con Facebook del CRM' : 'variables de Render',
      instagram: creds.instagramId ? `conectado (${creds.instagramId})` : 'sin Instagram: a la clave le falta permiso o la página no tiene Instagram profesional',
      clave_vence: info.expiresAt === 0 ? 'nunca' : new Date(info.expiresAt * 1000).toISOString().slice(0, 10),
      permisos: info.scopes.filter(s => /^(pages|instagram)_/.test(s)).join(', ')
    };
    if (info.dataAccessExpiresAt) value.acceso_a_datos_vence = new Date(info.dataAccessExpiresAt * 1000).toISOString().slice(0, 10);
    if (missing.length) value.faltan = missing.join(', ');
  }
  // Mientras falte algo se vuelve a revisar pronto: así se ve enseguida cuando se corrige.
  statusCache = { at: complete ? Date.now() : Date.now() - 9 * 60 * 1000, value };
  return value;
}

/** Suscribe la página a la App para que Meta envíe al servidor los mensajes y comentarios. Se puede repetir sin problema. */
export async function subscribePage(): Promise<string> {
  const creds = await requireCredentials();
  await graph.post(`${GRAPH_API}/${creds.pageId}/subscribed_apps`, null, {
    params: { subscribed_fields: 'messages,messaging_postbacks,message_echoes,feed', access_token: creds.pageToken }
  });
  return creds.instagramId
    ? `Página ${creds.pageId} suscrita; Instagram ${creds.instagramId} conectado`
    : `Página ${creds.pageId} suscrita; no tiene una cuenta de Instagram profesional conectada`;
}

// ---------- Conectar con Facebook desde el CRM ----------

// Publicar en Instagram pide instagram_content_publish y en la página de Facebook, pages_manage_posts.
export const PUBLISH_SCOPES = { instagram: 'instagram_content_publish', facebook: 'pages_manage_posts' };

/** Permisos de estadísticas: Instagram (alcance, vistas…) y Facebook (reacciones, comentarios, impresiones). */
export const INSIGHTS_SCOPES = ['instagram_manage_insights', 'read_insights', 'pages_read_user_content'];

// Permisos que se piden al conectar. Solo los que la App tiene agregados: uno que no esté hace fallar la ventana de Facebook.
// Por eso pages_manage_posts se pide recién cuando la App ya lo tiene (variable META_PUBLISH_FACEBOOK=true en Render).
export const CONNECT_SCOPES = [
  'pages_show_list', 'pages_messaging', 'pages_manage_metadata', 'pages_read_engagement',
  'instagram_basic', 'instagram_manage_messages', 'instagram_manage_comments', PUBLISH_SCOPES.instagram, 'business_management',
  ...(process.env.META_PUBLISH_FACEBOOK === 'true' ? [PUBLISH_SCOPES.facebook] : []),
  // Estadísticas para Resultados (me gusta, comentarios, alcance): se piden recién cuando la App ya los tiene agregados
  // (META_INSIGHTS=true en Render). Sin ellos Meta rechaza las métricas de Instagram y Facebook.
  ...(process.env.META_INSIGHTS === 'true' ? INSIGHTS_SCOPES : [])
];

const STORED_KEY = 'meta_page_connection';
const CONNECT_STATE_MS = 15 * 60 * 1000;
const usedStates = new Set<string>();

function stateSignature(body: string): string {
  const secret = process.env.BUSINESS_SECRETS_KEY || '';
  if (secret.length < 16) throw new Error('Falta BUSINESS_SECRETS_KEY');
  return createHmac('sha256', secret).update(`conectar-meta:${body}`).digest('base64url');
}

/**
 * Sello de un solo uso que viaja a Facebook y vuelve: prueba que la conexión la pidió alguien con sesión en el CRM
 * y dice de qué empresa era (Facebook devuelve a la misma dirección para todas).
 */
export function createConnectState(now = Date.now(), businessId: string = currentTenant()?.businessId || VELAMIA_ID): string {
  const body = `${now + CONNECT_STATE_MS}.${randomBytes(12).toString('base64url')}.${businessId}`;
  return `${body}.${stateSignature(body)}`;
}

/** Empresa que pidió la conexión, o null si el sello es falso, venció o ya se usó. */
export function readConnectState(state: unknown, now = Date.now()): string | null {
  const text = String(state || '');
  const cut = text.lastIndexOf('.');
  if (cut < 0) return null;
  const body = text.slice(0, cut);
  const given = Buffer.from(text.slice(cut + 1));
  const expected = Buffer.from(stateSignature(body));
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  const [expires, , businessId] = body.split('.');
  if (Number(expires) < now || usedStates.has(body)) return null;
  usedStates.add(body);
  return businessId || VELAMIA_ID;
}

export const verifyConnectState = (state: unknown, now = Date.now()): boolean => readConnectState(state, now) !== null;

let cachedAppId = '';
/** Id de la App de Meta: el de META_APP_ID o el de la clave de WhatsApp, que es de la misma App. */
async function metaAppId(): Promise<string> {
  if (process.env.META_APP_ID) return process.env.META_APP_ID.trim();
  if (cachedAppId) return cachedAppId;
  const token = process.env.WHATSAPP_TOKEN || '';
  const { data } = await graph.get(`${GRAPH_API}/debug_token`, { params: { input_token: token, access_token: token } });
  cachedAppId = String(data?.data?.app_id || '');
  if (!cachedAppId) throw new Error('No se pudo saber el id de la App de Meta');
  return cachedAppId;
}

export async function connectUrl(redirectUri: string, state: string): Promise<string> {
  const params = new URLSearchParams({
    client_id: await metaAppId(),
    redirect_uri: redirectUri,
    state,
    response_type: 'code',
    scope: CONNECT_SCOPES.join(','),
    // Si antes rechazó algún permiso, Facebook lo vuelve a preguntar.
    auth_type: 'rerequest'
  });
  return `https://www.facebook.com/v25.0/dialog/oauth?${params}`;
}

/**
 * Vuelta de Facebook: cambia el código por una clave de usuario de larga duración y de ahí saca la de la página, que así
 * no vence. Se guarda cifrada en la base (ya no hace falta tocar Render) y la página queda suscrita a la App.
 */
export async function completeConnection(code: string, redirectUri: string) {
  const clientId = await metaAppId();
  const clientSecret = process.env.META_APP_SECRET || '';
  if (!clientSecret) throw new Error('Falta META_APP_SECRET en el servidor');
  const short = await graph.get(`${GRAPH_API}/oauth/access_token`, { params: { client_id: clientId, client_secret: clientSecret, redirect_uri: redirectUri, code } });
  const long = await graph.get(`${GRAPH_API}/oauth/access_token`, {
    params: { grant_type: 'fb_exchange_token', client_id: clientId, client_secret: clientSecret, fb_exchange_token: short.data.access_token }
  }).catch(() => short);
  const userToken = String(long.data.access_token);

  const { data } = await graph.get(`${GRAPH_API}/me/accounts`, {
    params: { fields: 'id,name,access_token,instagram_business_account{id,username}', limit: 100, access_token: userToken }
  });
  const pages: any[] = data?.data || [];
  if (pages.length === 0) throw new Error('No elegiste ninguna página de Facebook. Vuelve a conectar y marca tu página.');
  // META_PAGE_ID es la página de VELAMIA: otra empresa se queda con la página que eligió.
  const tenant = currentTenant();
  const wanted = tenant ? '' : (process.env.META_PAGE_ID || '').trim();
  const page = pages.find(p => String(p.id) === wanted) || pages[0];

  const record = {
    pageId: String(page.id),
    pageName: String(page.name || ''),
    pageToken: String(page.access_token),
    instagramId: String(page.instagram_business_account?.id || ''),
    instagramUsername: String(page.instagram_business_account?.username || ''),
    connectedAt: new Date().toISOString()
  };
  await setConfig(STORED_KEY, encryptSecret(JSON.stringify(record)));
  resetPageCredentials();
  // Las demás empresas conectan su página para publicar; los mensajes de Instagram y Messenger siguen siendo solo de VELAMIA.
  const subscribed = tenant ? null : await subscribePage().then(() => true).catch(error => {
    console.error('❌ No se pudo suscribir la página a la App:', metaError(error));
    return false;
  });
  console.log(`📘 Conectado desde el CRM${tenant ? ` (${tenant.name})` : ''}: página ${record.pageName}${record.instagramUsername ? `, Instagram @${record.instagramUsername}` : ''}`);
  return { pageName: record.pageName, instagramUsername: record.instagramUsername, subscribed, otherPages: pages.length - 1 };
}

// ---------- Publicar en la página y en Instagram (servicio de publicaciones, para todas las empresas) ----------

export interface PublishingConnection {
  pageId: string;
  pageName: string;
  pageToken: string;
  instagramId: string;
  instagramUsername: string;
}

const publishingCache = new Map<string, { at: number; value: PublishingConnection | null }>();

/**
 * Página y cuenta de Instagram donde publica la empresa actual. VELAMIA usa la misma conexión que sus mensajes
 * (botón del CRM o variables de Render); cada empresa, la que conectó con el botón desde su CRM.
 */
export async function publishingConnection(): Promise<PublishingConnection | null> {
  const tenant = currentTenant();
  const key = tenant?.businessId || VELAMIA_ID;
  const hit = publishingCache.get(key);
  if (hit && Date.now() - hit.at < 60_000) return hit.value;

  let value: PublishingConnection | null = null;
  try {
    const raw = (await getConfig(STORED_KEY)) || '';
    if (raw) {
      const r = JSON.parse(decryptSecret(raw));
      value = { pageId: String(r.pageId), pageName: String(r.pageName || ''), pageToken: String(r.pageToken), instagramId: String(r.instagramId || ''), instagramUsername: String(r.instagramUsername || '') };
    } else if (!tenant) {
      const creds = await pageCredentials();
      if (creds) value = { ...creds, pageName: '', instagramUsername: '' };
    }
  } catch (error: any) {
    console.error('❌ No se pudo leer la conexión de Facebook para publicar:', error.message);
  }
  publishingCache.set(key, { at: Date.now(), value });
  return value;
}

/** Lo que el CRM muestra antes de publicar: dónde se publica y qué permiso falta en cada red. */
export async function publishingStatus() {
  const conn = await publishingConnection();
  if (!conn) return { connected: false, pageName: '', instagramUsername: '', instagram: false, facebookAllowed: false, instagramAllowed: false, missing: [] as string[] };
  const info = await tokenInfo(conn.pageToken);
  const has = (scope: string) => info.scopes.includes(scope);
  const missing = [PUBLISH_SCOPES.instagram, PUBLISH_SCOPES.facebook].filter(s => !has(s));
  return {
    connected: info.valid,
    pageName: conn.pageName,
    instagramUsername: conn.instagramUsername,
    instagram: !!conn.instagramId,
    instagramAllowed: has(PUBLISH_SCOPES.instagram) && !!conn.instagramId,
    facebookAllowed: has(PUBLISH_SCOPES.facebook),
    missing,
    error: info.valid ? '' : info.error
  };
}

let storedCache: { at: number; value: PageCredentials | null; raw: string } | null = null;

/** La conexión hecha desde el CRM (si existe). Se relee cada minuto para no consultar la base en cada mensaje. */
async function storedCredentials(): Promise<{ creds: PageCredentials | null; raw: string }> {
  if (storedCache && Date.now() - storedCache.at < 60_000) return { creds: storedCache.value, raw: storedCache.raw };
  let value: PageCredentials | null = null;
  let raw = '';
  try {
    raw = (await getConfig(STORED_KEY)) || '';
    if (raw) {
      const record = JSON.parse(decryptSecret(raw));
      value = { pageId: String(record.pageId), pageToken: String(record.pageToken), instagramId: String(record.instagramId || '') };
    }
  } catch (error: any) {
    console.error('❌ No se pudo leer la conexión de Facebook guardada:', error.message);
  }
  storedCache = { at: Date.now(), value, raw };
  return { creds: value, raw };
}

export function resetPageCredentials() {
  cached = null;
  storedCache = null;
  statusCache = null;
  publishingCache.clear();
}
