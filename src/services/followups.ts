import { sendTemplateMessage, getMessageTemplates, getSentMessageId } from './whatsapp';
import {
  getAllConversations,
  getConfig,
  saveMessage,
  parseDbTimestamp,
  getFollowUpActivity,
  getCustomerMessages,
  getConversationHistory,
  recordFollowUp,
  getActiveTenants
} from './supabase';
import { currentTenant, runWithTenant } from './tenant';
import { maskPhone } from './privacy';
import { isSocialAddress } from './metaChannels';
import { profile, hourLocal } from '../config/businessProfile';

/** Inicio del texto guardado de cada seguimiento: el CRM y la IA lo reconocen por esto. */
/**
 * Marca INVISIBLE al inicio de un seguimiento guardado: el sistema lo reconoce, pero ni el cliente ni el CRM ven ningún rótulo.
 * (Los seguimientos guardados antes decían "📩 Seguimiento automático" y se siguen reconociendo.)
 */
export const FOLLOW_UP_MARKER = '\u2063\u2063';
const OLD_FOLLOW_UP_LABEL = '📩 Seguimiento automático';

/** ¿Este mensaje guardado es un seguimiento enviado por el sistema? */
export function isFollowUpMessage(content: unknown): boolean {
  const text = String(content || '');
  return text.startsWith(FOLLOW_UP_MARKER) || text.startsWith(OLD_FOLLOW_UP_LABEL);
}

/** El texto del seguimiento tal como lo recibió el cliente, sin marcas. */
export function followUpText(content: unknown): string {
  const text = String(content || '');
  if (text.startsWith(FOLLOW_UP_MARKER)) return text.slice(FOLLOW_UP_MARKER.length).trim();
  return text.split('\n').slice(1).join('\n').trim();
}

/** Plantillas aprobadas en Meta y días sin respuesta de la clienta para enviar cada una (perfil del negocio). */
export const followUpSteps = () => profile().followUps.steps;

/**
 * Qué lista de seguimientos le toca a un chat: quien nunca recibió cotización no debe recibir
 * plantillas que hablan de "la cotización" o del pedido. Sin lista propia, todos usan la general.
 */
export function followUpStepsFor(hasQuotation: boolean, p = profile()) {
  const { steps, stepsNoQuote } = p.followUps;
  return !hasQuotation && stepsNoQuote.length > 0 ? stepsNoQuote : steps;
}

const DAY_MS = 24 * 60 * 60 * 1000;
// Tras un reinicio pueden "vencer" varios pasos a la vez: nunca dos seguimientos seguidos el mismo día.
const MIN_GAP_MS = 20 * 60 * 60 * 1000;
const CHECK_EVERY_MS = 15 * 60 * 1000;
const TEMPLATE_CACHE_MS = 30 * 60 * 1000;
// Pasado el último paso más una semana, ya no se escribe.
const maxSilenceDays = () => Math.max(0, ...followUpSteps().map(step => step.days), ...profile().followUps.stepsNoQuote.map(step => step.days)) + 7;
// Pedido reciente = la clienta ya compró, no se le insiste. Debe superar maxSilenceDays:
// si no, los seguimientos viejos saldrían de la consulta y la serie volvería a empezar.
const activityWindowDays = () => Math.max(60, maxSilenceDays() + 30);

type SentFollowUp = Date | { at: Date; template?: string };
const sentAt = (s: SentFollowUp) => (s instanceof Date ? s : s.at);

/**
 * Pasos que ya se pueden enviar, en orden: los que vienen después del último enviado y cuyos días ya pasaron.
 * Sin efectos, para poder probarla. sentSinceLast: seguimientos enviados después del último mensaje de la clienta.
 */
