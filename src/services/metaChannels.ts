import axios from 'axios';
import { currentTenant } from './tenant';
import { maskPhone } from './privacy';

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
 * Página de Facebook (y su Instagram conectado) de VELAMIA. Basta META_PAGE_ID y META_PAGE_TOKEN: sirve la clave de la
 * página o la de un usuario del sistema (que se cambia por la de la página), y la cuenta de Instagram se detecta sola.
 * Las demás empresas todavía no tienen estos canales: sin credenciales, nada cambia para ellas.
 */
export async function pageCredentials(): Promise<PageCredentials | null> {
  if (currentTenant()) return null;
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

// Lo que el asistente necesita para mensajes y comentarios en los dos canales.
export const REQUIRED_SCOPES = [
  'pages_messaging', 'pages_manage_metadata', 'pages_read_engagement', 'pages_manage_engagement',
  'instagram_basic', 'instagram_manage_messages', 'instagram_manage_comments'
];

/** Qué dice Meta de una clave: si sirve, cuándo vence, qué permisos tiene y a qué Instagram le dan acceso. */
async function tokenInfo(token: string) {
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

/** Fotos y audios que envía la clienta: Instagram y Messenger los dan con un enlace directo y temporal. */
export async function downloadSocialMedia(url: string): Promise<{ buffer: Buffer; mimeType: string }> {
  if (!/^https:\/\//.test(url)) throw new Error('Enlace de archivo inválido');
  const response = await axios.get(url, { responseType: 'arraybuffer', timeout: 60_000, maxContentLength: 25 * 1024 * 1024 });
  const mimeType = String(response.headers['content-type'] || 'application/octet-stream').split(';')[0].trim();
  return { buffer: Buffer.from(response.data), mimeType };
}

let statusCache: { at: number; value: Record<string, string> } | null = null;

/** Estado de Instagram y Messenger para /health (nunca muestra la clave): conexión, vencimiento y permisos concedidos. */
export async function socialStatus(): Promise<Record<string, string>> {
  if (!process.env.META_PAGE_ID || !process.env.META_PAGE_TOKEN) return { estado: 'sin configurar' };
  if (statusCache && Date.now() - statusCache.at < 10 * 60 * 1000) return statusCache.value;
  const creds = await pageCredentials();
  let value: Record<string, string> = { estado: 'la clave no funciona', motivo: lastCredentialsError };
  let complete = false;
  if (creds) {
    const info = await tokenInfo(creds.pageToken);
    const missing = REQUIRED_SCOPES.filter(s => !info.scopes.includes(s));
    complete = missing.length === 0 && !!creds.instagramId;
    value = {
      estado: missing.length ? 'conectado, pero faltan permisos' : 'conectado',
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
