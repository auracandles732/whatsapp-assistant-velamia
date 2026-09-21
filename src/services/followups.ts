import { sendTemplateMessage, getMessageTemplates, getSentMessageId } from './whatsapp';
import {
  getAllConversations,
  getConfig,
  saveMessage,
  parseDbTimestamp,
  getFollowUpActivity,
  getCustomerMessages,
  recordFollowUp,
  getActiveTenants
} from './supabase';
import { currentTenant, runWithTenant } from './tenant';
import { profile, hourLocal } from '../config/businessProfile';

/** Inicio del texto guardado de cada seguimiento: el CRM y la IA lo reconocen por esto. */
export const FOLLOW_UP_MARKER = '📩 Seguimiento automático';

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

/**
 * Decide qué seguimiento le toca a un chat. Sin efectos, para poder probarla.
 * sentSinceLast: fechas de seguimientos enviados después del último mensaje de la clienta.
 */
export function nextFollowUp(lastCustomerAt: Date, sentSinceLast: Date[], now: Date, steps: { template: string; days: number }[] = followUpSteps()) {
  const index = sentSinceLast.length;
  if (index >= steps.length) return null;

  const step = steps[index];
  if (now.getTime() - lastCustomerAt.getTime() < step.days * DAY_MS) return null;

  const lastSent = sentSinceLast[sentSinceLast.length - 1];
  if (lastSent && now.getTime() - lastSent.getTime() < MIN_GAP_MS) return null;

  return { index, ...step };
}

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
    if (!conv.last_message_time) continue;
    if (conv.bot_paused_until && parseDbTimestamp(conv.bot_paused_until) > now) continue;
    if (activity.optedOut.has(conv.id) || activity.withOrder.has(conv.id)) continue;

    // last_message_time solo cambia con mensajes de la clienta: es su última respuesta.
    const lastCustomerAt = parseDbTimestamp(conv.last_message_time);
    if (now.getTime() - lastCustomerAt.getTime() > maxSilenceDays() * DAY_MS) continue;
    const sentSinceLast = (activity.followUps.get(conv.id) || [])
      .filter(date => date > lastCustomerAt)
      .sort((a, b) => a.getTime() - b.getTime());

    const chatSteps = followUpStepsFor(activity.withQuotation.has(conv.id));
    const step = nextFollowUp(lastCustomerAt, sentSinceLast, now, chatSteps);
    if (!step) continue;

    // Solo a quien de verdad quiere algo: con cotización, o que dijo más que el saludo del anuncio.
    if (requireInterest && !activity.withQuotation.has(conv.id) && !(await showedInterest(conv.id))) continue;

    const template = templates.get(step.template);
    if (!template) {
      console.warn(`⚠️ Plantilla ${step.template} no está aprobada en Meta; no se envía seguimiento`);
      continue;
    }

    try {
      const response = await sendTemplateMessage(conv.phone_number, step.template, template.language);
      await saveMessage(conv.id, 'bot', 'text', `${FOLLOW_UP_MARKER} ${step.index + 1}/${chatSteps.length}\n${template.text}`, getSentMessageId(response));
      await recordFollowUp(conv.id, 'auto_followup', step.template);
      sent++;
    } catch (error: any) {
      console.error(`❌ No se pudo enviar seguimiento a ${conv.phone_number}:`, error.response?.data?.error?.message || error.message);
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
