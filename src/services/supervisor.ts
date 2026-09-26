import { randomUUID } from 'crypto';
import {
  supabase, getConfig, setConfig, getAllConversations, getConversationHistory, getRecentMessages, getOrderRefs, getQuotationRefs,
  getActiveTenants, tenantOp, tenantValue, parseDbTimestamp, RecentMessage
} from './supabase';
import { costOf } from './aiPrices';
import { askJson } from './openai';
import { currentTenant, runWithTenant } from './tenant';
import { profile } from '../config/businessProfile';
import { localParts, zonedTime } from '../social/posts';
import { sendTextMessage } from './whatsapp';
import { registerStaffTopic, registerStaffReplies, notifyStaff, ownerPhone, StaffMessage } from './staffChat';

/**
 * Supervisor de los chats. Aprende de lo que respondió el equipo cuando el bot pasó el chat a una persona y cada día
 * revisa los chats y le deja a la dueña un reporte. Lo que aprende queda "por aprobar": nada llega al bot sin que la
 * dueña lo apruebe. Todo se guarda en la configuración del negocio (no hace falta otra tabla).
 */

export type LessonStatus = 'pending' | 'approved' | 'discarded';
export type LessonSource = 'pausa' | 'reporte' | 'manual';

export interface Lesson {
  id: string;
  /** Cuándo aplica: "Piden factura con RUC". */
  situation: string;
  /** Qué debe hacer o decir el asistente. */
  answer: string;
  /** Regla general del negocio: el bot la tiene presente siempre (si no, solo cuando el mensaje se parece). */
  always: boolean;
  status: LessonStatus;
  source: LessonSource;
  conversationId: string | null;
  customer: string;
  /** De dónde salió: lo que preguntó el cliente y lo que respondió el equipo. */
  evidence: string;
  createdAt: string;
  decidedAt: string | null;
}

export type ProblemType = 'respuesta_incorrecta' | 'venta_perdida' | 'no_respondio_la_pregunta' | 'repetitivo' | 'otro';

export interface Problem {
  conversationId: string;
  customer: string;
  type: ProblemType;
  detail: string;
  suggestion: string;
}

export interface DayMetrics {
  chats: number;
  newChats: number;
  customerMessages: number;
  /** Chats donde escribió alguien del equipo. */
  teamChats: number;
  /** Chats cuyo último mensaje es del cliente y nadie le respondió después. */
  unanswered: { conversationId: string; customer: string; since: string }[];
  /** Avisos a la dueña por tipo (pregunta que el bot no supo, reclamo, pago con tarjeta…). */
  handoffs: Record<string, number>;
  orders: number;
  quotations: number;
}

export interface DayReport {
  day: string;
  createdAt: string;
  metrics: DayMetrics;
  summary: string;
  recommendations: string[];
  problems: Problem[];
  lessonsCreated: number;
  reviewedChats: number;
  /** Si la revisión con IA no se pudo hacer (sin crédito, tope del día): los números igual salen. */
  aiError: string | null;
  attempts: number;
}

const LESSONS_KEY = 'supervisor_lessons';
const DONE_KEY = 'supervisor_done';
const REPORTS_KEY = 'supervisor_reports';
const reportKey = (day: string) => `supervisor_report_${day}`;

/** Tope diario de gasto del supervisor (US$): revisar chats nunca debe costar más que atenderlos. */
export const SUPERVISOR_DAILY_BUDGET = 0.25;
/** Un chat con el equipo se revisa cuando lleva este tiempo sin mensajes (la conversación ya se resolvió). */
const QUIET_MS = 2 * 60 * 60 * 1000;
const LOOKBACK_DAYS = 7;
const MAX_EPISODES_PER_RUN = 10;
const MAX_LESSONS = 400;
const REVIEW_EVERY_MS = 60 * 60 * 1000;
const CHECK_EVERY_MS = 15 * 60 * 1000;
/** El reporte del día anterior sale desde esta hora (la dueña lo ve en la mañana). */
const REPORT_HOUR = 6;
const REPORT_CHATS = 40;
const CHATS_PER_CALL = 6;

const DAY_MS = 86_400_000;
const tenantKey = () => currentTenant()?.businessId || 'velamia';
const nowIso = () => new Date().toISOString();

// ---------- Textos ----------

const STOP = new Set(('que con para por los las una uno unos unas del como pero mas muy esta este esto eso esa ese hay tiene tienen tengo '
  + 'quiero quisiera puedo puede pueden podria buenas buenos dias tardes noches hola gracias favor cliente clienta clientes asistente '
  + 'cuando donde cual cuales cuanto cuanta sus tus mis ella ellos usted ustedes son ser estar sea algo todo toda todos tambien '
  + 'entonces solo les nos ustedes van vas hace hacer quieren necesito necesita saber seria esa estos estas aqui alla ahi').split(' '));

/** Palabras con significado, sin tildes ni mayúsculas (para comparar frases parecidas). */
export function plainWords(text: string): string[] {
  return String(text || '').normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase()
    .split(/[^a-z0-9ñ]+/).filter(w => w.length >= 3 && !STOP.has(w));
}

// Raíz corta: "facturas", "factura" y "facturan" (o "pide" y "piden") cuentan como la misma palabra.
const roots = (text: string) => new Set(plainWords(text).map(w => w.slice(0, 4)));

function overlap(a: Set<string>, b: Set<string>): number {
  let n = 0;
  for (const w of a) if (b.has(w)) n++;
  return n;
}

