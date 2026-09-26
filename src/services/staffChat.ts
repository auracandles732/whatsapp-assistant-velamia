import { getConfig, setConfig, getOwnerPhone } from './supabase';
import { sendTextMessage, sendButtonsMessage, sendDocumentMessage, sendTemplateMessage, normalizePhone } from './whatsapp';
import { currentTenant } from './tenant';
import { profile } from '../config/businessProfile';
import { getSavedSettings } from '../social/posts';

/**
 * Mensajes internos por WhatsApp: a la dueña (aprendizajes y reporte del supervisor) y a marketing (planificación de
 * contenido para aprobar). WhatsApp solo deja escribir libremente dentro de las 24 horas desde el último mensaje de esa
 * persona: si pasó más, se le manda la plantilla de aviso y lo pendiente sale apenas responda (siempre actualizado).
 */

export type StaffMessage =
  | { kind: 'text'; text: string }
  | { kind: 'buttons'; text: string; buttons: { id: string; title: string }[] }
  | { kind: 'document'; url: string; filename: string; caption?: string };

/** Lo que llega de la dueña o de marketing, ya leído. */
export interface StaffInbound {
  phone: string;
  /** Id del botón que tocó ('' si escribió). */
  replyId: string;
  text: string;
  isOwner: boolean;
  isMarketing: boolean;
}

/** Arma los mensajes de un tema pendiente (por ejemplo "aprendizajes") en el momento de enviarlos. */
type TopicBuilder = (topic: string, phone: string) => Promise<StaffMessage[]>;
/** Atiende una respuesta; devuelve true si era para él. */
type ReplyHandler = (inbound: StaffInbound) => Promise<boolean>;

const builders: { prefix: string; build: TopicBuilder }[] = [];
const handlers: ReplyHandler[] = [];

export function registerStaffTopic(prefix: string, build: TopicBuilder) {
  builders.push({ prefix, build });
}

export function registerStaffReplies(handler: ReplyHandler) {
  handlers.push(handler);
}

// Menos de 24 horas, con margen: un mensaje que sale justo al cerrarse la ventana lo rechazaría WhatsApp.
const WINDOW_MS = 23 * 60 * 60 * 1000;
const OUTBOX_DAYS = 3;
const inboundKey = (phone: string) => `staff_last_inbound_${normalizePhone(phone)}`;
const outboxKey = (phone: string) => `staff_outbox_${normalizePhone(phone)}`;

interface Queued { topic: string; at: string }

