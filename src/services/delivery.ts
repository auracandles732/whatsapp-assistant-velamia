import { randomUUID } from 'crypto';
import {
  supabase, getConfig, setConfig, getConversationById, getMessageByWaId, saveMessage, touchConversation, logNotification, parseDbTimestamp
} from './supabase';
import {
  sendTextMessage, sendImageMessage, sendAudioMessage, sendTemplateMessage, getMessageTemplates, createMessageTemplate, getSentMessageId
} from './whatsapp';
import { isSocialAddress } from './metaChannels';
import { currentTenant } from './tenant';
import { profile } from '../config/businessProfile';
import { maskPhone } from './privacy';

/**
 * Entrega de los mensajes escritos desde el CRM (para todas las empresas).
 *
 * WhatsApp solo deja escribir libremente dentro de las 24 horas desde el último mensaje de la clienta. Fuera de ese plazo
 * acepta el envío (devuelve un id, como si hubiera salido) y minutos después avisa que NO lo entregó. Antes ese aviso se
 * ignoraba: en el CRM el mensaje se veía enviado y a la clienta nunca le llegaba.
 *
 * Ahora:
 * - Si el plazo está cerrado, lo escrito no se pierde: queda guardado y sale solo apenas la clienta responda. Para que
 *   responda se le manda una plantilla aprobada ("retomar_conversacion", con el botón "Ver mensaje").
 * - Cada aviso de "no entregado" de WhatsApp (cualquier motivo) queda registrado y el CRM lo muestra en ese mensaje.
 */

/** Unos minutos menos que 24 h: un mensaje que sale justo al límite igual lo rechazaría WhatsApp. */
export const WINDOW_MS = 24 * 60 * 60 * 1000 - 5 * 60 * 1000;
/** Lo guardado espera hasta 14 días; después ya no tiene sentido enviarlo solo. */
const OUTBOX_DAYS = 14;
const OUTBOX_MAX = 20;
/** La plantilla para retomar se manda como mucho una vez cada 20 h por chat (cada una cuesta). */
const REOPEN_EVERY_MS = 20 * 60 * 60 * 1000;
export const UNDELIVERED_EVENT = 'wa_undelivered';
export const REOPEN_TEMPLATE = 'retomar_conversacion';
const REOPEN_BUTTON = 'Ver mensaje';

export type PendingKind = 'text' | 'image' | 'audio';
export interface PendingMessage {
  id: string;
  kind: PendingKind;
  text?: string;
  url?: string;
  caption?: string;
  at: string;
  /** Id de WhatsApp del mensaje que no se entregó y se volverá a enviar (ya se ve en el chat como "no entregado"). */
  retryOf?: string;
}
export type PendingInput = Omit<PendingMessage, 'id' | 'at'>;

export interface ReopenState { at: string; status: 'sent' | 'failed' | 'no_template' | 'template_pending'; detail?: string; waId?: string }

const outboxKey = (conversationId: string) => `chat_outbox_${conversationId}`;
const reopenKey = (conversationId: string) => `chat_reopen_${conversationId}`;

// ---------- Plazo de 24 horas ----------

/** Cuándo escribió la clienta por última vez (cualquier mensaje suyo abre el plazo). */
export async function lastCustomerMessageAt(conversationId: string): Promise<Date | null> {
  const { data, error } = await supabase
    .from('messages')
    .select('timestamp')
    .eq('conversation_id', conversationId)
    .eq('sender', 'customer')
    .order('timestamp', { ascending: false })
    .limit(1);
  if (error) throw new Error(`Error leyendo el último mensaje de la clienta: ${error.message}`);
  return data?.[0]?.timestamp ? parseDbTimestamp(data[0].timestamp) : null;
}

export interface ChatWindow { open: boolean; lastCustomerAt: string | null; closesAt: string | null }

export function windowFrom(lastCustomerAt: Date | null, now = Date.now()): ChatWindow {
  if (!lastCustomerAt) return { open: false, lastCustomerAt: null, closesAt: null };
  const closes = lastCustomerAt.getTime() + WINDOW_MS;
  return { open: now < closes, lastCustomerAt: lastCustomerAt.toISOString(), closesAt: new Date(closes).toISOString() };
}