/** ¿Dicen lo mismo? (para no proponer dos veces el mismo aprendizaje). */
export function sameSituation(a: string, b: string): boolean {
  const ra = roots(a);
  const rb = roots(b);
  if (ra.size === 0 || rb.size === 0) return false;
  return overlap(ra, rb) / Math.min(ra.size, rb.size) >= 0.7;
}

/** Sin teléfonos, correos ni espacios de más: un aprendizaje nunca guarda datos personales. */
export function cleanLessonText(value: unknown, max: number): string {
  return String(value ?? '')
    .replace(/[\w.+-]+@[\w-]+\.[\w.]+/g, '[correo]')
    .replace(/\+?\d[\d\s-]{7,}\d/g, '[número]')
    .replace(/\s+/g, ' ').trim().slice(0, max);
}

/**
 * Los aprendizajes aprobados que tienen que ver con lo que escribió el cliente (y los que aplican siempre). Así el bot
 * recibe solo 2 o 3 y no se llena de instrucciones.
 */
export function relevantLessons(lessons: Lesson[], customerText: string, max = 3): Lesson[] {
  const approved = lessons.filter(l => l.status === 'approved');
  const always = approved.filter(l => l.always).slice(0, 5);
  const words = roots(customerText);
  if (words.size === 0) return always;
  const scored = approved.filter(l => !l.always).map(l => {
    const situation = roots(l.situation);
    const hits = overlap(situation, words);
    const extra = overlap(roots(l.answer), words) * 0.25;
    const enough = hits >= 2 || (hits >= 1 && situation.size <= 2);
    return { l, score: enough ? hits + extra : 0 };
  }).filter(x => x.score > 0).sort((a, b) => b.score - a.score);
  return [...always, ...scored.slice(0, max).map(x => x.l)];
}

/** El bloque que recibe el bot en cada mensaje (vacío si no hay nada que aplique). */
export function lessonsContext(list: Lesson[]): string {
  if (list.length === 0) return '';
  return 'APRENDIZAJES QUE APROBÓ LA DUEÑA (así se resolvieron antes situaciones parecidas; síguelos solo si aplican a lo que '
    + 'pregunta el cliente, con tus palabras, y sin inventar precios, fechas ni datos que no estén en el catálogo o en estas reglas):\n'
    + list.map(l => `- Cuando ${l.situation.replace(/^cuando\s+/i, '')}: ${l.answer}`).join('\n');
}

/** Un mensaje del chat en una línea, como lo leería una persona. */
function lineOf(m: { sender: string; type: string; content: string | null }): string {
  const raw = String(m.content || '').replace(/[\u2060-\u2064]/g, '');
  const text = ['image', 'audio', 'document'].includes(m.type) ? raw.replace(/^https?:\/\/\S+\n?/, '').trim() : raw.trim();
  const media = m.type === 'image' ? '[foto] ' : m.type === 'audio' ? '[audio] ' : m.type === 'document' ? '[documento] ' : '';
  const who = m.sender === 'customer' ? 'Cliente' : m.sender === 'human' ? 'Equipo' : 'Asistente';
  const body = (media + text.replace(/\s+/g, ' ')).trim();
  return `${who}: ${[...body].slice(0, 400).join('') || '(vacío)'}`;
}

/** El chat como texto para el supervisor (los mensajes largos se recortan). */
export function transcript(messages: { sender: string; type: string; content: string | null }[]): string {
  return messages.map(lineOf).join('\n');
}

/**
 * Los números del día, sin IA: chats, clientes sin respuesta, avisos a la dueña, cotizaciones y pedidos.
 * messages trae los mensajes desde el inicio del día hasta ahora (para saber si alguien respondió después).
 */
export function dayMetrics(input: {
  start: Date; end: Date; now: Date;
  conversations: { id: string; phone_number?: string; customer_name?: string | null; created_at?: string | null }[];
  messages: RecentMessage[];
  notifications: { conversation_id: string; event_type: string; created_at: string }[];
  orders: { created_at: string }[];
  quotations: { created_at: string }[];
}): DayMetrics {
  const { start, end, now } = input;
  const inDay = (iso: string | null | undefined) => { if (!iso) return false; const t = parseDbTimestamp(iso).getTime(); return t >= start.getTime() && t < end.getTime(); };
  const byConv = new Map<string, RecentMessage[]>();
  for (const m of input.messages) byConv.set(m.conversation_id, [...(byConv.get(m.conversation_id) || []), m]);
  const nameOf = new Map(input.conversations.map(c => [c.id, String(c.customer_name || c.phone_number || 'Cliente')]));
  let chats = 0;
  let customerMessages = 0;
  let teamChats = 0;
  const unanswered: DayMetrics['unanswered'] = [];
  for (const [id, list] of byConv) {
    const sorted = [...list].sort((a, b) => parseDbTimestamp(a.timestamp).getTime() - parseDbTimestamp(b.timestamp).getTime());
    const today = sorted.filter(m => inDay(m.timestamp));
    const fromCustomer = today.filter(m => m.sender === 'customer').length;
    if (fromCustomer === 0) continue;
    chats++;
    customerMessages += fromCustomer;
    if (today.some(m => m.sender === 'human')) teamChats++;
    const last = sorted[sorted.length - 1];
    if (last.sender === 'customer' && now.getTime() - parseDbTimestamp(last.timestamp).getTime() >= 60 * 60 * 1000) {
      unanswered.push({ conversationId: id, customer: nameOf.get(id) || 'Cliente', since: parseDbTimestamp(last.timestamp).toISOString() });
    }
  }
  const handoffs: Record<string, number> = {};
  for (const n of input.notifications) if (inDay(n.created_at)) handoffs[n.event_type] = (handoffs[n.event_type] || 0) + 1;
  return {
    chats,
    newChats: input.conversations.filter(c => inDay(c.created_at)).length,
    customerMessages,
    teamChats,
    unanswered,
    handoffs,
    orders: input.orders.filter(o => inDay(o.created_at)).length,
    quotations: input.quotations.filter(q => inDay(q.created_at)).length
  };
}