export function dueFollowUps(lastCustomerAt: Date, sentSinceLast: SentFollowUp[], now: Date, steps: { template: string; days: number }[] = followUpSteps()) {
  const lastSent = sentSinceLast.map(sentAt).sort((a, b) => a.getTime() - b.getTime()).pop();
  if (lastSent && now.getTime() - lastSent.getTime() < MIN_GAP_MS) return [];

  // El último paso enviado se reconoce por su plantilla; los registros viejos sin nombre cuentan por posición.
  const byName = sentSinceLast.map(s => (s instanceof Date ? -1 : steps.findIndex(step => step.template === s.template)));
  const lastIndex = Math.max(sentSinceLast.length - 1, ...byName);
  const silence = now.getTime() - lastCustomerAt.getTime();
  return steps
    .map((step, index) => ({ index, ...step }))
    .filter(step => step.index > lastIndex && silence >= step.days * DAY_MS);
}

/** El primer seguimiento que ya se puede enviar (sin mirar el contexto del chat). */
export function nextFollowUp(lastCustomerAt: Date, sentSinceLast: SentFollowUp[], now: Date, steps: { template: string; days: number }[] = followUpSteps()) {
  return dueFollowUps(lastCustomerAt, sentSinceLast, now, steps)[0] || null;
}

/** Lo que se sabe del chat para no enviar una plantilla que no aplica. */
export interface FollowUpContext {
  hasQuotation: boolean;
  /** Ya vio modelos (fotos o un modelo con su precio). */
  modelsShown: boolean;
  /** Ya dijo la fecha o el día de su evento. */
  eventDateKnown: boolean;
  /** Compra para su negocio o para revender: no hay "fecha de tu evento". */
  noEvent: boolean;
}

const DATE_SAID = /\d{1,2}\s*(de\s+)?(ene|feb|mar|abr|may|jun|jul|ago|sep|oct|nov|dic)|\d{1,2}\s*[/-]\s*\d{1,2}|(?<!\p{L})(hoy|mañana|lunes|martes|mi[eé]rcoles|jueves|viernes|s[aá]bado|domingo|pr[oó]xima semana|fin de mes)(?!\p{L})/iu;
const FOR_BUSINESS = /(para|mi|un|el)\s+(negocio|emprendimiento|local|tienda)|revend|reventa|por mayor|mayorista/i;

/** Lee el chat: qué vio y qué dijo la clienta. Sin efectos, para poder probarla. */
export function followUpContext(messages: { sender: string; type: string; content: string | null }[], hasQuotation: boolean): FollowUpContext {
  const customer = messages.filter(m => m.sender === 'customer').map(m => String(m.content || ''));
  const business = messages.filter(m => m.sender !== 'customer' && !isFollowUpMessage(m.content));
  return {
    hasQuotation,
    modelsShown: business.some(m => m.type === 'image' || /modelo:\*?\s*\S/i.test(String(m.content || ''))),
    // También cuenta si el asistente ya le dio la fecha de entrega calculada ("Entrega: 06/10/2026").
    eventDateKnown: customer.some(t => DATE_SAID.test(t)) || business.some(m => /\d{1,2}\/\d{1,2}\/\d{4}/.test(String(m.content || ''))),
    noEvent: customer.some(t => FOR_BUSINESS.test(t))
  };
}

/**
 * ¿Esta plantilla tiene sentido para el chat? Se decide por lo que dice su texto, así sirve para cualquier negocio:
 * no se pregunta la fecha a quien ya la dio, ni se habla de la cotización o de "cambiar de modelo" si nunca los vio.
 */
export function followUpFits(templateText: string, ctx: FollowUpContext): boolean {
  const text = templateText.toLowerCase();
  if (/cotizaci[oó]n|presupuesto/.test(text) && !ctx.hasQuotation) return false;
  if (/fecha/.test(text) && (ctx.eventDateKnown || ctx.noEvent)) return false;
  if (/(ajustar|cambiar|revisar|elegid|escogid)[^.?!]{0,40}(cantidad|modelo|opci[oó]n)|la cantidad/.test(text) && !ctx.modelsShown) return false;
  return true;
}

/** Etiqueta que deja el asistente en chats de proveedores, couriers y otros que no compran: nunca reciben seguimientos. */
export const NOT_CUSTOMER_TAG = 'No es cliente';
export const isNotCustomer = (tags: unknown) => Array.isArray(tags) && tags.some(t => String(t).trim().toLowerCase() === NOT_CUSTOMER_TAG.toLowerCase());

