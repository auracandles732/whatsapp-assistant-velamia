import {
  getConversation,
  createConversation,
  saveMessage,
  touchConversation,
  isMessageAlreadyProcessed,
  getConfig,
  getAllProducts,
  pauseBot
} from '../db';
import {
  SocialChannel,
  channelForAccount,
  channelName,
  socialAddress,
  sendPrivateReply,
  replyToCommentPublicly,
  postText,
  wasSentByUs
} from '../services/metaChannels';
import { handleSocialMessage, handleSocialEcho } from './messageController';
import { planTurn } from '../services/openai';
import { notifyOwner } from '../services/notifications';
import { profile } from '../config/businessProfile';

/**
 * Avisos de Meta para la página de Facebook ("page") y el Instagram conectado ("instagram"): mensajes privados, ecos de lo
 * que el equipo escribió desde la app y comentarios en publicaciones.
 */
export async function handleSocialWebhook(data: any): Promise<void> {
  const object = String(data?.object || '');
  for (const entry of data?.entry || []) {
    const channel = await channelForAccount(object, String(entry?.id || ''));
    if (!channel) {
      console.warn(`⚠️ Aviso de ${object} para una cuenta que no está conectada (${entry?.id}): se ignora`);
      continue;
    }
    for (const event of entry.messaging || []) {
      handleMessagingEvent(channel, event).catch(error => console.error(`Error procesando mensaje de ${channelName(channel)}:`, error));
    }
    for (const change of entry.changes || []) {
      const comment = commentFromChange(channel, change, String(entry.id));
      if (comment) handleComment(channel, comment).catch(error => console.error(`Error respondiendo comentario de ${channelName(channel)}:`, error));
    }
  }
}

// ---------- Mensajes privados ----------

/**
 * Traduce un mensaje de Instagram o Messenger a la forma de los mensajes de WhatsApp, para que el resto del sistema
 * (CRM, IA, fotos, audios) lo atienda igual. Devuelve null si no hay nada que contestar (reacciones, leídos, borrados).
 */
export function toWhatsAppShape(channel: SocialChannel, event: any): any | null {
  const from = socialAddress(channel, String(event?.sender?.id || ''));
  const base = { from, timestamp: String(Math.floor(Number(event?.timestamp || Date.now()) / 1000)) };

  if (event?.postback) {
    const title = String(event.postback.title || event.postback.payload || '').trim();
    return title ? { ...base, id: String(event.postback.mid || `pb-${event.timestamp}-${event.sender?.id}`), type: 'text', text: { body: title } } : null;
  }

  const message = event?.message;
  if (!message || message.is_echo || message.is_deleted || !message.mid) return null;
  const context = message.reply_to?.mid ? { context: { id: String(message.reply_to.mid) } } : {};
  const storyReply = message.reply_to?.story ? '[Respondió a tu historia] ' : '';
  const shaped = { ...base, id: String(message.mid), ...context };

  const attachment = (message.attachments || [])[0];
  if (!attachment) {
    const text = String(message.text || '').trim();
    return text || storyReply ? { ...shaped, type: 'text', text: { body: `${storyReply}${text}`.trim() } } : null;
  }

  const url = String(attachment.payload?.url || '');
  const caption = message.text ? String(message.text) : undefined;
  switch (attachment.type) {
    case 'image':
      return url ? { ...shaped, type: 'image', image: { link: url, caption } } : null;
    case 'audio':
      return url ? { ...shaped, type: 'audio', audio: { link: url } } : null;
    case 'file':
      return url ? { ...shaped, type: 'document', document: { link: url, filename: 'archivo', caption } } : null;
    case 'video':
      return { ...shaped, type: 'video', video: { caption } };
    case 'story_mention':
      return { ...shaped, type: 'text', text: { body: '[Te mencionó en su historia]' } };
    case 'share':
    case 'ig_reel':
    case 'reel':
    case 'ig_post':
      return { ...shaped, type: 'text', text: { body: `[Compartió una publicación]${caption ? ` ${caption}` : ''}` } };
    default:
      return { ...shaped, type: 'sticker' };
  }
}