/** Lo que propuso la IA, limpio y sin repetir lo que ya existe (aprobado, por aprobar o descartado). */
export function newLessonsFrom(raw: unknown, existing: Lesson[], meta: { source: LessonSource; conversationId?: string | null; customer?: string }, now = nowIso()): Lesson[] {
  const items = Array.isArray(raw) ? raw : [];
  const out: Lesson[] = [];
  for (const item of items) {
    if (out.length >= 3) break;
    const situation = cleanLessonText((item as any)?.situacion, 140);
    const answer = cleanLessonText((item as any)?.respuesta, 400);
    if (situation.length < 8 || answer.length < 8) continue;
    if ([...existing, ...out].some(l => sameSituation(l.situation, situation))) continue;
    out.push({
      id: randomUUID(), situation, answer, always: (item as any)?.alcance === 'siempre', status: 'pending', source: meta.source,
      conversationId: meta.conversationId || null, customer: cleanLessonText(meta.customer, 60),
      evidence: cleanLessonText((item as any)?.evidencia, 240), createdAt: now, decidedAt: null
    });
  }
  return out;
}

// ---------- Guardado ----------

async function readJson<T>(key: string, fallback: T): Promise<T> {
  try {
    const raw = await getConfig(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

const lessonCache = new Map<string, { at: number; list: Lesson[] }>();
const lessonQueues = new Map<string, Promise<unknown>>();

export async function listLessons(): Promise<Lesson[]> {
  const list = await readJson<Lesson[]>(LESSONS_KEY, []);
  return Array.isArray(list) ? list : [];
}

/** Cambia la lista de aprendizajes de a uno por vez (dos cambios al mismo tiempo no se pisan). */
function changeLessons<T>(fn: (list: Lesson[]) => T): Promise<T> {
  const key = tenantKey();
  const previous = lessonQueues.get(key) || Promise.resolve();
  const next = previous.catch(() => {}).then(async () => {
    const list = await listLessons();
    const result = fn(list);
    // Lo descartado más viejo se va primero si la lista crece demasiado.
    while (list.length > MAX_LESSONS) {
      const at = list.findIndex(l => l.status === 'discarded');
      list.splice(at >= 0 ? at : 0, 1);
    }
    await setConfig(LESSONS_KEY, JSON.stringify(list));
    lessonCache.delete(key);
    return result;
  });
  lessonQueues.set(key, next.catch(() => {}));
  return next;
}

/** Aprendizajes para el bot: se leen cada minuto como mucho (no en cada mensaje). */
async function cachedLessons(): Promise<Lesson[]> {
  const key = tenantKey();
  const hit = lessonCache.get(key);
  if (hit && Date.now() - hit.at < 60_000) return hit.list;
  const list = (await listLessons()).filter(l => l.status === 'approved');
  lessonCache.set(key, { at: Date.now(), list });
  return list;
}

/** Lo que el bot debe tener presente para responder este mensaje ('' si no hay nada que aplique). */
export async function lessonsForTurn(customerText: string): Promise<string> {
  return lessonsContext(relevantLessons(await cachedLessons(), customerText));
}

export async function addLessons(list: Lesson[]): Promise<number> {
  if (list.length === 0) return 0;
  return changeLessons(all => {
    const fresh = list.filter(l => !all.some(x => sameSituation(x.situation, l.situation)));
    all.push(...fresh);
    return fresh.length;
  });
}

export class LessonNotFound extends Error {}

export async function decideLesson(id: string, change: { status?: LessonStatus; situation?: unknown; answer?: unknown; always?: unknown }): Promise<Lesson> {
  return changeLessons(all => {
    const lesson = all.find(l => l.id === id);
    if (!lesson) throw new LessonNotFound('Ese aprendizaje ya no existe');
    if (change.situation !== undefined) {
      const situation = cleanLessonText(change.situation, 140);
      if (situation.length < 5) throw new Error('Escribe cuándo aplica (la situación)');
      lesson.situation = situation;
    }
    if (change.answer !== undefined) {
      const answer = cleanLessonText(change.answer, 400);
      if (answer.length < 5) throw new Error('Escribe qué debe responder el asistente');
      lesson.answer = answer;
    }
    if (change.always !== undefined) lesson.always = change.always === true;
    if (change.status && change.status !== lesson.status) {
      lesson.status = change.status;
      lesson.decidedAt = nowIso();
    }
    return { ...lesson };
  });
}

export async function deleteLesson(id: string): Promise<void> {
  await changeLessons(all => {
    const at = all.findIndex(l => l.id === id);
    if (at < 0) throw new LessonNotFound('Ese aprendizaje ya no existe');
    all.splice(at, 1);
  });
}

/** Algo que la dueña le enseña directamente (queda aprobado). */
export async function createLesson(input: { situation?: unknown; answer?: unknown; always?: unknown }): Promise<Lesson> {
  const situation = cleanLessonText(input.situation, 140);
  const answer = cleanLessonText(input.answer, 400);
  if (situation.length < 5) throw new Error('Escribe cuándo aplica (la situación)');
  if (answer.length < 5) throw new Error('Escribe qué debe responder el asistente');
  const lesson: Lesson = {
    id: randomUUID(), situation, answer, always: input.always === true, status: 'approved', source: 'manual',
    conversationId: null, customer: '', evidence: '', createdAt: nowIso(), decidedAt: nowIso()
  };
  await changeLessons(all => { all.push(lesson); });
  return lesson;
}

// ---------- Gasto ----------

export async function supervisorSpentToday(now = new Date()): Promise<number> {
  const tz = profile().business.timezone;
  const p = localParts(now, tz);
  const start = zonedTime(p.year, p.month, p.day, 0, 0, tz);
  const { data, error } = await supabase.from('ai_usage').select('model, input_tokens, cached_tokens, output_tokens')
    .eq('purpose', 'supervisor').filter('business_id', tenantOp(), tenantValue())
    .gte('created_at', start.toISOString()).limit(20000);
  if (error) throw new Error(`Error leyendo el consumo del supervisor: ${error.message}`);
  return Math.round((data || []).reduce((sum, row) => sum + costOf(row as any), 0) * 1000) / 1000;
}

class BudgetReached extends Error {}

async function checkBudget() {
  if ((await supervisorSpentToday().catch(() => 0)) >= SUPERVISOR_DAILY_BUDGET) {
    throw new BudgetReached(`El supervisor llegó a su tope de hoy (US$${SUPERVISOR_DAILY_BUDGET.toFixed(2)}): sigue mañana`);
  }
}

// ---------- Aprender de lo que respondió el equipo ----------

const LESSON_ITEM = {
  type: 'object',
  additionalProperties: false,
  required: ['situacion', 'respuesta', 'evidencia', 'alcance'],
  properties: {
    situacion: { type: 'string' },
    respuesta: { type: 'string' },
    evidencia: { type: 'string' },
    alcance: { type: 'string', enum: ['cuando_aplique', 'siempre'] }
  }
};

const LESSON_RULES = [
  'Qué SÍ es un aprendizaje: algo que sirve para otros clientes: cómo responder una pregunta que el asistente no supo, una política o dato del negocio (horarios, facturas, envíos, formas de pago, personalizaciones posibles, tiempos), o la forma en que el equipo resolvió un problema o un reclamo.',
  'Qué NO es un aprendizaje: descuentos, regalos o favores a un cliente puntual; precios o productos (el catálogo ya los tiene); el estado de un pedido específico; fechas o promesas de un caso; datos personales (nombres, teléfonos, direcciones, cuentas); saludos o seguimientos normales.',
  'situacion: cuándo aplica, en una frase corta y general (máximo 120 caracteres), por ejemplo "El cliente pide factura con RUC".',
  'respuesta: qué debe hacer o decir el asistente, como instrucción clara en tercera persona (máximo 300 caracteres), por ejemplo "Pedir razón social, RUC y correo, y confirmar que la factura se envía con el pedido".',
  'evidencia: cita corta de lo que preguntó el cliente y lo que respondió el equipo (máximo 200 caracteres), sin datos personales.',
  'alcance: "siempre" solo si es una regla general del negocio que el asistente debe tener presente en todos los chats; si no, "cuando_aplique".',
  'No repitas ningún aprendizaje de la lista de los que ya existen. Si no hay nada nuevo que aprender, devuelve la lista vacía: es mejor nada que un aprendizaje dudoso.'
].map(r => `- ${r}`).join('\n');

function existingText(lessons: Lesson[]): string {
  const list = lessons.filter(l => l.status !== 'discarded').slice(-60).map(l => `- ${l.situation}`);
  return list.length ? list.join('\n') : '(ninguno)';
}

const doneStore = async () => readJson<Record<string, string>>(DONE_KEY, {});

/**
 * Revisa los chats donde escribió alguien del equipo (después de una alerta o tomando el chat) y que ya se calmaron,
 * y propone aprendizajes para aprobar. Cada chat se revisa una sola vez por cada intervención del equipo.
 */
export async function reviewHandoffs(now = new Date()): Promise<{ reviewed: number; created: number; skipped?: string }> {
  const since = new Date(now.getTime() - LOOKBACK_DAYS * DAY_MS).toISOString();
  const conversations = (await getAllConversations()).filter((c: any) => c.last_message_time && parseDbTimestamp(c.last_message_time).toISOString() >= since);
  if (conversations.length === 0) return { reviewed: 0, created: 0 };
  const names = new Map<string, string>(conversations.map((c: any) => [c.id, String(c.customer_name || '')]));
  const ids = conversations.map((c: any) => c.id as string);
  const newestHuman = new Map<string, string>();
  for (let i = 0; i < ids.length; i += 60) {
    const { data, error } = await supabase.from('messages').select('conversation_id, timestamp')
      .in('conversation_id', ids.slice(i, i + 60)).eq('sender', 'human').gte('timestamp', since).limit(5000);
    if (error) throw new Error(`Error leyendo las respuestas del equipo: ${error.message}`);
    for (const row of data || []) {
      const at = parseDbTimestamp(row.timestamp).toISOString();
      if (at > (newestHuman.get(row.conversation_id) || '')) newestHuman.set(row.conversation_id, at);
    }
  }
  const done = await doneStore();
  const candidates = [...newestHuman.entries()].filter(([id, at]) => at > (done[id] || '')).sort((a, b) => a[1].localeCompare(b[1]));
  if (candidates.length === 0) return { reviewed: 0, created: 0 };
  await checkBudget();

  let reviewed = 0;
  let created = 0;
  for (const [conversationId, lastHuman] of candidates.slice(0, MAX_EPISODES_PER_RUN)) {
    const history = await getConversationHistory(conversationId, 80);
    const last = history[history.length - 1];
    // Todavía están conversando: se revisa cuando el chat se calme.
    if (!last || now.getTime() - parseDbTimestamp(last.timestamp).getTime() < QUIET_MS) continue;
    const after = done[conversationId] || since;
    const first = history.findIndex((m: any) => m.sender === 'human' && parseDbTimestamp(m.timestamp).toISOString() > after);
    const team = history.filter((m: any, i: number) => i >= first && m.sender === 'human');
    // Un "ok" o un emoji del equipo no enseña nada: no se gasta en revisarlo.
    if (first >= 0 && team.map((m: any) => String(m.content || '')).join(' ').replace(/\s+/g, '').length >= 15) {
      const start = Math.max(0, first - 14);
      const piece = history.slice(start, start + 45);
      const { data: alerts } = await supabase.from('notifications').select('event_type, message, created_at')
        .eq('conversation_id', conversationId).gte('created_at', since).order('created_at', { ascending: true }).limit(10);
      const alertText = (alerts || []).map(a => `- ${a.event_type}: ${String(a.message || '').replace(/\s+/g, ' ').slice(0, 160)}`).join('\n');
      const lessons = await listLessons();
      const result = await askJson<{ aprendizajes: unknown[] }>({
        purpose: 'supervisor',
        schemaName: 'aprendizajes_del_equipo',
        schema: { type: 'object', additionalProperties: false, required: ['aprendizajes'], properties: { aprendizajes: { type: 'array', items: LESSON_ITEM } } },
        system: `Eres el supervisor del asistente de ventas por WhatsApp de ${profile().business.name}. Te paso un chat donde una persona del equipo intervino (el asistente pasó el chat o el equipo lo tomó). `
          + 'Tu trabajo: sacar APRENDIZAJES para que el asistente resuelva solo una situación igual la próxima vez (0 a 3).\n' + LESSON_RULES,
        user: `AVISOS QUE EL ASISTENTE LE MANDÓ A LA DUEÑA EN ESTE CHAT:\n${alertText || '(ninguno)'}\n\nAPRENDIZAJES QUE YA EXISTEN:\n${existingText(lessons)}\n\nCHAT (los mensajes "Equipo" los escribió una persona):\n${transcript(piece)}`,
        maxTokens: 3000
      });
      created += await addLessons(newLessonsFrom(result.aprendizajes, lessons, { source: 'pausa', conversationId, customer: names.get(conversationId) || '' }));
      reviewed++;
    }
    done[conversationId] = lastHuman;
  }
  // Solo se recuerda lo de los últimos 30 días.
  const keepSince = new Date(now.getTime() - 30 * DAY_MS).toISOString();
  for (const [id, at] of Object.entries(done)) if (at < keepSince) delete done[id];
  await setConfig(DONE_KEY, JSON.stringify(done));
  return { reviewed, created };
}

// ---------- Reporte diario ----------

const REVIEW_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['notas', 'problemas', 'aprendizajes'],
  properties: {
    notas: { type: 'string' },
    problemas: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['chat', 'tipo', 'detalle', 'sugerencia'],
        properties: {
          chat: { type: 'integer' },
          tipo: { type: 'string', enum: ['respuesta_incorrecta', 'venta_perdida', 'no_respondio_la_pregunta', 'repetitivo', 'otro'] },
          detalle: { type: 'string' },
          sugerencia: { type: 'string' }
        }
      }
    },
    aprendizajes: { type: 'array', items: { ...LESSON_ITEM, required: [...LESSON_ITEM.required, 'chat'], properties: { ...LESSON_ITEM.properties, chat: { type: 'integer' } } } }
  }
};

