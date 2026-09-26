import { getConfig, setConfig } from '../services/supabase';
import { uploadBufferToStorage } from '../services/storage';
import { sendTextMessage, sendButtonsMessage } from '../services/whatsapp';
import { registerStaffTopic, registerStaffReplies, notifyStaff, dropStaffTopics, marketingPhone, StaffMessage } from '../services/staffChat';
import { profile } from '../config/businessProfile';
import { SocialPost, PublishingSettings, getSavedSettings, pendingDrafts, localParts, localDay, zonedTime, isStoryChannel, DEFAULT_SETTINGS } from './posts';
import { proposePlan, pendingPlan, approvePlan, rejectPlan } from './planner';
import { buildPlanPdf } from './planPdf';

/**
 * La planificación de contenido por WhatsApp con el departamento de marketing. Cada día a la hora elegida (22:00 si no
 * se cambió) le pregunta si planifica por día o por semana; con su respuesta arma la planificación y le manda el
 * resumen, el PDF con las fotos y los botones para aprobarla, pedir un cambio o rechazarla. Si responde en la noche se
 * planifica desde mañana; en la mañana, desde hoy. Por día vuelve a preguntar al día siguiente; por semana, el último día
 * de la semana planificada. Si hay una esperando respuesta, en lugar de preguntar se la recuerda (una vez al día).
 */

export type PlanChoice = 'dia' | 'semana';

interface ChatState {
  /** Último día en que se le preguntó (o se le recordó lo pendiente). */
  askedDay: string | null;
  mode: PlanChoice | null;
  /** Último día cubierto por lo aprobado: hasta ahí no se pregunta. */
  coveredUntil: string | null;
  /** Último día de la planificación que espera respuesta. */
  pendingUntil: string | null;
  /** Se le preguntó qué quiere cambiar: lo próximo que escriba es el pedido. */
  awaitingChange: boolean;
}

const STATE_KEY = 'social_marketing_chat';
/** Desde esta hora, lo que se planifica empieza mañana (en la noche ya no queda nada por publicar hoy). */
const EVENING_HOUR = 15;
const EMPTY: ChatState = { askedDay: null, mode: null, coveredUntil: null, pendingUntil: null, awaitingChange: false };

async function readState(): Promise<ChatState> {
  try {
    return { ...EMPTY, ...JSON.parse((await getConfig(STATE_KEY)) || '{}') };
  } catch {
    return { ...EMPTY };
  }
}

const writeState = (state: ChatState) => setConfig(STATE_KEY, JSON.stringify(state));

const approvalMode = (s: PublishingSettings | null) => !!s && (s.planMode === 'semanal' || s.planMode === 'diario');

/** Desde cuándo se planifica: en la tarde o noche, desde mañana a las 00:00; en la mañana, desde ahora. */
export function planStart(now: Date, timeZone: string): { from: Date; tomorrow: boolean } {
  const p = localParts(now, timeZone);
  if (p.hour < EVENING_HOUR) return { from: now, tomorrow: false };
  const next = new Date(Date.UTC(p.year, p.month - 1, p.day + 1, 12));
  return { from: zonedTime(next.getUTCFullYear(), next.getUTCMonth() + 1, next.getUTCDate(), 0, 0, timeZone), tomorrow: true };
}

const hourText = (hour: number) => `${hour > 12 ? hour - 12 : hour}:00 ${hour >= 12 ? (hour >= 19 ? 'de la noche' : 'de la tarde') : 'de la mañana'}`;

const plain = (text: string) => String(text || '').normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase().trim();

const WEEK = ['dom', 'lun', 'mar', 'mié', 'jue', 'vie', 'sáb'];
const WEEK_LONG = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];
const MONTHS = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];

/** "sábado 3 oct" de un día "2026-10-03". */
export function dayName(day: string): string {
  const [y, m, d] = day.split('-').map(Number);
  return `${WEEK_LONG[new Date(Date.UTC(y, m - 1, d, 12)).getUTCDay()]} ${d} ${MONTHS[m - 1]}`;
}

