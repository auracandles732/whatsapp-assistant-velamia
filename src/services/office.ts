import { supabase, getAllConversations, getConfig, parseDbTimestamp } from './supabase';
import { askJson } from './openai';
import { hasAddon, currentTenant } from './tenant';
import { profile } from '../config/businessProfile';
import { parseSocialAddress } from './metaChannels';
import { listLessons, createLesson, listReportDays, getReport } from './supervisor';
import { listPosts, pendingDrafts, getSavedSettings, DEFAULT_SETTINGS } from '../social/posts';
import { proposePlan } from '../social/planner';
import { askSocialJson } from '../social/ai';

/**
 * Oficina de Nexly: los agentes de la empresa como personajes. Cada uno muestra lo que está haciendo de verdad (con los
 * datos del CRM) y se le puede hablar: responde con lo que sabe y, si se le pide un cambio, lo propone para que la dueña
 * lo apruebe ("¿Lo aplico?"). Nada cambia sin ese sí. Sirve para cualquier empresa.
 */

export type OfficeAgent = 'seller' | 'social' | 'supervisor';
export const OFFICE_AGENTS: OfficeAgent[] = ['seller', 'social', 'supervisor'];
export type Channel = 'whatsapp' | 'instagram' | 'messenger';

export interface OfficeState {
  now: string;
  business: string;
  seller: {
    botOn: boolean;
    /** Qué hace: dormida (bot apagado), escribiendo, leyendo un mensaje nuevo o esperando. */
    mode: 'sleep' | 'typing' | 'reading' | 'idle';
    channel: Channel | null;
    customer: string;
    lastAt: string | null;
    chatsToday: number;
    /** Chats que atiende una persona del equipo (bot pausado ahí). */
    withTeam: number;
    /** Chats donde la clienta escribió último y nadie le respondió todavía. */
    waiting: number;
  };
  social: {
    available: boolean;
    mode: 'off' | 'publishing' | 'waiting' | 'planned' | 'idle';
    publishingNow: string;
    next: { at: string; theme: string; channels: string[] } | null;
    drafts: number;
    publishedToday: number;
    upcoming: number;
  };
  supervisor: {
    mode: 'lessons' | 'report' | 'idle';
    pendingLessons: number;
    lastReport: { day: string; chats: number; unanswered: number; problems: number; summary: string } | null;
  };
}

const channelOf = (phone: string): Channel => {
  const social = parseSocialAddress(phone);
  return social ? (social.channel === 'instagram' ? 'instagram' : 'messenger') : 'whatsapp';
};

/** Medianoche local de hoy (para "chats de hoy"). */
function startOfToday(tz: string, now: Date): Date {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(now);
  const get = (t: string) => Number(parts.find(p => p.type === t)?.value || 0);
  const minutes = (get('hour') % 24) * 60 + get('minute');
  return new Date(now.getTime() - minutes * 60_000 - now.getUTCSeconds() * 1000);
}