const SUMMARY_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['resumen', 'recomendaciones'],
  properties: { resumen: { type: 'string' }, recomendaciones: { type: 'array', items: { type: 'string' } } }
};

export const HANDOFF_LABELS: Record<string, string> = {
  owner_question: 'preguntas que el bot no supo',
  complaint: 'reclamos',
  card_payment: 'pagos con tarjeta',
  payment_proof: 'comprobantes de pago',
  bot_error: 'errores del bot',
  urgent_date: 'fechas urgentes',
  custom_design_request: 'diseños fuera del catálogo',
  custom_design_new: 'diseños fuera del catálogo',
  new_order: 'pedidos nuevos',
  new_quotation: 'cotizaciones',
  order_updated: 'pedidos cambiados',
  bank_details_missing: 'faltan datos bancarios',
  not_customer: 'no eran clientes'
};

function dayBounds(day: string, tz: string) {
  const [y, m, d] = day.split('-').map(Number);
  const start = zonedTime(y, m, d, 0, 0, tz);
  const next = new Date(Date.UTC(y, m - 1, d + 1, 12));
  const end = zonedTime(next.getUTCFullYear(), next.getUTCMonth() + 1, next.getUTCDate(), 0, 0, tz);
  return { start, end };
}

export function localDayOf(date: Date, tz: string): string {
  const p = localParts(date, tz);
  return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
}