// Cada número de WhatsApp tiene sus propias plantillas aprobadas: se guardan aparte por negocio.
const templateCaches = new Map<string, { loadedAt: number; templates: Map<string, { language: string; text: string }> }>();

/** Plantillas aprobadas con su texto; se consulta a Meta para no enviar una rechazada o pausada. */
async function getApprovedTemplates() {
  const cacheKey = currentTenant()?.businessId || 'velamia';
  const templateCache = templateCaches.get(cacheKey);
  if (templateCache && Date.now() - templateCache.loadedAt < TEMPLATE_CACHE_MS) return templateCache.templates;

  const templates = new Map<string, { language: string; text: string }>();
  for (const t of await getMessageTemplates()) {
    if (t.status !== 'APPROVED') continue;
    const body = (t.components || []).find((c: any) => c.type === 'BODY');
    templates.set(t.name, { language: t.language, text: body?.text || '' });
  }

  templateCaches.set(cacheKey, { loadedAt: Date.now(), templates });
  return templates;
}

// No dicen qué busca la persona, así que no cuentan como interés: un saludo suelto, o el texto que Meta escribe al tocar un anuncio ("¡Hola! Quiero más información sobre esto").
const ONLY_GREETING = /^[\s¡!¿?.,]*(?:(?:hola|holi|hey|saludos|buenas(?:\s+(?:tardes|noches))?|buen(?:os)?\s+d[ií]as?)[\s¡!.,]*)+(?:(?:quiero|quisiera|necesito|me\s+gustar[ií]a)\s+(?:conseguir\s+|obtener\s+|recibir\s+)?(?:m[aá]s\s+)?informaci[oó]n(?:\s+sobre\s+(?:esto|esta|este|ello|eso))?)?[\s¡!.,]*$/i;

/** ¿Alguno de los mensajes del cliente dice algo más que un saludo? Fotos, audios y documentos siempre cuentan. */
export function hasRealInterest(messages: { type: string; content: string }[]): boolean {
  return messages.some(m => m.type !== 'text' || !ONLY_GREETING.test(m.content.trim()));
}

// Quien ya mostró interés no deja de tenerlo; el "todavía no" se vuelve a revisar cada rato por si escribe.
const interestCache = new Map<string, { interested: boolean; at: number }>();
const NOT_YET_RECHECK_MS = 30 * 60 * 1000;

async function showedInterest(conversationId: string): Promise<boolean> {
  const cached = interestCache.get(conversationId);
  if (cached && (cached.interested || Date.now() - cached.at < NOT_YET_RECHECK_MS)) return cached.interested;
  const interested = hasRealInterest(await getCustomerMessages(conversationId));
  interestCache.set(conversationId, { interested, at: Date.now() });
  return interested;
}

let running = false;

/** Revisa VELAMIA y luego cada negocio activo, cada uno con su número, sus plantillas y sus chats. */
export async function runFollowUps(now: Date = new Date()): Promise<{ sent: number; skipped?: string }> {
  if (running) return { sent: 0, skipped: 'revisión anterior en curso' };
  running = true;

  try {
    const velamia = await runWithTenant(undefined, () => runFollowUpsForCurrent(now));
    let sent = velamia.sent;

    let tenants: Awaited<ReturnType<typeof getActiveTenants>> = [];
    try {
      tenants = await getActiveTenants();
    } catch (error: any) {
      console.error('❌ No se pudieron leer los negocios para seguimientos:', error.message);
    }
    for (const tenant of tenants) {
      try {
        const result = await runWithTenant(tenant, () => runFollowUpsForCurrent(now));
        if (result.sent > 0) console.log(`📩 ${tenant.name}: ${result.sent} seguimiento(s)`);
        sent += result.sent;
      } catch (error: any) {
        // Un negocio con claves vencidas no debe frenar los seguimientos de los demás.
        console.error(`❌ Seguimientos de ${tenant.name}:`, error.message);
      }
    }

    return tenants.length ? { sent } : velamia;
  } finally {
    running = false;
  }
}