/** Qué está haciendo cada agente ahora. Pocas consultas: el CRM la pide cada 15 segundos con la oficina abierta. */
export async function officeState(now = new Date()): Promise<OfficeState> {
  const p = profile();
  const tz = p.business.timezone;
  const [conversations, botEnabled] = await Promise.all([getAllConversations(), getConfig('bot_enabled')]);
  const open = conversations.filter((c: any) => c.status !== 'closed');
  const today = startOfToday(tz, now).getTime();
  const recent = conversations.slice(0, 40);
  const names = new Map<string, any>(recent.map((c: any) => [c.id, c]));
  let messages: { conversation_id: string; sender: string; timestamp: string }[] = [];
  if (recent.length) {
    const { data } = await supabase.from('messages').select('conversation_id, sender, timestamp')
      .in('conversation_id', recent.map((c: any) => c.id))
      .gte('timestamp', new Date(now.getTime() - 6 * 3_600_000).toISOString())
      .order('timestamp', { ascending: false }).limit(200);
    messages = data || [];
  }
  const last = messages[0];
  const lastAt = last ? parseDbTimestamp(last.timestamp).getTime() : 0;
  const lastConv = last ? names.get(last.conversation_id) : null;
  // La última palabra de cada chat: si es de la clienta y ya pasaron 3 minutos, está esperando.
  const lastByChat = new Map<string, { sender: string; at: number }>();
  for (const m of messages) if (!lastByChat.has(m.conversation_id)) lastByChat.set(m.conversation_id, { sender: m.sender, at: parseDbTimestamp(m.timestamp).getTime() });
  const waiting = [...lastByChat.values()].filter(x => x.sender === 'customer' && now.getTime() - x.at > 3 * 60_000).length;
  const botOn = botEnabled !== 'false';
  const fresh = now.getTime() - lastAt < 2 * 60_000;
  const seller: OfficeState['seller'] = {
    botOn,
    mode: !botOn ? 'sleep' : fresh && last.sender === 'customer' ? 'reading' : fresh ? 'typing' : 'idle',
    channel: lastConv ? channelOf(lastConv.phone_number) : null,
    customer: lastConv ? String(lastConv.customer_name || '').trim().split(/\s+/)[0].slice(0, 20) : '',
    lastAt: last ? new Date(lastAt).toISOString() : null,
    chatsToday: conversations.filter((c: any) => c.last_message_time && parseDbTimestamp(c.last_message_time).getTime() >= today).length,
    withTeam: open.filter((c: any) => c.bot_paused_until && parseDbTimestamp(c.bot_paused_until) > now).length,
    waiting
  };

  const social: OfficeState['social'] = { available: hasAddon('publicaciones'), mode: 'off', publishingNow: '', next: null, drafts: 0, publishedToday: 0, upcoming: 0 };
  if (social.available) {
    const [posts, drafts] = await Promise.all([
      listPosts(new Date(today).toISOString(), new Date(now.getTime() + 7 * 86_400_000).toISOString()).catch(() => []),
      pendingDrafts(now).catch(() => [])
    ]);
    const publishing = posts.find(x => x.status === 'publishing');
    const next = posts.filter(x => x.status === 'approved' && new Date(x.scheduled_at) > now).sort((a, b) => a.scheduled_at.localeCompare(b.scheduled_at))[0];
    social.publishingNow = publishing ? publishing.theme : '';
    social.next = next ? { at: next.scheduled_at, theme: next.theme, channels: next.channels } : null;
    social.drafts = drafts.length;
    social.publishedToday = posts.filter(x => ['published', 'partial'].includes(x.status)).length;
    social.upcoming = posts.filter(x => x.status === 'approved' && new Date(x.scheduled_at) > now).length;
    social.mode = publishing ? 'publishing' : drafts.length ? 'waiting' : next ? 'planned' : 'idle';
  }

  const [lessons, days] = await Promise.all([listLessons().catch(() => []), listReportDays().catch(() => [])]);
  const report = days[0] ? await getReport(days[0]).catch(() => null) : null;
  const pendingLessons = lessons.filter(l => l.status === 'pending').length;
  const lastReport = report ? {
    day: report.day, chats: report.metrics.chats, unanswered: report.metrics.unanswered.length,
    problems: report.problems.length, summary: report.summary.slice(0, 300)
  } : null;
  return {
    now: now.toISOString(),
    business: p.business.name,
    seller,
    social,
    supervisor: {
      mode: pendingLessons ? 'lessons' : lastReport && (lastReport.unanswered || lastReport.problems) ? 'report' : 'idle',
      pendingLessons,
      lastReport
    }
  };
}

// ---------- Hablar con un agente ----------

export type OfficeAction =
  | { type: 'teach'; situation: string; answer: string; always: boolean }
  | { type: 'plan'; request: string; days: number };

export interface OfficeReply { reply: string; action: OfficeAction | null; actionText: string }

export interface OfficeTurn { from: 'owner' | 'agent'; text: string }

const ROLES: Record<OfficeAgent, string> = {
  seller: 'Eres la vendedora: el asistente que atiende a los clientes por WhatsApp, Instagram y Messenger.',
  social: 'Eres el agente de redes: preparas y publicas las publicaciones e historias de Instagram y Facebook.',
  supervisor: 'Eres el supervisor: revisas los chats del asistente, haces el reporte del día y propones aprendizajes.'
};

const ACTIONS: Record<OfficeAgent, string> = {
  seller: 'Si la dueña te enseña algo o te da una indicación para atender a los clientes, propón la acción "teach": situation = cuándo aplica '
    + '(una frase corta, sin empezar con "cuando"), answer = qué debes hacer o responder, always = false (true solo si ella dice que es para todos los chats). No inventes precios ni datos.',
  social: 'Si la dueña pide algo para las publicaciones (más de una categoría, menos de otra, un tema para un día, que planifiques), propón la acción '
    + '"plan": request = su pedido en una frase clara (por ejemplo "más bautizos y sin Halloween"), days = 2 (hoy y mañana), 8 (próxima semana) o 15 (dos semanas).',
  supervisor: 'Tú no cambias nada: respondes sobre el reporte y los aprendizajes. Si te piden enseñarle algo al asistente, di que se lo digan a la vendedora.'
};