export async function getReport(day: string): Promise<DayReport | null> {
  return readJson<DayReport | null>(reportKey(day), null);
}

export async function listReportDays(): Promise<string[]> {
  const days = await readJson<string[]>(REPORTS_KEY, []);
  return Array.isArray(days) ? days : [];
}

/**
 * Arma el reporte de un día: los números (siempre, sin IA) y la revisión de los chats con IA (qué salió mal, ventas que
 * se cayeron, qué debería aprender el bot). Si la IA no está disponible, el reporte sale igual con los números.
 */
export async function buildDayReport(day: string, now = new Date()): Promise<DayReport> {
  const tz = profile().business.timezone;
  const { start, end } = dayBounds(day, tz);
  const [conversations, messages, orders, quotations] = await Promise.all([
    getAllConversations(),
    getRecentMessages(start.toISOString(), 5000),
    getOrderRefs(start.toISOString()),
    getQuotationRefs(start.toISOString())
  ]);
  const ids = [...new Set(messages.map(m => m.conversation_id))];
  const notifications: { conversation_id: string; event_type: string; created_at: string }[] = [];
  for (let i = 0; i < ids.length; i += 60) {
    const { data, error } = await supabase.from('notifications').select('conversation_id, event_type, created_at')
      .in('conversation_id', ids.slice(i, i + 60)).gte('created_at', start.toISOString()).lt('created_at', end.toISOString()).limit(5000);
    if (error) throw new Error(`Error leyendo los avisos: ${error.message}`);
    notifications.push(...(data || []));
  }
  const metrics = dayMetrics({ start, end, now, conversations, messages, notifications, orders, quotations });
  const previous = await getReport(day);
  const report: DayReport = {
    day, createdAt: now.toISOString(), metrics, summary: '', recommendations: [], problems: [], lessonsCreated: 0,
    reviewedChats: 0, aiError: null, attempts: (previous?.attempts || 0) + 1
  };

  // Los chats del día con más mensajes primero (los más importantes si hay que recortar).
  const names = new Map<string, string>(conversations.map((c: any) => [c.id, String(c.customer_name || c.phone_number || 'Cliente')]));
  const inDay = (m: RecentMessage) => { const t = parseDbTimestamp(m.timestamp).getTime(); return t >= start.getTime() && t < end.getTime(); };
  const byConv = new Map<string, RecentMessage[]>();
  for (const m of messages.filter(inDay)) byConv.set(m.conversation_id, [...(byConv.get(m.conversation_id) || []), m]);
  const chats = [...byConv.entries()]
    .filter(([, list]) => list.some(m => m.sender === 'customer'))
    .sort((a, b) => b[1].length - a[1].length)
    .slice(0, REPORT_CHATS)
    .map(([id, list]) => ({ id, customer: names.get(id) || 'Cliente', list: [...list].sort((a, b) => a.timestamp.localeCompare(b.timestamp)).slice(-30) }));

  if (chats.length > 0) {
    try {
      await checkBudget();
      const notes: string[] = [];
      let lessons = await listLessons();
      for (let i = 0; i < chats.length; i += CHATS_PER_CALL) {
        await checkBudget();
        const group = chats.slice(i, i + CHATS_PER_CALL);
        const result = await askJson<{ notas: string; problemas: any[]; aprendizajes: any[] }>({
          purpose: 'supervisor',
          schemaName: 'revision_de_chats',
          schema: REVIEW_SCHEMA,
          system: `Eres el supervisor del asistente de ventas por WhatsApp de ${profile().business.name}. Revisas los chats de un día para que la dueña sepa qué mejorar. `
            + 'Señala solo problemas reales y concretos: el asistente respondió algo incorrecto o contradictorio, no respondió lo que el cliente preguntó, repitió lo mismo, '
            + 'o un cliente interesado se fue sin comprar (por precio, demora, falta de respuesta o algo que no se le ofreció). No marques como problema los chats normales. '
            + '"chat" es el número del chat. detalle y sugerencia: una frase cada uno (máximo 200 caracteres), sin datos personales. '
            + 'notas: 1 o 2 frases sobre cómo fueron estos chats en general.\n'
            + 'APRENDIZAJES (opcional, 0 a 3): cuando el equipo resolvió algo que el asistente debería saber hacer solo.\n' + LESSON_RULES,
          user: `APRENDIZAJES QUE YA EXISTEN:\n${existingText(lessons)}\n\n`
            + group.map((c, k) => `=== CHAT ${k + 1} ===\n${transcript(c.list)}`).join('\n\n'),
          maxTokens: 5000
        });
        if (result.notas) notes.push(String(result.notas).slice(0, 400));
        for (const p of Array.isArray(result.problemas) ? result.problemas : []) {
          const chat = group[Number(p?.chat) - 1];
          if (!chat) continue;
          report.problems.push({
            conversationId: chat.id, customer: chat.customer, type: p.tipo,
            detail: cleanLessonText(p.detalle, 220), suggestion: cleanLessonText(p.sugerencia, 220)
          });
        }
        for (const item of Array.isArray(result.aprendizajes) ? result.aprendizajes : []) {
          const chat = group[Number(item?.chat) - 1];
          const fresh = newLessonsFrom([item], lessons, { source: 'reporte', conversationId: chat?.id || null, customer: chat?.customer || '' });
          const added = await addLessons(fresh);
          report.lessonsCreated += added;
          if (added) lessons = [...lessons, ...fresh];
        }
        report.reviewedChats += group.length;
      }
      const handoffs = Object.entries(metrics.handoffs).map(([k, n]) => `${HANDOFF_LABELS[k] || k}: ${n}`).join(', ') || 'ninguno';
      const final = await askJson<{ resumen: string; recomendaciones: string[] }>({
        purpose: 'supervisor',
        schemaName: 'resumen_del_dia',
        schema: SUMMARY_SCHEMA,
        system: 'Escribe para la dueña del negocio, en español sencillo y directo, el resumen del día de su asistente de WhatsApp. '
          + 'resumen: 2 a 4 frases (qué tal fue el día y lo más importante). recomendaciones: 0 a 3 acciones concretas para mejorar, una frase cada una.',
        user: `NÚMEROS DEL DÍA: ${metrics.chats} chats con mensajes de clientes (${metrics.newChats} nuevos), ${metrics.quotations} cotizaciones, ${metrics.orders} pedidos, `
          + `${metrics.unanswered.length} clientes sin respuesta, el equipo escribió en ${metrics.teamChats} chats. Avisos a la dueña: ${handoffs}.\n\n`
          + `NOTAS DE LA REVISIÓN:\n${notes.join('\n') || '(sin notas)'}\n\nPROBLEMAS ENCONTRADOS:\n${report.problems.map(p => `- ${p.type}: ${p.detail}`).join('\n') || '(ninguno)'}`,
        maxTokens: 1500
      });
      report.summary = cleanLessonText(final.resumen, 800);
      report.recommendations = (Array.isArray(final.recomendaciones) ? final.recomendaciones : []).map(r => cleanLessonText(r, 240)).filter(Boolean).slice(0, 3);
    } catch (error: any) {
      report.aiError = error instanceof BudgetReached ? error.message : explainAi(error);
    }
  }
  await setConfig(reportKey(day), JSON.stringify(report));
  const all = [...new Set([day, ...(await listReportDays())])].sort().reverse();
  const days = all.slice(0, 60);
  await setConfig(REPORTS_KEY, JSON.stringify(days));
  // Plazo de conservación: los reportes de hace más de 60 días (traen nombres de clientes) se borran.
  for (const old of all.slice(60)) await setConfig(reportKey(old), '').catch(() => {});
  return report;
}