/** El resumen para WhatsApp: qué sale cada día, a qué hora, dónde y por qué. Sin efectos, para probarlo. */
export function planMessageText(posts: Pick<SocialPost, 'id' | 'scheduled_at' | 'theme' | 'products' | 'media' | 'channels'>[], summary: string, reasons: Record<string, string>, timeZone: string): string {
  const byDay = new Map<string, string[]>();
  let photos = 0;
  for (const post of [...posts].sort((a, b) => a.scheduled_at.localeCompare(b.scheduled_at))) {
    const p = localParts(new Date(post.scheduled_at), timeZone);
    const key = `*${WEEK[p.weekday]} ${p.day} ${MONTHS[p.month - 1]}*`;
    const n = (post.media && post.media.length) || post.products.length;
    photos += n;
    const where = post.channels.every(isStoryChannel) ? 'historias' : 'publicación';
    const why = String(reasons[post.id] || '').trim();
    const line = `• ${String(p.hour).padStart(2, '0')}:${String(p.minute).padStart(2, '0')} ${post.theme} · ${n} foto${n === 1 ? '' : 's'} en ${where}${why ? ` — ${why.slice(0, 70)}` : ''}`;
    byDay.set(key, [...(byDay.get(key) || []), line]);
  }
  return [
    '📅 *Planificación de contenido para aprobar*',
    `${posts.length} tanda${posts.length === 1 ? '' : 's'} · ${photos} fotos`,
    '',
    summary ? `🧠 ${summary}` : '',
    '',
    ...[...byDay.entries()].flatMap(([day, lines]) => [day, ...lines, '']),
    'Abajo te mando el PDF con las fotos de cada tanda. Si no la apruebas, no se publica nada.'
  ].filter((line, i, all) => line !== '' || (all[i - 1] !== '' && i > 0)).join('\n');
}

export type MarketingAnswer = PlanChoice | 'ok' | 'no' | 'skip' | 'pdf' | 'change' | null;

/**
 * Qué contesta marketing: la opción (1 = por día, 2 = semanal), aprobar, rechazar, cambiar algo o "hoy no". Lo que no
 * es ninguna de esas (por ejemplo "más bautizos") vuelve null: es un pedido para rehacer la planificación. "Sí" y "no"
 * solo cuentan si es todo lo que escribió ("sí, pero sin Halloween" es un cambio). Sin efectos, para probarlo.
 */
export function readMarketingReply(replyId: string, text: string, hasPending: boolean): MarketingAnswer {
  const t = plain(text).replace(/[^a-z0-9ñ\s]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (replyId === 'mk:dia') return 'dia';
  if (replyId === 'mk:semana') return 'semana';
  if (replyId === 'mk:ok') return 'ok';
  if (replyId === 'mk:no') return 'no';
  if (replyId === 'mk:cambiar') return 'change';
  if (replyId === 'mk:hoyno') return 'skip';
  if (replyId === 'mk:pdf' || /^(ver\s+)?(el\s+)?pdf$/.test(t)) return 'pdf';
  if (/^(1|uno)\b|^(por )?dia\b|^diari|^por dia/.test(t)) return 'dia';
  if (/^(2|dos)\b|^(la )?seman/.test(t)) return 'semana';
  const short = t.split(' ').length <= 4;
  if (short && /\b(hoy no|no hoy|manana|mas tarde|luego|despues)\b/.test(t)) return 'skip';
  // "Sí" o "no" solo si es todo lo que escribió (con "gracias" o "de acuerdo" de relleno).
  const words = t.split(' ').filter(Boolean);
  const only = (core: RegExp) => words.some(w => core.test(w)) && words.every(w => core.test(w) || /^(gracias|de|acuerdo|esta|bien|todo)$/.test(w));
  if (hasPending && only(/^(aprobad[oa]|apruebo|aprobar|aprueba|si|sii|ok|okay|dale|listo|perfecto|excelente|super|acuerdo|bien)$/)) return 'ok';
  if (hasPending && only(/^(rechazad[oa]|rechazo|rechazar|rechaza|no)$/)) return 'no';
  if (!hasPending && /^no( gracias)?$/.test(t)) return 'skip';
  if (/^(cambi|ajust|modific|corrig)\w*$/.test(t)) return 'change';
  return null;
}

/** Lo que pidió además de elegir ("2, con más bautizos" → "con más bautizos"; "1" → ""). */
export function extraRequest(text: string): string {
  const rest = String(text || '')
    .replace(/^\s*(1|2|uno|dos)(?![0-9])[\s.,:;)-]*/i, '')
    .replace(/^\s*(por\s+d[ií]a|diari[oa]|la\s+semanal|semanal|la\s+semana|semana)\b[\s.,:;-]*/i, '')
    .trim();
  return plain(rest).replace(/[^a-z]/g, '').length >= 4 ? rest.slice(0, 300) : '';
}