const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['respuesta', 'accion'],
  properties: {
    respuesta: { type: 'string' },
    accion: {
      type: 'object',
      additionalProperties: false,
      required: ['tipo', 'situation', 'answer', 'always', 'request', 'days'],
      properties: {
        tipo: { type: 'string', enum: ['ninguna', 'teach', 'plan'] },
        situation: { type: 'string' },
        answer: { type: 'string' },
        always: { type: 'boolean' },
        request: { type: 'string' },
        days: { type: 'integer' }
      }
    }
  }
};

/** Qué sabe cada agente de su trabajo (en palabras, para la IA). */
export function stateText(agent: OfficeAgent, s: OfficeState): string {
  if (agent === 'seller') {
    const x = s.seller;
    return [
      `Bot ${x.botOn ? 'encendido' : 'APAGADO (no responde a nadie)'}.`,
      `Chats con mensajes hoy: ${x.chatsToday}. Esperando respuesta: ${x.waiting}. Atendidos por una persona del equipo (bot pausado): ${x.withTeam}.`,
      x.lastAt ? `Último movimiento: ${x.channel} con ${x.customer || 'un cliente'} a las ${x.lastAt}.` : 'Sin movimiento en las últimas horas.'
    ].join(' ');
  }
  if (agent === 'social') {
    const x = s.social;
    if (!x.available) return 'Publicaciones en redes no está activado para esta empresa.';
    return [
      x.publishingNow ? `Publicando ahora: ${x.publishingNow}.` : '',
      `Publicadas hoy: ${x.publishedToday}. Programadas próximos 7 días: ${x.upcoming}. Esperando aprobación: ${x.drafts}.`,
      x.next ? `La próxima: ${x.next.theme} el ${x.next.at} en ${x.next.channels.join(', ')}.` : 'No hay nada programado.'
    ].filter(Boolean).join(' ');
  }
  const x = s.supervisor;
  return [
    `Aprendizajes por aprobar: ${x.pendingLessons}.`,
    x.lastReport ? `Último reporte (${x.lastReport.day}): ${x.lastReport.chats} chats, ${x.lastReport.unanswered} sin respuesta, ${x.lastReport.problems} problemas. ${x.lastReport.summary}` : 'Todavía no hay reportes.'
  ].join(' ');
}

/** La acción en palabras, para el botón "¿Lo aplico?". */
export function describeAction(action: OfficeAction): string {
  if (action.type === 'teach') return `Enseñarle al asistente. Cuándo: ${action.situation.replace(/^cuando\s+/i, '').replace(/[.\s]+$/, '')}. Qué hacer: ${action.answer}${action.always ? ' (en todas las conversaciones)' : ''}`;
  const when = action.days <= 2 ? 'de hoy y mañana' : action.days >= 15 ? 'de las próximas dos semanas' : 'de la próxima semana';
  return `Rehacer la planificación ${when} con tu pedido: "${action.request}". La vas a poder revisar antes de que salga.`;
}

/** Limpia lo que propone la IA: solo acciones que ese agente puede hacer y con datos completos. */
export function cleanAction(agent: OfficeAgent, raw: any): OfficeAction | null {
  const t = String(raw?.tipo || '');
  const text = (v: unknown, max: number) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
  if (agent === 'seller' && t === 'teach') {
    const situation = text(raw.situation, 140), answer = text(raw.answer, 400);
    return situation.length >= 5 && answer.length >= 5 ? { type: 'teach', situation, answer, always: raw.always === true } : null;
  }
  if (agent === 'social' && t === 'plan') {
    const request = text(raw.request, 300);
    const days = [2, 8, 15].includes(Number(raw.days)) ? Number(raw.days) : 8;
    return request.length >= 3 ? { type: 'plan', request, days } : null;
  }
  return null;
}

