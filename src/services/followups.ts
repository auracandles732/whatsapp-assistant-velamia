import { sendTemplateMessage, getMessageTemplates, getSentMessageId } from './whatsapp';
import {
  getAllConversations,
  getConfig,
  saveMessage,
  parseDbTimestamp,
  getFollowUpActivity,
  recordFollowUp
} from './supabase';

/** Inicio del texto guardado de cada seguimiento: el CRM y la IA lo reconocen por esto. */
export const FOLLOW_UP_MARKER = '📩 Seguimiento automático';

/** Plantillas aprobadas en Meta y días sin respuesta de la clienta para enviar cada una. */
export const FOLLOW_UP_STEPS = [
  { template: 'velamia_seguimiento_01', days: 1 },
  { template: 'velamia_seguimiento_02', days: 2 },
  { template: 'velamia_seguimiento_03', days: 4 },
  { template: 'velamia_seguimiento_04_v2', days: 7 },
  { template: 'velamia_seguimiento_05_v2', days: 14 }
];

const DAY_MS = 24 * 60 * 60 * 1000;
const SEND_FROM_HOUR = 9;
const SEND_UNTIL_HOUR = 19;
// Tras un reinicio pueden "vencer" varios pasos a la vez: nunca dos seguimientos seguidos el mismo día.
const MIN_GAP_MS = 20 * 60 * 60 * 1000;
const CHECK_EVERY_MS = 15 * 60 * 1000;
const TEMPLATE_CACHE_MS = 30 * 60 * 1000;
// Pedido reciente = la clienta ya compró, no se le insiste.
const ACTIVITY_WINDOW_DAYS = 60;
// Pasado el último paso (14 días) más un margen, ya no se escribe. Debe ser menor que ACTIVITY_WINDOW_DAYS:
// si no, los seguimientos viejos saldrían de la consulta y la serie volvería a empezar.
const MAX_SILENCE_DAYS = 21;

export function hourInGuayaquil(date: Date): number {
  return Number(new Intl.DateTimeFormat('en-US', { timeZone: 'America/Guayaquil', hour: 'numeric', hourCycle: 'h23' }).format(date));
}

/**
 * Decide qué seguimiento le toca a un chat. Sin efectos, para poder probarla.
 * sentSinceLast: fechas de seguimientos enviados después del último mensaje de la clienta.
 */
export function nextFollowUp(lastCustomerAt: Date, sentSinceLast: Date[], now: Date) {
  const index = sentSinceLast.length;
  if (index >= FOLLOW_UP_STEPS.length) return null;

  const step = FOLLOW_UP_STEPS[index];
  if (now.getTime() - lastCustomerAt.getTime() < step.days * DAY_MS) return null;

  const lastSent = sentSinceLast[sentSinceLast.length - 1];
  if (lastSent && now.getTime() - lastSent.getTime() < MIN_GAP_MS) return null;

  return { index, ...step };
}

let templateCache: { loadedAt: number; templates: Map<string, { language: string; text: string }> } | null = null;

/** Plantillas aprobadas con su texto; se consulta a Meta para no enviar una rechazada o pausada. */
async function getApprovedTemplates() {
  if (templateCache && Date.now() - templateCache.loadedAt < TEMPLATE_CACHE_MS) return templateCache.templates;

  const templates = new Map<string, { language: string; text: string }>();
  for (const t of await getMessageTemplates()) {
    if (t.status !== 'APPROVED') continue;
    const body = (t.components || []).find((c: any) => c.type === 'BODY');
    templates.set(t.name, { language: t.language, text: body?.text || '' });
  }

  templateCache = { loadedAt: Date.now(), templates };
  return templates;
}

let running = false;

export async function runFollowUps(now: Date = new Date()): Promise<{ sent: number; skipped?: string }> {
  if (running) return { sent: 0, skipped: 'revisión anterior en curso' };
  running = true;

  try {
    const hour = hourInGuayaquil(now);
    if (hour < SEND_FROM_HOUR || hour >= SEND_UNTIL_HOUR) return { sent: 0, skipped: 'fuera de horario' };
    if ((await getConfig('bot_enabled')) === 'false') return { sent: 0, skipped: 'bot apagado' };

    const [templates, conversations, activity] = await Promise.all([
      getApprovedTemplates(),
      getAllConversations(),
      getFollowUpActivity(ACTIVITY_WINDOW_DAYS)
    ]);

    let sent = 0;
    for (const conv of conversations) {
      if (!conv.last_message_time) continue;
      if (conv.bot_paused_until && parseDbTimestamp(conv.bot_paused_until) > now) continue;
      if (activity.optedOut.has(conv.id) || activity.withOrder.has(conv.id)) continue;

      // last_message_time solo cambia con mensajes de la clienta: es su última respuesta.
      const lastCustomerAt = parseDbTimestamp(conv.last_message_time);
      if (now.getTime() - lastCustomerAt.getTime() > MAX_SILENCE_DAYS * DAY_MS) continue;
      const sentSinceLast = (activity.followUps.get(conv.id) || [])
        .filter(date => date > lastCustomerAt)
        .sort((a, b) => a.getTime() - b.getTime());

      const step = nextFollowUp(lastCustomerAt, sentSinceLast, now);
      if (!step) continue;

      const template = templates.get(step.template);
      if (!template) {
        console.warn(`⚠️ Plantilla ${step.template} no está aprobada en Meta; no se envía seguimiento`);
        continue;
      }

      try {
        const response = await sendTemplateMessage(conv.phone_number, step.template, template.language);
        await saveMessage(conv.id, 'bot', 'text', `${FOLLOW_UP_MARKER} ${step.index + 1}/${FOLLOW_UP_STEPS.length}\n${template.text}`, getSentMessageId(response));
        await recordFollowUp(conv.id, 'auto_followup', step.template);
        sent++;
      } catch (error: any) {
        console.error(`❌ No se pudo enviar seguimiento a ${conv.phone_number}:`, error.response?.data?.error?.message || error.message);
      }
    }

    return { sent };
  } finally {
    running = false;
  }
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
  console.log('📩 Seguimientos automáticos activos (1, 2, 4, 7 y 14 días · 9:00-19:00)');
}
