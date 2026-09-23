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

/**
 * Página de Facebook (y su Instagram conectado) de VELAMIA. Basta META_PAGE_ID y META_PAGE_TOKEN: si la clave es de un
 * usuario del sistema se cambia por la de la página, y la cuenta de Instagram se detecta sola. Las demás empresas todavía
 * no tienen estos canales: sin credenciales, nada cambia para ellas.
 */
export async function pageCredentials(): Promise<PageCredentials | null> {
  if (currentTenant()) return null;
  const pageId = process.env.META_PAGE_ID || '';
  const token = process.env.META_PAGE_TOKEN || '';
  if (!pageId || !token) return null;
  const key = `${pageId}:${token}`;
  if (cached?.key === key) return cached.creds;

  let pageToken = token;
  let instagramId = process.env.INSTAGRAM_ACCOUNT_ID || '';
  try {
    const { data } = await graph.get(`${GRAPH_API}/${pageId}`, { params: { fields: 'access_token,instagram_business_account', access_token: token } });
    if (data.access_token) pageToken = data.access_token;
    if (!instagramId && data.instagram_business_account?.id) instagramId = String(data.instagram_business_account.id);
  } catch (error: any) {
    console.warn('⚠️ No se pudo leer la página de Facebook con META_PAGE_TOKEN:', error.response?.data?.error?.message || error.message);
    return null;
  }
  cached = { key, creds: { pageId, pageToken, instagramId } };
  return cached.creds;
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