/** La pregunta de cada día: "mañana" si sale en la tarde o noche, "hoy" si sale en la mañana. */
export function questionText(tomorrow: boolean): string {
  return [
    '📅 *¿Hacemos la planificación de contenido?*',
    '',
    tomorrow ? '1️⃣ *Por día*: armo lo que sale mañana y mañana en la noche te vuelvo a preguntar.' : '1️⃣ *Por día*: armo lo que sale hoy y mañana te vuelvo a preguntar.',
    tomorrow ? '2️⃣ *Semanal*: armo la semana desde mañana y te pregunto de nuevo al terminarla.' : '2️⃣ *Semanal*: armo la semana completa y te pregunto de nuevo al terminarla.',
    '',
    'Toca un botón o responde 1 o 2. Si quieres algo especial, escríbelo junto, por ejemplo: *2, más bautizos y sin Halloween*.'
  ].join('\n');
}

const QUESTION_BUTTONS = [{ id: 'mk:dia', title: '1. Por día' }, { id: 'mk:semana', title: '2. Semanal' }, { id: 'mk:hoyno', title: 'Hoy no' }];

const PLAN_QUESTION = '¿Apruebas esta planificación? Si la apruebas, cada tanda sale sola a su hora. Si quieres cambiar algo, toca ✏️ o escríbeme qué (por ejemplo: más bautizos, sin Halloween, el sábado baby shower).';
const PLAN_BUTTONS = [{ id: 'mk:ok', title: '✅ Aprobar' }, { id: 'mk:cambiar', title: '✏️ Cambiar algo' }, { id: 'mk:no', title: '❌ Rechazar' }];

/** El resumen, el PDF y los botones de la planificación que espera respuesta (nada si no hay ninguna). */
async function planMessages(): Promise<StaffMessage[]> {
  const pending = await pendingPlan();
  if (pending.posts.length === 0) return [];
  const { business } = profile();
  const reasons = Object.fromEntries(pending.posts.map(p => [p.id, p.reason || '']));
  const messages: StaffMessage[] = [{ kind: 'text', text: planMessageText(pending.posts, pending.summary, reasons, business.timezone) }];
  try {
    const pdf = await buildPlanPdf({ business: business.name, posts: pending.posts, summary: pending.summary, tasks: pending.tasks, timeZone: business.timezone, now: new Date() });
    const url = await uploadBufferToStorage(pdf, 'application/pdf', 'product-images');
    const first = localDay(pending.posts.map(p => p.scheduled_at).sort()[0], business.timezone);
    messages.push({ kind: 'document', url, filename: `planificacion-${first}.pdf`, caption: '📄 Planificación con las fotos de cada tanda' });
  } catch (error: any) {
    console.error('❌ No se pudo armar el PDF para WhatsApp:', error.message);
  }
  messages.push({ kind: 'buttons', text: PLAN_QUESTION, buttons: PLAN_BUTTONS });
  return messages;
}

registerStaffTopic('mk:plan', () => planMessages());
registerStaffTopic('mk:ask', async () => ((await pendingDrafts()).length ? [] : [{ kind: 'buttons', text: questionText(planStart(new Date(), profile().business.timezone).tomorrow), buttons: QUESTION_BUTTONS }]));

const PLAN_ALERT = (n: number) => ({ title: '📅 Tienes una planificación de contenido por aprobar', who: 'Agente de redes', hint: 'Responde este mensaje para verla y aprobarla', detail: `${n} tanda${n === 1 ? '' : 's'} esperando tu respuesta` });