async function readOutbox(phone: string): Promise<Queued[]> {
  try {
    const list = JSON.parse((await getConfig(outboxKey(phone))) || '[]');
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

export async function windowOpen(phone: string, now = new Date()): Promise<boolean> {
  const at = await getConfig(inboundKey(phone)).catch(() => undefined);
  return !!at && now.getTime() - new Date(at).getTime() < WINDOW_MS;
}

async function deliver(phone: string, message: StaffMessage) {
  if (message.kind === 'text') await sendTextMessage(phone, [...message.text].slice(0, 4000).join(''));
  else if (message.kind === 'buttons') await sendButtonsMessage(phone, message.text, message.buttons);
  else await sendDocumentMessage(phone, message.url, message.filename, message.caption);
}

async function build(topic: string, phone: string): Promise<StaffMessage[]> {
  const builder = builders.find(b => topic.startsWith(b.prefix));
  return builder ? builder.build(topic, phone) : [];
}

/** WhatsApp dice que la ventana de 24 horas está cerrada. */
const windowClosed = (error: any) => [131047, 131026].includes(error?.response?.data?.error?.code);

export interface StaffAlert {
  /** Qué pasa ("📅 ¿Hacemos la planificación de contenido?"). */
  title: string;
  /** Quién avisa ("Agente de redes"). */
  who: string;
  /** Qué hacer ("Responde 1 = por día o 2 = semanal"). */
  hint: string;
  detail: string;
}

const templateParam = (value: string) => value.replace(/[\n\t\r]+/g, ' ').replace(/ {4,}/g, '   ').trim().slice(0, 200) || '-';

/**
 * Le manda a la dueña o a marketing lo de un tema. Dentro de las 24 horas va completo (con botones y archivos); si no,
 * va la plantilla de aviso y el tema queda guardado para cuando responda. Nunca lanza error.
 */
export async function notifyStaff(phone: string, topic: string, alert: StaffAlert): Promise<'sent' | 'queued' | 'failed' | 'empty'> {
  try {
    if (await windowOpen(phone)) {
      const messages = await build(topic, phone);
      if (messages.length === 0) return 'empty';
      try {
        for (const message of messages) await deliver(phone, message);
        await dropStaffTopics(phone, [topic]);
        return 'sent';
      } catch (error: any) {
        if (!windowClosed(error)) throw error;
      }
    }
    const previous = await readOutbox(phone);
    // Ya se le avisó de esto hace poco y no ha respondido: no se le repite la plantilla (cada una cuesta y cansa).
    const waiting = previous.find(q => q.topic === topic);
    if (waiting && Date.now() - new Date(waiting.at).getTime() < 20 * 60 * 60 * 1000) return 'queued';
    const outbox = previous.filter(q => q.topic !== topic);
    outbox.push({ topic, at: new Date().toISOString() });
    await setConfig(outboxKey(phone), JSON.stringify(outbox));
    const { alerts } = profile();
    if (!alerts.template) throw new Error('falta la plantilla de aviso en el perfil del negocio');
    await sendTemplateMessage(phone, alerts.template, 'es', [alert.title, alert.who, alert.hint, alert.detail].map(templateParam));
    return 'queued';
  } catch (error: any) {
    console.error(`❌ No se pudo avisar por WhatsApp (${topic}):`, error.response?.data?.error?.message || error.message);
    return 'failed';
  }
}

/** Quita temas pendientes (ya se atendieron por otro lado). */
export async function dropStaffTopics(phone: string, topics: string[]) {
  const outbox = await readOutbox(phone);
  const rest = outbox.filter(q => !topics.some(t => q.topic === t || (t.endsWith('*') && q.topic.startsWith(t.slice(0, -1)))));
  if (rest.length !== outbox.length) await setConfig(outboxKey(phone), JSON.stringify(rest));
}

/** Manda lo que quedó pendiente mientras la ventana estaba cerrada (lo que ya no aplica no sale). */
export async function flushStaff(phone: string, now = new Date()) {
  const outbox = await readOutbox(phone);
  if (outbox.length === 0) return;
  await setConfig(outboxKey(phone), '[]');
  const fresh = outbox.filter(q => now.getTime() - new Date(q.at).getTime() < OUTBOX_DAYS * 86_400_000);
  for (const q of fresh) {
    try {
      for (const message of await build(q.topic, phone)) await deliver(phone, message);
    } catch (error: any) {
      console.error(`❌ No se pudo enviar lo pendiente (${q.topic}):`, error.response?.data?.error?.message || error.message);
    }
  }
}

// ---------- Quién es del equipo ----------

const phoneCache = new Map<string, { at: number; owner: string; marketing: string }>();

async function staffPhones(): Promise<{ owner: string; marketing: string }> {
  const key = currentTenant()?.businessId || 'velamia';
  const hit = phoneCache.get(key);
  if (hit && Date.now() - hit.at < 60_000) return hit;
  const [owner, settings] = await Promise.all([getOwnerPhone().catch(() => null), getSavedSettings().catch(() => null)]);
  const value = { at: Date.now(), owner: owner ? normalizePhone(owner) : '', marketing: settings?.marketingPhone ? normalizePhone(settings.marketingPhone) : '' };
  phoneCache.set(key, value);
  return value;
}

export async function marketingPhone(): Promise<string> {
  return (await staffPhones()).marketing;
}

export async function ownerPhone(): Promise<string> {
  return (await staffPhones()).owner;
}

/** Al cambiar el número de marketing se deja de usar el guardado un minuto. */
export function forgetStaffPhones() {
  phoneCache.delete(currentTenant()?.businessId || 'velamia');
}

const seen = new Set<string>();

/**
 * Mensaje entrante de la dueña o de marketing. Devuelve true si ya se atendió aquí (no va al bot de ventas). Lo de
 * marketing nunca va al bot de ventas; de la dueña solo se toman sus respuestas a los botones (así puede seguir
 * probando el bot desde su celular).
 */
export async function handleStaffInbound(message: any): Promise<boolean> {
  const phone = normalizePhone(String(message?.from || ''));
  if (!phone) return false;
  const { owner, marketing } = await staffPhones();
  const isOwner = !!owner && phone === owner;
  const isMarketing = !!marketing && phone === marketing;
  if (!isOwner && !isMarketing) return false;
  // Meta a veces repite el aviso del mismo mensaje: se atiende una sola vez.
  if (message?.id) {
    if (seen.has(message.id)) return true;
    seen.add(message.id);
    if (seen.size > 500) seen.delete(seen.values().next().value!);
  }
  await setConfig(inboundKey(phone), new Date().toISOString()).catch(() => {});
  const inbound: StaffInbound = {
    phone,
    replyId: String(message?.interactive?.button_reply?.id || message?.interactive?.list_reply?.id || message?.button?.payload || ''),
    text: String(message?.text?.body || message?.interactive?.button_reply?.title || message?.button?.text || '').trim(),
    isOwner,
    isMarketing
  };
  let handled = false;
  for (const handler of handlers) {
    try {
      if (await handler(inbound)) { handled = true; break; }
    } catch (error: any) {
      console.error('❌ Respuesta del equipo por WhatsApp:', error.message);
      await sendTextMessage(phone, `⚠️ No pude hacerlo: ${String(error.message || error).slice(0, 200)}`).catch(() => {});
      handled = true;
      break;
    }
  }
  await flushStaff(phone).catch(error => console.error('❌ Pendientes por WhatsApp:', error.message));
  return handled || isMarketing;
}