async function handleMessagingEvent(channel: SocialChannel, event: any) {
  const message = event?.message;
  if (message?.is_echo) {
    const to = socialAddress(channel, String(event?.recipient?.id || ''));
    const text = String(message.text || '').trim() || (message.attachments?.length ? `[${message.attachments[0].type} enviado desde la app]` : '');
    await handleSocialEcho(String(message.mid || ''), to, text);
    return;
  }
  const shaped = toWhatsAppShape(channel, event);
  if (shaped) await handleSocialMessage(shaped);
}

// ---------- Comentarios ----------

export interface IncomingComment {
  commentId: string;
  postId: string;
  text: string;
  fromId: string;
  fromName: string;
}

/** Solo comentarios nuevos de otras personas en una publicación; no las respuestas ni los propios. */
export function commentFromChange(channel: SocialChannel, change: any, accountId: string): IncomingComment | null {
  const value = change?.value || {};
  if (channel === 'messenger') {
    if (change?.field !== 'feed' || value.item !== 'comment' || value.verb !== 'add') return null;
    if (value.parent_id && value.parent_id !== value.post_id) return null;
    const fromId = String(value.from?.id || '');
    if (!value.comment_id || fromId === accountId) return null;
    return { commentId: String(value.comment_id), postId: String(value.post_id || ''), text: String(value.message || ''), fromId, fromName: String(value.from?.name || '') };
  }
  if (change?.field !== 'comments' || value.parent_id) return null;
  const fromId = String(value.from?.id || '');
  if (!value.id || fromId === accountId) return null;
  return { commentId: String(value.id), postId: String(value.media?.id || ''), text: String(value.text || ''), fromId, fromName: String(value.from?.username || '') };
}

export type CommentKind = 'lead' | 'praise' | 'complaint' | 'ignore';

const normalize = (text: string) => text.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase();
const COMPLAINT = /\b(estafa\w*|fraude|nunca llego|no me llego|no llego|reclamo|queja|pesimo|mal servicio|devolucion|reembolso|me robaron|robo)\b/;
const LEAD = /\?|\b(precio\w*|cuanto\w*|costo\w*|cuesta\w*|valor\w*|info\w*|interes\w*|quiero|quisiera|pedido\w*|pedir|encarg\w*|disponible\w*|envi\w*|entreg\w*|hacen|tienen|venden|donde|ubicacion|catalogo|inbox|dm|md|privado|interno|whatsapp|numero|cotiz\w*|docena\w*|como compro|como hago|me das|pasame|mandame)\b/;

/** Qué hacer con un comentario: a quien pregunta o muestra interés se le escribe por privado; a quien elogia, se le agradece. */
export function commentKind(text: string): CommentKind {
  const clean = normalize(text).replace(/@[\w.]+/g, '').trim();
  if (!clean) return 'ignore';
  if (COMPLAINT.test(clean)) return 'complaint';
  if (LEAD.test(clean)) return 'lead';
  return 'praise';
}

const pick = (options: string[]) => options[Math.floor(Math.random() * options.length)];

/** Respuesta corta y variada en el comentario: a la vista de todos nunca van precios ni datos. */
export function publicReplyText(kind: CommentKind, channel: SocialChannel, fromName: string, wroteInPrivate: boolean): string {
  const emojis = profile().style.decorativeEmojis;
  const e = emojis.length ? pick(emojis) : '🤍';
  // En Instagram el nombre es el usuario (@...), que queda raro en un saludo: se saluda sin nombre.
  const first = channel === 'messenger' ? fromName.trim().split(/\s+/)[0] || '' : '';
  const hola = first ? `¡Hola ${first}!` : '¡Hola!';
  if (kind === 'praise') return pick([`¡Gracias${first ? ` ${first}` : ''}! ${e}`, `Gracias por tu comentario ${e}`, `¡Qué lindo que te guste! ${e}`]);
  if (!wroteInPrivate) return `${hola} Escríbenos por mensaje directo y con gusto te ayudamos ${e}`;
  return pick([`${hola} Te escribimos por interno ${e}`, `${hola} Ya te enviamos la información por mensaje privado ${e}`, `${hola} Revisa tus mensajes, ya te escribimos ${e}`]);
}

// Meta puede repetir el mismo aviso: un comentario se atiende una sola vez.
const inProgress = new Set<string>();
// Una persona real no contesta al segundo.
const COMMENT_DELAY_MS = [20_000, 60_000];