export async function chatWindow(conversationId: string): Promise<ChatWindow> {
  return windowFrom(await lastCustomerMessageAt(conversationId));
}

// ---------- Mensajes guardados para cuando responda ----------

export async function readOutbox(conversationId: string, now = Date.now()): Promise<PendingMessage[]> {
  try {
    const list = JSON.parse((await getConfig(outboxKey(conversationId))) || '[]');
    if (!Array.isArray(list)) return [];
    return list.filter((m: any) => m && m.id && now - new Date(m.at).getTime() < OUTBOX_DAYS * 86_400_000);
  } catch {
    return [];
  }
}

async function writeOutbox(conversationId: string, list: PendingMessage[]) {
  await setConfig(outboxKey(conversationId), JSON.stringify(list.slice(-OUTBOX_MAX)));
}

export async function readReopen(conversationId: string): Promise<ReopenState | null> {
  try {
    const raw = await getConfig(reopenKey(conversationId));
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

/** Quita un mensaje guardado (la dueña se arrepintió de enviarlo). */
export async function dropPending(conversationId: string, id: string): Promise<boolean> {
  const list = await readOutbox(conversationId);
  const rest = list.filter(m => m.id !== id);
  if (rest.length === list.length) return false;
  await writeOutbox(conversationId, rest);
  return true;
}

// ---------- Plantilla para retomar la conversación ----------

const templateCache = new Map<string, { at: number; status: string; language: string }>();
const TEMPLATE_CACHE_MS = 10 * 60 * 1000;
const tenantKey = () => currentTenant()?.businessId || 'velamia';

export function reopenTemplateBody(businessName: string) {
  const name = String(businessName || '').replace(/[*_~`{}]/g, '').trim().slice(0, 60);
  return `Hola 👋 Te escribimos${name ? ` de ${name}` : ''} para continuar con tu consulta. Tenemos una respuesta para ti: toca el botón o responde este mensaje y te la enviamos enseguida.`;
}

/**
 * Cómo está la plantilla para retomar en el WhatsApp de la empresa ('APPROVED', 'PENDING', 'REJECTED'…). Si no existe,
 * se crea (Meta la revisa: suele tardar minutos). Nunca lanza error: devuelve 'ERROR' si Meta no responde.
 */
export async function reopenTemplateStatus(createIfMissing = true): Promise<{ status: string; language: string }> {
  const cached = templateCache.get(tenantKey());
  if (cached && Date.now() - cached.at < TEMPLATE_CACHE_MS) return cached;
  let result = { status: 'ERROR', language: 'es' };
  try {
    const found = (await getMessageTemplates()).find(t => t.name === REOPEN_TEMPLATE);
    if (found) {
      result = { status: String(found.status || ''), language: String(found.language || 'es') };
    } else if (createIfMissing) {
      const created = await createMessageTemplate({
        name: REOPEN_TEMPLATE,
        category: 'UTILITY',
        language: 'es',
        body: reopenTemplateBody(profile().business.name),
        examples: [],
        quickReplies: [REOPEN_BUTTON]
      });
      console.log(`📝 Plantilla ${REOPEN_TEMPLATE} creada en WhatsApp (${created.status}): Meta la revisa antes de usarla`);
      result = { status: created.status || 'PENDING', language: 'es' };
    } else {
      result = { status: 'MISSING', language: 'es' };
    }
  } catch (error: any) {
    console.warn(`⚠️ Plantilla ${REOPEN_TEMPLATE}:`, error.response?.data?.error?.message || error.message);
  }
  templateCache.set(tenantKey(), { ...result, at: Date.now() });
  return result;
}

/**
 * Le manda a la clienta la plantilla para que vuelva a escribir (así sale lo guardado). Una vez cada 20 horas por chat,
 * salvo que se pida de nuevo a mano (force).
 */
export async function sendReopen(conv: { id: string; phone_number: string }, force = false): Promise<ReopenState> {
  if (isSocialAddress(conv.phone_number)) {
    return { at: new Date().toISOString(), status: 'no_template', detail: 'Instagram y Messenger no tienen plantillas: el mensaje sale cuando la clienta vuelva a escribir.' };
  }
  const previous = await readReopen(conv.id);
  if (!force && previous?.status === 'sent' && Date.now() - new Date(previous.at).getTime() < REOPEN_EVERY_MS) return previous;
  const template = await reopenTemplateStatus();
  let state: ReopenState;
  if (template.status !== 'APPROVED') {
    state = {
      at: new Date().toISOString(),
      status: ['PENDING', 'IN_APPEAL'].includes(template.status) ? 'template_pending' : 'no_template',
      detail: template.status === 'REJECTED' ? 'Meta rechazó la plantilla para retomar conversaciones.' : undefined
    };
  } else {
    try {
      const sent = await sendTemplateMessage(conv.phone_number, REOPEN_TEMPLATE, template.language);
      const waId = getSentMessageId(sent);
      await saveMessage(conv.id, 'bot', 'text', reopenTemplateBody(profile().business.name), waId);
      await touchConversation(conv.id);
      state = { at: new Date().toISOString(), status: 'sent', waId };
      console.log(`📨 Plantilla para retomar enviada a ${maskPhone(conv.phone_number)}`);
    } catch (error: any) {
      state = { at: new Date().toISOString(), status: 'failed', detail: deliveryProblem(error.response?.data?.error?.code, error.response?.data?.error?.message || error.message) };
    }
  }
  await setConfig(reopenKey(conv.id), JSON.stringify(state)).catch(() => {});
  return state;
}

/**
 * Guarda lo que no se puede enviar todavía y, si es WhatsApp, avisa a la clienta con la plantilla para que responda.
 * Devuelve el texto que el CRM le muestra a quien escribió.
 */
export async function holdForLater(conv: { id: string; phone_number: string }, items: PendingInput[]): Promise<{ notice: string; reopen: ReopenState }> {
  const now = new Date().toISOString();
  const list = await readOutbox(conv.id);
  list.push(...items.map(item => ({ ...item, id: randomUUID(), at: now })));
  await writeOutbox(conv.id, list);
  const reopen = await sendReopen(conv);
  return { notice: holdNotice(reopen, isSocialAddress(conv.phone_number)), reopen };
}

export function holdNotice(reopen: ReopenState | null, social: boolean): string {
  const head = social
    ? 'Pasaron más de 24 horas desde el último mensaje de la clienta y Meta no deja escribirle por aquí. Tu mensaje quedó guardado y se envía solo apenas ella vuelva a escribir.'
    : 'Pasaron más de 24 horas desde el último mensaje de la clienta y WhatsApp no deja escribirle libremente. Tu mensaje quedó guardado y se envía solo apenas ella responda.';
  if (social || !reopen) return head;
  if (reopen.status === 'sent') return `${head} Ya le llegó un aviso para que responda.`;
  if (reopen.status === 'template_pending') return `${head} El aviso para que responda está en revisión de Meta (suele tardar minutos); en cuanto lo aprueben, podrás mandárselo.`;
  if (reopen.status === 'failed') return `${head} No se pudo mandarle el aviso: ${reopen.detail}`;
  return `${head}${reopen.detail ? ` ${reopen.detail}` : ''}`;
}

async function sendPending(phone: string, item: PendingMessage) {
  if (item.kind === 'image') return sendImageMessage(phone, item.url!, item.caption || undefined);
  if (item.kind === 'audio') return sendAudioMessage(phone, item.url!);
  return sendTextMessage(phone, item.text || '');
}

function storedContent(item: PendingMessage) {
  if (item.kind === 'image') return item.caption ? `${item.url}\n${item.caption}` : item.url!;
  if (item.kind === 'audio') return item.url!;
  return item.text || '';
}

const flushing = new Set<string>();

/**
 * La clienta escribió: sale todo lo guardado para ella, en orden. Lo que falle queda guardado para el próximo intento.
 * Devuelve cuántos salieron.
 */
export async function flushOutbox(conversationId: string, phone: string): Promise<number> {
  if (flushing.has(conversationId)) return 0;
  flushing.add(conversationId);
  try {
    const list = await readOutbox(conversationId);
    if (list.length === 0) return 0;
    const sent = new Set<string>();
    for (const item of list) {
      try {
        const response = await sendPending(phone, item);
        await saveMessage(conversationId, 'human', item.kind, storedContent(item), getSentMessageId(response));
        sent.add(item.id);
      } catch (error: any) {
        console.warn(`⚠️ Mensaje guardado para ${maskPhone(phone)} no salió:`, error.response?.data?.error?.message || error.message);
        break;
      }
    }
    // Se vuelve a leer: mientras salían, desde el CRM pudieron guardar otro.
    const rest = (await readOutbox(conversationId)).filter(m => !sent.has(m.id));
    await writeOutbox(conversationId, rest);
    if (sent.size) {
      await touchConversation(conversationId);
      await setConfig(reopenKey(conversationId), '').catch(() => {});
      console.log(`📤 ${sent.size} mensaje(s) guardado(s) enviados a ${maskPhone(phone)} al responder`);
    }
    return sent.size;
  } finally {
    flushing.delete(conversationId);
  }
}

// ---------- Avisos de "no entregado" ----------

/** Explica en palabras simples por qué WhatsApp no entregó un mensaje. */
export function deliveryProblem(code: unknown, detail = ''): string {
  const n = Number(code);
  const known: Record<number, string> = {
    131047: 'Pasaron más de 24 horas desde el último mensaje de la clienta: WhatsApp no deja escribirle libremente.',
    131026: 'El número no puede recibir el mensaje (no tiene WhatsApp, no aceptó las condiciones nuevas o usa una versión vieja).',
    131049: 'WhatsApp no lo entregó para no saturar a la clienta con mensajes de empresas. Se puede intentar otro día o esperar a que ella escriba.',
    131050: 'La clienta pidió no recibir mensajes de marketing de tu empresa.',
    131042: 'Hay un problema con el método de pago de la cuenta de WhatsApp Business: revisa la tarjeta en el administrador de Meta.',
    131056: 'Se enviaron demasiados mensajes seguidos a este número: espera un momento antes de volver a escribir.',
    131053: 'WhatsApp no pudo procesar el archivo (foto, audio o documento).',
    131052: 'WhatsApp no pudo descargar el archivo.',
    131051: 'WhatsApp no acepta este tipo de mensaje.',
    131031: 'La cuenta de WhatsApp Business está bloqueada o restringida por Meta.',
    131021: 'No se puede enviar un mensaje al mismo número que lo envía.',
    130472: 'Meta no lo entregó porque el número de la clienta está en una prueba de Meta con mensajes de marketing.',
    130429: 'Se superó el límite de envíos por segundo: vuelve a intentarlo.',
    131048: 'Se superó el límite de envíos de este número: WhatsApp frenó los envíos por un tiempo.',
    132000: 'La plantilla no tiene los datos que pide.',
    132001: 'La plantilla no existe o no está aprobada en ese idioma.',
    132015: 'La plantilla está pausada por baja calidad.',
    132016: 'La plantilla está desactivada por baja calidad.',
    368: 'La cuenta está restringida temporalmente por las políticas de WhatsApp.',
    131000: 'WhatsApp tuvo un error al enviarlo: vuelve a intentarlo.'
  };
  if (known[n]) return known[n];
  const clean = String(detail || '').replace(/\s+/g, ' ').trim().slice(0, 160);
  return `WhatsApp no lo entregó${n ? ` (código ${n}${clean ? `: ${clean}` : ''})` : clean ? ` (${clean})` : ''}.`;
}

/** "id|código|motivo": así se reconoce el mensaje en el chat. */
const encodeFailure = (waId: string, code: number, reason: string) => `${waId}|${code || 0}|${reason}`.slice(0, 500);

/**
 * WhatsApp avisó que un mensaje no se entregó. Se anota en su chat (el CRM lo muestra en ese mensaje) y, si era del
 * equipo y el motivo es el plazo de 24 horas, se guarda para enviarlo apenas la clienta responda.
 * Debe correr dentro de la empresa del número que envió.
 */
export async function recordUndelivered(status: any): Promise<boolean> {
  const waId = String(status?.id || '');
  if (!waId) return true;
  const message = await getMessageByWaId(waId);
  if (!message) return false;
  // El chat tiene que ser de esta empresa (los mensajes no llevan empresa propia).
  const conv = await getConversationById(message.conversation_id);
  if (!conv) return true;
  const error = (status.errors || [])[0] || {};
  const code = Number(error.code) || 0;
  const reason = deliveryProblem(code, error.error_data?.details || error.message || error.title);
  const { data: already } = await supabase.from('notifications').select('id').eq('conversation_id', conv.id)
    .eq('event_type', UNDELIVERED_EVENT).like('message', `${waId}|%`).limit(1);
  if (already && already.length) return true;
  await logNotification(conv.id, UNDELIVERED_EVENT, encodeFailure(waId, code, reason));
  console.warn(`⚠️ WhatsApp no entregó un mensaje (${message.sender}) a ${maskPhone(conv.phone_number)}: ${code} ${error.title || ''}`);
  // Si lo que no llegó es el aviso para retomar, el CRM lo dice en el recuadro de las 24 horas.
  const reopen = await readReopen(conv.id);
  if (reopen?.waId === waId) await setConfig(reopenKey(conv.id), JSON.stringify({ ...reopen, status: 'failed', detail: reason })).catch(() => {});
  if (code === 131047 && message.sender === 'human') {
    const content = String(message.content || '');
    const url = content.match(/^https?:\/\/\S+/)?.[0];
    const item: PendingInput = message.type === 'image' && url
      ? { kind: 'image', url, caption: content.slice(url.length).replace(/^\n/, ''), retryOf: waId }
      : message.type === 'audio' && url
        ? { kind: 'audio', url, retryOf: waId }
        : { kind: 'text', text: content, retryOf: waId };
    await holdForLater(conv, [item]);
  }
  return true;
}

/** Mensajes no entregados de un chat: id de WhatsApp → motivo. */
export async function undeliveredIn(conversationId: string): Promise<Record<string, string>> {
  const { data, error } = await supabase.from('notifications').select('message').eq('conversation_id', conversationId)
    .eq('event_type', UNDELIVERED_EVENT).order('created_at', { ascending: false }).limit(200);
  if (error) return {};
  const out: Record<string, string> = {};
  for (const row of data || []) {
    const [waId, , ...rest] = String(row.message || '').split('|');
    if (waId) out[waId] = rest.join('|');
  }
  return out;
}

/** Lo que el CRM necesita para el chat: plazo de 24 h, lo guardado y el aviso para retomar. */
export async function deliveryState(conv: { id: string; phone_number: string }, loaded: { sender: string; timestamp: string }[] = []) {
  const social = isSocialAddress(conv.phone_number);
  // Con los mensajes ya leídos no hace falta otra consulta (si la clienta no aparece entre ellos, se busca).
  const lastLoaded = [...loaded].reverse().find(m => m.sender === 'customer');
  const windowNow = lastLoaded ? Promise.resolve(windowFrom(parseDbTimestamp(lastLoaded.timestamp))) : chatWindow(conv.id);
  const [window, pending, reopen] = await Promise.all([windowNow, readOutbox(conv.id), readReopen(conv.id)]);
  const template = social || window.open ? null : await reopenTemplateStatus(false);
  return {
    channel: social ? 'social' : 'whatsapp',
    window,
    pending,
    reopen: reopen && reopen.at ? reopen : null,
    template: template ? template.status : null
  };
}

/**
 * Al arrancar, el número principal deja lista su plantilla para retomar (si falta, se crea y Meta la revisa). Las demás
 * empresas la crean la primera vez que la necesitan.
 */
export async function ensureReopenTemplate(): Promise<void> {
  if (!process.env.WHATSAPP_TOKEN || !process.env.WHATSAPP_BUSINESS_ACCOUNT_ID) return;
  const { status } = await reopenTemplateStatus(true);
  console.log(`📝 Plantilla para retomar conversaciones: ${status}`);
}