function explainAi(error: any): string {
  const message = String(error?.message || error);
  if (/no credits|insufficient_quota|exceeded your current quota|billing/i.test(message)) return 'OpenAI no tiene saldo: recárgalo y el supervisor revisa los chats (los números de abajo sí están).';
  return `No se pudo revisar con IA: ${message.slice(0, 160)}`;
}

// ---------- Por WhatsApp a la dueña ----------

const NOTIFIED_KEY = 'supervisor_notified';
const SOURCE_TEXT: Record<LessonSource, string> = { pausa: 'de un chat que atendiste tú', reporte: 'del reporte diario', manual: 'escrito por ti' };
const WEEK_LONG = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];
const MONTHS_LONG = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];

function longDay(day: string): string {
  const [y, m, d] = day.split('-').map(Number);
  return `${WEEK_LONG[new Date(Date.UTC(y, m - 1, d, 12)).getUTCDay()]} ${d} de ${MONTHS_LONG[m - 1]}`;
}

/** Un aprendizaje con sus botones para aprobarlo o descartarlo desde WhatsApp. */
export function lessonMessage(l: Lesson): StaffMessage {
  return {
    kind: 'buttons',
    text: `🧠 *Aprendizaje por aprobar*\n\n*Cuando:* ${l.situation}\n*El asistente debe:* ${l.answer}${l.evidence ? `\n\n_“${l.evidence}”_` : ''}\n\n(${SOURCE_TEXT[l.source]}${l.customer ? ` · ${l.customer}` : ''}${l.always ? ' · 📌 siempre' : ''})`,
    buttons: [{ id: `sv:ok:${l.id}`, title: '✅ Aprobar' }, { id: `sv:no:${l.id}`, title: '✖ Descartar' }]
  };
}