async function handleComment(channel: SocialChannel, comment: IncomingComment, delayMs = COMMENT_DELAY_MS) {
  if (inProgress.has(comment.commentId) || wasSentByUs(comment.commentId)) return;
  inProgress.add(comment.commentId);
  try {
    if (await isMessageAlreadyProcessed(comment.commentId)) return;
    if ((await getConfig('bot_enabled')) === 'false') {
      console.log(`🚫 Bot desactivado: el comentario en ${channelName(channel)} queda sin respuesta automática`);
      return;
    }
    const kind = commentKind(comment.text);
    console.log(`💬 Comentario en ${channelName(channel)} (${kind}): "${comment.text.slice(0, 80)}"`);
    if (kind === 'ignore') return;

    await new Promise(resolve => setTimeout(resolve, delayMs[0] + Math.random() * (delayMs[1] - delayMs[0])));

    if (kind === 'praise') {
      await replyToCommentPublicly(channel, comment.commentId, publicReplyText('praise', channel, comment.fromName, false));
      return;
    }

    // Primero el mensaje privado: el comentario público solo dice "te escribimos" si de verdad se pudo escribir.
    const privateText = kind === 'complaint'
      ? `Hola${comment.fromName && channel === 'messenger' ? ` ${comment.fromName.split(/\s+/)[0]}` : ''}, vimos tu comentario y queremos ayudarte 🤍 ¿Nos cuentas qué pasó?`
      : await privateOpening(channel, comment);

    let privateSent: { address: string; messageId?: string } | null = null;
    try {
      privateSent = await sendPrivateReply(channel, comment.commentId, privateText);
    } catch (error: any) {
      console.error(`❌ No se pudo escribir por privado a quien comentó en ${channelName(channel)}:`, error.response?.data?.error?.message || error.message);
    }

    const publicText = publicReplyText(kind, channel, comment.fromName, !!privateSent);
    const publicId = await replyToCommentPublicly(channel, comment.commentId, publicText).catch((error: any) => {
      console.error('❌ No se pudo responder el comentario:', error.response?.data?.error?.message || error.message);
      return undefined;
    });
    if (!privateSent) return;

    const conversation = (await getConversation(privateSent.address)) || (await createConversation(privateSent.address, comment.fromName || undefined));
    await saveMessage(conversation.id, 'customer', 'text', `💬 Comentó en ${channelName(channel)}: "${comment.text}"`, comment.commentId);
    await saveMessage(conversation.id, 'bot', 'text', privateText, privateSent.messageId);
    if (publicId) await saveMessage(conversation.id, 'bot', 'text', `💬 Respuesta pública al comentario: ${publicText}`, publicId);
    await touchConversation(conversation.id);

    if (kind === 'complaint') {
      await notifyOwner({ conversationId: conversation.id, customerPhone: privateSent.address, customerName: conversation.customer_name || comment.fromName, event: 'complaint', detail: comment.text });
      await pauseBot(conversation.id);
    }
  } finally {
    inProgress.delete(comment.commentId);
  }
}

/** Primer mensaje privado a quien comentó: lo escribe la IA como a una clienta nueva, con el texto de la publicación como contexto. */
async function privateOpening(channel: SocialChannel, comment: IncomingComment): Promise<string> {
  const fallback = `¡Hola! Vi tu comentario en ${channelName(channel)} 🤍 ¿En qué te puedo ayudar?`;
  try {
    const [catalog, customPrompt, caption] = await Promise.all([getAllProducts(), getConfig('system_prompt'), comment.postId ? postText(channel, comment.postId) : Promise.resolve('')]);
    const where = `tu publicación de ${channelName(channel)}${caption ? ` (la publicación dice: "${caption.slice(0, 300)}")` : ''}`;
    const plan = await planTurn({
      history: [],
      userMessage: `[El cliente comentó en ${where}: "${comment.text}". Le escribes por mensaje privado y solo puedes enviarle UN mensaje de texto, sin fotos, hasta que te conteste: salúdalo, menciona que viste su comentario y termina con una pregunta]`,
      catalog,
      customPrompt,
      sentProducts: []
    });
    return plan.reply.trim() || fallback;
  } catch (error: any) {
    console.error('❌ La IA no pudo escribir el mensaje privado del comentario:', error.message);
    return fallback;
  }
}