/** Sin IA (sin saldo o sin clave): el agente igual responde con lo que sabe y entiende pedidos simples. */
export function fallbackReply(agent: OfficeAgent, text: string, s: OfficeState, why: string): OfficeReply {
  const status = stateText(agent, s);
  if (agent === 'social' && s.social.available && text.trim().length >= 3) {
    const action: OfficeAction = { type: 'plan', request: text.trim().slice(0, 300), days: 8 };
    return { reply: `${why} Igual puedo rehacer la planificación con tu pedido (entiendo categorías como "más bautizos" o "sin Halloween"). ${status}`, action, actionText: describeAction(action) };
  }
  return { reply: `${why} Te cuento cómo voy: ${status}`, action: null, actionText: '' };
}

export async function talkToAgent(agent: OfficeAgent, text: string, history: OfficeTurn[] = [], now = new Date()): Promise<OfficeReply> {
  const s = await officeState(now);
  const message = String(text || '').trim().slice(0, 800);
  const p = profile();
  const system = [
    `${ROLES[agent]} Trabajas para ${p.business.name}${p.business.description ? `, ${p.business.description}` : ''}. Hablas con la dueña dentro de su oficina virtual.`,
    'Responde en español, corto (máximo 3 frases), cálido y concreto, con los datos reales de abajo. No inventes números ni cosas que no están.',
    ACTIONS[agent],
    'Si no hace falta ningún cambio, accion.tipo = "ninguna" y deja los demás campos vacíos (situation, answer, request = "", always = false, days = 8).',
    `\nASÍ VA TU TRABAJO AHORA (${s.now}):\n${stateText(agent, s)}`
  ].join('\n');
  const user = [
    ...history.slice(-6).map(t => `${t.from === 'owner' ? 'Dueña' : 'Tú'}: ${String(t.text || '').slice(0, 400)}`),
    `Dueña: ${message}`
  ].join('\n');
  try {
    const ask = { system, user, schemaName: 'oficina', schema: SCHEMA, maxTokens: 1200 };
    // El agente de redes piensa con su propia clave (nunca con la del asistente de mensajes).
    const result = agent === 'social' ? await askSocialJson<any>(ask) : await askJson<any>({ ...ask, purpose: 'oficina' });
    const action = cleanAction(agent, result?.accion);
    // "En todos los chats" solo si ella lo dijo: una regla para todo se le cuela al asistente en cada respuesta.
    if (action?.type === 'teach' && !/siempre|tod[oa]s|cualquier/i.test(message)) action.always = false;
    return { reply: String(result?.respuesta || '').trim().slice(0, 600) || 'Listo.', action, actionText: action ? describeAction(action) : '' };
  } catch (error: any) {
    const why = agent === 'social' ? 'Ahora no puedo pensar con la IA (revisa la clave o el tope en Publicaciones → Cerebro IA).' : 'Ahora no puedo pensar con la IA (puede que OpenAI no tenga saldo).';
    console.warn(`⚠️ Oficina (${agent}):`, error.message);
    return fallbackReply(agent, message, s, why);
  }
}

/** La dueña dijo "sí, aplícalo". Se vuelve a revisar todo aquí: lo que llega del navegador no se da por bueno. */
export async function applyAction(agent: OfficeAgent, raw: any, now = new Date()): Promise<string> {
  const action = cleanAction(agent, { ...raw, tipo: raw?.type });
  if (!action) throw new Error('Ese cambio no se puede aplicar');
  if (action.type === 'teach') {
    await createLesson({ situation: action.situation, answer: action.answer, always: action.always });
    return 'Aprendido ✅ El asistente ya lo usa (lo ves en CRM → Supervisor, donde puedes editarlo o quitarlo).';
  }
  if (!hasAddon('publicaciones')) throw new Error('Publicaciones en redes no está activado para esta empresa');
  const settings = (await getSavedSettings()) || DEFAULT_SETTINGS;
  const result = await proposePlan(now, settings, { days: action.days, replace: true, request: action.request });
  if (!result.created) return `No hice cambios: ${result.summary}`;
  const auto = settings.planMode === 'automatico';
  return `Listo ✅ Armé ${result.created} tanda(s). ${result.summary} ${auto ? 'Estás en modo automático: salen solas a su hora.' : 'Revísalas y apruébalas en Publicaciones.'}`.trim();
}

export const isOfficeAgent = (v: unknown): v is OfficeAgent => OFFICE_AGENTS.includes(v as OfficeAgent);
export const officeTenant = () => currentTenant()?.businessId || 'velamia';