/** El reporte del día en un mensaje de WhatsApp (el detalle queda en el CRM). Sin efectos, para probarlo. */
export function reportText(r: DayReport, pendingLessons = 0): string {
  const m = r.metrics;
  const alerts = Object.values(m.handoffs || {}).reduce((n, v) => n + v, 0);
  const names = m.unanswered.map(u => u.customer);
  const lines = [
    `📊 *Reporte del supervisor · ${longDay(r.day)}*`,
    '',
    `💬 ${m.chats} chats · ${m.unanswered.length} sin respuesta · ${alerts} avisos para ti · ${m.quotations} cotizaciones · ${m.orders} pedidos`,
    r.summary ? `\n🧑‍🏫 ${r.summary}` : '',
    r.recommendations.length ? `\n✅ *Qué mejorar*\n${r.recommendations.map(x => `• ${x}`).join('\n')}` : '',
    names.length ? `\n💬 *Quedaron sin respuesta:* ${names.slice(0, 6).join(', ')}${names.length > 6 ? ` y ${names.length - 6} más` : ''}` : '',
    r.problems.length ? `\n🔎 *Lo que encontró*\n${r.problems.slice(0, 5).map(p => `• ${p.customer}: ${p.detail}`).join('\n')}${r.problems.length > 5 ? `\n• y ${r.problems.length - 5} más` : ''}` : '',
    r.aiError ? `\n⚠️ ${r.aiError}` : '',
    pendingLessons ? `\n🧠 Tienes ${pendingLessons} aprendizaje${pendingLessons === 1 ? '' : 's'} por aprobar.` : '',
    '',
    'Detalle y chats en el CRM → Supervisor.'
  ];
  return lines.filter((line, i) => line !== '' || i === 1 || i === lines.length - 2).join('\n').slice(0, 3900);
}