/** Le manda a marketing la planificación que espera respuesta (la del botón del CRM o la de su respuesta). */
export async function sendPlanToMarketing(choice?: PlanChoice): Promise<void> {
  const phone = await marketingPhone();
  if (!phone) return;
  const drafts = await pendingDrafts();
  if (drafts.length === 0) return;
  const tz = profile().business.timezone;
  const state = await readState();
  state.pendingUntil = localDay(drafts.map(d => d.scheduled_at).sort().reverse()[0], tz);
  if (choice) state.mode = choice;
  await writeState(state);
  await notifyStaff(phone, 'mk:plan', PLAN_ALERT(drafts.length));
}

/** Se aprobó o rechazó la planificación (por WhatsApp o en el CRM): hasta dónde queda cubierto el contenido. */
export async function markPlanDecision(decision: 'ok' | 'no'): Promise<void> {
  const state = await readState();
  if (decision === 'ok' && state.pendingUntil && (!state.coveredUntil || state.pendingUntil > state.coveredUntil)) state.coveredUntil = state.pendingUntil;
  state.pendingUntil = null;
  await writeState(state);
  const phone = await marketingPhone();
  if (phone) await dropStaffTopics(phone, ['mk:plan']);
}

const NEXT_ASK = (state: ChatState, hour: number) => (state.mode === 'semana' && state.coveredUntil
  ? `El ${dayName(state.coveredUntil)} a las ${hourText(hour)} te escribo para planificar lo que sigue.`
  : `Mañana a las ${hourText(hour)} te pregunto qué se sube después.`);

/**
 * Arma la planificación que eligió marketing (con lo que haya pedido, si pidió algo) y se la manda para aprobar. Con un
 * pedido sobre una que ya espera respuesta, la rehace en su lugar.
 */
async function planFromChat(choice: PlanChoice, phone: string, settings: PublishingSettings, request = '') {
  // Si el aviso no sale, igual se arma: lo importante es la planificación.
  const tz = profile().business.timezone;
  const { from, tomorrow } = planStart(new Date(), tz);
  const what = choice === 'dia' ? (tomorrow ? 'de mañana' : 'de hoy') : (tomorrow ? 'de la semana desde mañana' : 'de la semana');
  await sendTextMessage(phone, request ? `⏳ Rehago la planificación ${what} con lo que pediste…` : `⏳ Armando la planificación ${what}…`).catch(() => {});
  let result = await proposePlan(from, settings, { days: choice === 'dia' ? 1 : 7, replace: true, request });
  // Por día, si ese día ya no alcanza (ya completo o muy tarde), se arma el siguiente.
  if (result.created === 0 && choice === 'dia') result = await proposePlan(from, settings, { days: 2, replace: true, request });
  const now = from;
  const state = await readState();
  state.mode = choice;
  state.awaitingChange = false;
  if (result.created === 0) {
    state.coveredUntil = localDay(new Date(now.getTime() + (choice === 'dia' ? 0 : 6) * 86_400_000), tz);
    await writeState(state);
    await sendTextMessage(phone, `👌 Esos días ya tienen su contenido: no hay nada que planificar. ${NEXT_ASK(state, settings.marketingHour)}`);
    return;
  }
  await writeState(state);
  await dropStaffTopics(phone, ['mk:ask']);
  await sendPlanToMarketing(choice);
}