async function runFollowUpsForCurrent(now: Date): Promise<{ sent: number; skipped?: string }> {
  const { enabled, steps, stepsNoQuote, requireInterest, fromHour, untilHour } = profile().followUps;
  if (!enabled || (steps.length === 0 && stepsNoQuote.length === 0)) return { sent: 0, skipped: 'seguimientos desactivados en el perfil' };
  const hour = hourLocal(now);
  if (hour < fromHour || hour >= untilHour) return { sent: 0, skipped: 'fuera de horario' };
  if ((await getConfig('bot_enabled')) === 'false') return { sent: 0, skipped: 'bot apagado' };

  const [templates, conversations, activity] = await Promise.all([
    getApprovedTemplates(),
    getAllConversations(),
    getFollowUpActivity(activityWindowDays())
  ]);

  let sent = 0;
  for (const conv of conversations) {
    if (!conv.last_message_time || isSocialAddress(conv.phone_number)) continue;
    if (conv.bot_paused_until && parseDbTimestamp(conv.bot_paused_until) > now) continue;
    if (activity.optedOut.has(conv.id) || activity.withOrder.has(conv.id) || isNotCustomer(conv.tags)) continue;

    // last_message_time solo cambia con mensajes de la clienta: es su última respuesta.
    const lastCustomerAt = parseDbTimestamp(conv.last_message_time);
    if (now.getTime() - lastCustomerAt.getTime() > maxSilenceDays() * DAY_MS) continue;
    const sentSinceLast = (activity.followUps.get(conv.id) || [])
      .filter(sent => sent.at > lastCustomerAt)
      .sort((a, b) => a.at.getTime() - b.at.getTime());

    const hasQuotation = activity.withQuotation.has(conv.id);
    const due = dueFollowUps(lastCustomerAt, sentSinceLast, now, followUpStepsFor(hasQuotation));
    if (due.length === 0) continue;

    // Solo a quien de verdad quiere algo: con cotización, o que dijo más que el saludo del anuncio.
    if (requireInterest && !hasQuotation && !(await showedInterest(conv.id))) continue;

    // La primera plantilla que tenga sentido con lo que ya pasó en el chat; las que no aplican se saltan.
    const context = followUpContext(await getConversationHistory(conv.id, 80), hasQuotation);
    const step = due.find(s => {
      const approved = templates.get(s.template);
      if (!approved) console.warn(`⚠️ Plantilla ${s.template} no está aprobada en Meta; no se envía seguimiento`);
      return approved && followUpFits(approved.text, context);
    });
    if (!step) continue;
    const template = templates.get(step.template)!;

    try {
      const response = await sendTemplateMessage(conv.phone_number, step.template, template.language);
      await saveMessage(conv.id, 'bot', 'text', `${FOLLOW_UP_MARKER}${template.text}`, getSentMessageId(response));
      await recordFollowUp(conv.id, 'auto_followup', step.template);
      sent++;
    } catch (error: any) {
      console.error(`❌ No se pudo enviar seguimiento a ${maskPhone(conv.phone_number)}:`, error.response?.data?.error?.message || error.message);
    }
  }

  return { sent };
}

export function startFollowUpScheduler() {
  const tick = () => {
    runFollowUps()
      .then(result => {
        if (result.sent > 0) console.log(`📩 Seguimientos enviados: ${result.sent}`);
      })
      .catch(error => console.error('❌ Error en seguimientos automáticos:', error.message));
  };

  setTimeout(tick, 60 * 1000);
  setInterval(tick, CHECK_EVERY_MS);
  const { enabled, steps, fromHour, untilHour } = profile().followUps;
  console.log(enabled && steps.length
    ? `📩 Seguimientos automáticos activos (días ${steps.map(step => step.days).join(', ')} · ${fromHour}:00-${untilHour}:00)`
    : '📩 Seguimientos automáticos desactivados en el perfil del negocio');
}