/** Los aprendizajes por aprobar que todavía no se le mandaron por WhatsApp (se marcan como enviados). */
async function newLessonMessages(): Promise<StaffMessage[]> {
  const pending = (await listLessons()).filter(l => l.status === 'pending');
  const notified = new Set<string>(await readJson<string[]>(NOTIFIED_KEY, []));
  const fresh = pending.filter(l => !notified.has(l.id));
  if (fresh.length === 0) return [];
  const shown = fresh.slice(-5);
  const keep = new Set(pending.map(l => l.id));
  await setConfig(NOTIFIED_KEY, JSON.stringify([...[...notified].filter(id => keep.has(id)), ...shown.map(l => l.id)]));
  return [
    { kind: 'text', text: `🧑‍🏫 El supervisor aprendió ${shown.length === 1 ? 'algo' : `${shown.length} cosas`} de tus chats. Apruébalo para que el asistente lo use; si no sirve, descártalo:` },
    ...shown.map(lessonMessage),
    ...(pending.length > shown.length ? [{ kind: 'text' as const, text: `En total tienes ${pending.length} por aprobar en el CRM → Supervisor.` }] : [])
  ];
}

registerStaffTopic('sv:lessons', () => newLessonMessages());
registerStaffTopic('sv:report:', async topic => {
  const report = await getReport(topic.slice('sv:report:'.length));
  if (!report) return [];
  const pending = (await listLessons()).filter(l => l.status === 'pending').length;
  return [{ kind: 'text', text: reportText(report, pending) }, ...(await newLessonMessages())];
});

// Los botones "Aprobar" y "Descartar" de cada aprendizaje.
registerStaffReplies(async inbound => {
  const match = /^sv:(ok|no):([0-9a-f-]{36})$/i.exec(inbound.replyId);
  // Solo la dueña decide qué aprende el asistente.
  if (!match || !inbound.isOwner) return false;
  try {
    await decideLesson(match[2], { status: match[1] === 'ok' ? 'approved' : 'discarded' });
    await sendTextMessage(inbound.phone, match[1] === 'ok' ? '✅ Aprobado: el asistente ya lo usa cuando aplique.' : 'Descartado: el asistente no lo usará.');
  } catch (error) {
    if (!(error instanceof LessonNotFound)) throw error;
    await sendTextMessage(inbound.phone, 'Ese aprendizaje ya no existe (quizás lo quitaste en el CRM).');
  }
  return true;
});

async function tellOwner(topic: string, title: string, detail: string) {
  const phone = await ownerPhone();
  if (!phone) return;
  await notifyStaff(phone, topic, { title, who: 'Supervisor de chats', hint: 'Responde este mensaje para verlo y aprobarlo', detail });
}

// ---------- Revisión automática ----------

const lastReview = new Map<string, number>();

async function tickForCurrent(now: Date) {
  const key = tenantKey();
  if (now.getTime() - (lastReview.get(key) || 0) >= REVIEW_EVERY_MS) {
    lastReview.set(key, now.getTime());
    const result = await reviewHandoffs(now).catch(error => {
      if (!(error instanceof BudgetReached)) console.error('❌ Supervisor (aprendizajes):', error.message);
      return null;
    });
    if (result?.created) {
      console.log(`🧑‍🏫 Supervisor: ${result.created} aprendizaje(s) nuevo(s) por aprobar`);
      await tellOwner('sv:lessons', '🧠 El supervisor tiene aprendizajes para aprobar', `${result.created} nuevo(s) de los chats que atendiste`);
    }
  }
  const tz = profile().business.timezone;
  if (localParts(now, tz).hour < REPORT_HOUR) return;
  const yesterday = localDayOf(new Date(now.getTime() - DAY_MS), tz);
  const existing = await getReport(yesterday);
  // Si la IA falló (sin saldo), se reintenta cada 3 horas, hasta 4 veces.
  const retry = existing?.aiError && existing.attempts < 4 && now.getTime() - new Date(existing.createdAt).getTime() >= 3 * 60 * 60 * 1000;
  if (existing && !retry) return;
  const report = await buildDayReport(yesterday, now);
  console.log(`🧑‍🏫 Supervisor: reporte del ${yesterday} listo (${report.metrics.chats} chats, ${report.problems.length} problemas)`);
  // Se avisa la primera vez y cuando un reintento por fin pudo revisar con IA.
  if (!retry || !report.aiError) {
    await tellOwner(`sv:report:${yesterday}`, '📊 Tu reporte del día está listo', `${report.metrics.chats} chats · ${report.metrics.unanswered.length} sin respuesta · ${report.problems.length} cosas por mejorar`);
  }
}

let running = false;

/** VELAMIA y cada negocio activo, por separado: si uno falla, los demás siguen. */
export async function runSupervisor(now = new Date()) {
  if (running) return;
  running = true;
  try {
    await runWithTenant(undefined, () => tickForCurrent(now)).catch(error => console.error('❌ Supervisor de VELAMIA:', error.message));
    const tenants = await getActiveTenants().catch(() => []);
    for (const tenant of tenants) {
      await runWithTenant(tenant, () => tickForCurrent(now)).catch(error => console.error(`❌ Supervisor de ${tenant.name}:`, error.message));
    }
  } finally {
    running = false;
  }
}

export function startSupervisor() {
  const tick = () => { void runSupervisor(); };
  setTimeout(tick, 3 * 60 * 1000);
  setInterval(tick, CHECK_EVERY_MS);
  console.log('🧑‍🏫 Supervisor de chats activo (aprende de las respuestas del equipo y deja un reporte diario)');
}