registerStaffReplies(async inbound => {
  if (!inbound.isMarketing) return false;
  const settings = (await getSavedSettings()) || DEFAULT_SETTINGS;
  const pending = (await pendingDrafts()).length > 0;
  const answer = readMarketingReply(inbound.replyId, inbound.text, pending);
  const phone = inbound.phone;
  const state = await readState();
  if (answer === 'dia' || answer === 'semana') {
    await planFromChat(answer, phone, settings, inbound.replyId ? '' : extraRequest(inbound.text));
    return true;
  }
  if (answer === 'change') {
    state.awaitingChange = true;
    await writeState(state);
    await sendTextMessage(phone, '✏️ Escríbeme qué quieres cambiar y rehago la planificación. Por ejemplo: *más bautizos*, *sin Halloween*, *el sábado baby shower* o *menos Navidad y más animales*.');
    return true;
  }
  // Un pedido escrito ("más bautizos, sin Halloween"): se rehace la que espera respuesta (o la que se iba a armar).
  const meaningful = plain(inbound.text).replace(/[^a-z]/g, '').length >= 6;
  if (answer === null && !inbound.replyId && meaningful && (pending || state.awaitingChange)) {
    await planFromChat(state.mode || 'semana', phone, settings, inbound.text.slice(0, 300));
    return true;
  }
  if (answer === 'ok') {
    const approved = await approvePlan();
    if (!approved) { await sendTextMessage(phone, 'No hay ninguna planificación esperando respuesta.'); return true; }
    await markPlanDecision('ok');
    await sendTextMessage(phone, `✅ Aprobada: ${approved} tanda${approved === 1 ? '' : 's'} programada${approved === 1 ? '' : 's'}. Salen solas a su hora. ${NEXT_ASK(await readState(), settings.marketingHour)}`);
    return true;
  }
  if (answer === 'no') {
    const rejected = await rejectPlan();
    await markPlanDecision('no');
    const after = await readState();
    after.awaitingChange = true;
    await writeState(after);
    await sendButtonsMessage(phone, `❌ Rechazada${rejected ? `: se descartaron ${rejected} tanda${rejected === 1 ? '' : 's'}` : ''} y no se publica nada de eso. ¿Armo otra? Elige 1 o 2, o escríbeme qué quieres (por ejemplo: más bautizos).`, QUESTION_BUTTONS);
    return true;
  }
  if (answer === 'skip') {
    await dropStaffTopics(phone, ['mk:ask']);
    await sendTextMessage(phone, 'Listo 👍 Mañana te pregunto de nuevo.');
    return true;
  }
  if (answer === 'pdf') {
    const messages = (await planMessages()).filter(m => m.kind === 'document');
    if (messages.length === 0) { await sendTextMessage(phone, 'No hay ninguna planificación esperando respuesta.'); return true; }
    await notifyStaff(phone, 'mk:plan', PLAN_ALERT((await pendingDrafts()).length));
    return true;
  }
  // Cualquier otra cosa: lo que se puede hacer desde aquí.
  if (pending) await sendButtonsMessage(phone, `Tienes una planificación esperando tu respuesta (escribe *pdf* para verla de nuevo). ${PLAN_QUESTION}`, PLAN_BUTTONS);
  else await sendButtonsMessage(phone, `Soy el agente de redes de ${profile().business.name} 🤖\n\n${questionText(planStart(new Date(), profile().business.timezone).tomorrow)}`, QUESTION_BUTTONS);
  return true;
});

/**
 * Revisión de cada hora: desde la hora elegida (22:00 si no se cambió) le pregunta a marketing, una vez al día, si
 * planifica por día o por semana, o le recuerda la planificación que espera respuesta. No pregunta mientras lo
 * aprobado cubre los días siguientes.
 */
export async function marketingTick(now = new Date(), settingsParam?: PublishingSettings | null): Promise<void> {
  const settings = settingsParam === undefined ? await getSavedSettings() : settingsParam;
  if (!approvalMode(settings)) return;
  const phone = await marketingPhone();
  if (!phone) return;
  const tz = profile().business.timezone;
  const hour = localParts(now, tz).hour;
  if (hour < (settings?.marketingHour || DEFAULT_SETTINGS.marketingHour)) return;
  const today = localDay(now, tz);
  const state = await readState();
  if (state.askedDay === today) return;
  const drafts = await pendingDrafts(now);
  // Lo aprobado cubre los días que vienen: se pregunta recién el último día cubierto (para planificar lo que sigue).
  if (drafts.length === 0 && state.coveredUntil && today < state.coveredUntil) return;
  state.askedDay = today;
  await writeState(state);
  if (drafts.length) await notifyStaff(phone, 'mk:plan', PLAN_ALERT(drafts.length));
  else await notifyStaff(phone, 'mk:ask', { title: '📅 ¿Hacemos la planificación de contenido?', who: 'Agente de redes', hint: 'Responde 1 = por día o 2 = semanal', detail: 'Te armo la planificación y te la mando para aprobar' });
}
