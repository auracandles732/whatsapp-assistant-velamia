import { supabase, getAllConversations, parseDbTimestamp, tenantOp, tenantValue, hasRecentNotification, getActiveTenants } from './supabase';
import { runWithTenant } from './tenant';
import { profile } from '../config/businessProfile';
import { notifyOwner, OwnerEvent } from './notifications';
import { isNotCustomer, isFollowUpMessage } from './followups';
import { UNDELIVERED_EVENT } from './delivery';
import { localParts } from '../social/posts';

/**
 * Lo que el supervisor calcula con reglas del CRM, sin IA (para todas las empresas):
 * - la etapa de cada clienta (fría, interesada, caliente, lista para pagar);
 * - el embudo de ventas (chats → interesadas → cotizaciones → pendiente de pago → pedidos → ventas);
 * - el rendimiento de los seguimientos (enviados, respondidos, que llevaron a cotización o a compra);
 * - las alertas en tiempo real (clienta lista para pagar o caliente esperando, cotización sin avance, pide hablar con
 *   una persona, mensaje importante no entregado). Reclamos, pagos con tarjeta y comprobantes ya avisaban al momento.
 */

export type Stage = 'frio' | 'interesado' | 'caliente' | 'listo_para_pagar';
export const STAGE_ORDER: Stage[] = ['frio', 'interesado', 'caliente', 'listo_para_pagar'];

const READY_TO_PAY = /d[oó]nde\s+(te\s+)?(pago|deposito|transfiero|cancelo)|c[oó]mo\s+(te\s+)?(pago|hago\s+el\s+pago|hago\s+el\s+pedido|realizo\s+el\s+pago|separo|reservo)|datos\s+(bancarios|de\s+(la\s+)?cuenta|de\s+pago|para\s+(el\s+)?(pago|transferir|depositar))|n[uú]mero\s+de\s+cuenta|quiero\s+(separar|reservar|hacer\s+el\s+pedido|pagar|comprar|confirmar)|te\s+(transfiero|deposito)|ya\s+(te\s+)?(transfer|deposit|pagu)|comprobante|link\s+de\s+pago|pagar\s+con\s+tarjeta|me\s+(los|las|lo|la)\s+llevo/i;
const HOT = /\b\d+\s*(docenas?|unidades|velas|velitas|invitados|personas|piezas|cajas)\b|\b(para\s+el|el\s+d[ií]a)\s+\d{1,2}\b|\d{1,2}\s*(de\s+)?(ene|feb|mar|abr|may|jun|jul|ago|sep|oct|nov|dic)|\d{1,2}\s*[/-]\s*\d{1,2}/i;
const INTERESTED = /precio|cu[aá]nto|cuesta|valor|costo|modelos?|dise[ñn]os?|cat[aá]logo|env[ií](o|os|an|as)|disponib|tienen|hacen|personaliz|me\s+interesa|quiero|necesito|cotiza/i;
const ASKS_PERSON = /hablar\s+con\s+(una\s+|un\s+|la\s+|el\s+)?(persona|asesor[ao]?|humano|alguien|due[ñn][ao]|encargad[ao]|vendedor[ao]?|gerente)|atenci[oó]n\s+(humana|personal)|(eres|es)\s+(un\s+)?(bot|robot|m[aá]quina|contestadora)|me\s+(pueden|puede|podr[ií]an?)\s+llamar|ll[aá]menme|n[uú]mero\s+(para|de)\s+llamar/i;
const COURTESY = /^[\s¡!.]*(ok|okay|oki|vale|gracias|muchas\s+gracias|mil\s+gracias|listo|perfecto|dale|bueno|genial|excelente|chevere|ch[eé]vere|👍|🙏|❤️|🤍|😊|🥰)+[\s!.]*$/i;

export interface ChatSignals { customerTexts: string[]; botSentPhotos: boolean; bankDetailsSent: boolean; hasQuotation: boolean; hasOrder: boolean }

/** La etapa de una clienta según lo que dijo y lo que ya pasó en el chat (sin IA). */
export function stageOf(s: ChatSignals): Stage {
  const said = s.customerTexts.join('\n');
  if (s.hasOrder || s.bankDetailsSent || READY_TO_PAY.test(said)) return 'listo_para_pagar';
  if (s.hasQuotation || HOT.test(said)) return 'caliente';
  if (s.botSentPhotos || INTERESTED.test(said)) return 'interesado';
  return 'frio';
}

export const asksForPerson = (text: string) => ASKS_PERSON.test(text);
export const isCourtesy = (text: string) => COURTESY.test(String(text || '').trim());

// ---------- Datos ----------

interface Msg { conversation_id: string; sender: string; type: string; content: string; timestamp: string; wa_message_id?: string | null }

async function messagesOf(ids: string[], sinceIso: string, untilIso?: string): Promise<Msg[]> {
  const rows: Msg[] = [];
  for (let i = 0; i < ids.length; i += 60) {
    let query = supabase.from('messages').select('conversation_id, sender, type, content, timestamp, wa_message_id')
      .in('conversation_id', ids.slice(i, i + 60)).gte('timestamp', sinceIso);
    if (untilIso) query = query.lt('timestamp', untilIso);
    const { data, error } = await query.order('timestamp', { ascending: true }).limit(5000);
    if (error) throw new Error(`Error leyendo mensajes: ${error.message}`);
    rows.push(...((data || []) as Msg[]));
  }
  return rows;
}

async function quotationsSince(sinceIso: string) {
  const { data, error } = await supabase.from('quotations').select('conversation_id, created_at, status')
    .filter('business_id', tenantOp(), tenantValue()).gte('created_at', sinceIso).limit(5000);
  if (error) throw new Error(`Error leyendo cotizaciones: ${error.message}`);
  return (data || []) as { conversation_id: string; created_at: string; status: string }[];
}

async function ordersSince(sinceIso: string) {
  const { data, error } = await supabase.from('orders').select('conversation_id, created_at, status')
    .filter('business_id', tenantOp(), tenantValue()).neq('status', 'cancelled').gte('created_at', sinceIso).limit(5000);
  if (error) throw new Error(`Error leyendo pedidos: ${error.message}`);
  return (data || []) as { conversation_id: string; created_at: string; status: string }[];
}

const PAID = new Set(['confirmed', 'shipped', 'delivered']);
const isBankDetails = (m: { sender: string; content: string }) => m.sender === 'bot' && String(m.content || '').startsWith('🏦');

// ---------- Embudo ----------

export interface Funnel {
  from: string; to: string;
  chats: number; interested: number; quotations: number; pendingPayment: number; orders: number; sales: number;
  /** Porcentajes sobre los chats (0 a 100, enteros). */
  rates: { quote: number; sale: number; quoteToSale: number };
  /** La etapa donde se pierden más clientas ('' si no hay datos). */
  biggestDrop: string;
}

export const FUNNEL_LABELS: Record<string, string> = {
  chats: 'chats', interested: 'interesadas', quotations: 'cotizaciones', pendingPayment: 'pendiente de pago', orders: 'pedidos', sales: 'ventas'
};

const pct = (a: number, b: number) => (b > 0 ? Math.round((a / b) * 100) : 0);

/** Arma el embudo a partir de las señales (sin consultas: para poder probarlo). Cada etapa incluye a las siguientes. */
export function funnelFrom(input: {
  from: string; to: string;
  chats: Set<string>; interested: Set<string>; quoted: Set<string>; readyToPay: Set<string>; ordered: Set<string>; paid: Set<string>;
}): Funnel {
  const sales = new Set(input.paid);
  const orders = new Set([...input.ordered, ...sales]);
  const pending = new Set([...input.readyToPay, ...orders]);
  const quotations = new Set([...input.quoted, ...pending]);
  const interested = new Set([...input.interested, ...quotations]);
  const chats = new Set([...input.chats, ...interested]);
  const steps: [string, number][] = [['chats', chats.size], ['interested', interested.size], ['quotations', quotations.size], ['pendingPayment', pending.size], ['orders', orders.size], ['sales', sales.size]];
  let biggestDrop = '';
  let worst = 0;
  for (let i = 1; i < steps.length; i++) {
    const lost = steps[i - 1][1] - steps[i][1];
    if (steps[i - 1][1] > 0 && lost > worst) { worst = lost; biggestDrop = `${FUNNEL_LABELS[steps[i - 1][0]]} → ${FUNNEL_LABELS[steps[i][0]]}`; }
  }
  return {
    from: input.from, to: input.to,
    chats: chats.size, interested: interested.size, quotations: quotations.size, pendingPayment: pending.size, orders: orders.size, sales: sales.size,
    rates: { quote: pct(quotations.size, chats.size), sale: pct(sales.size, chats.size), quoteToSale: pct(sales.size, quotations.size) },
    biggestDrop
  };
}

/** El embudo de un período (de la empresa en curso). */
export async function salesFunnel(from: Date, to: Date): Promise<Funnel> {
  const fromIso = from.toISOString(), toIso = to.toISOString();
  const conversations = (await getAllConversations()).filter((c: any) => !isNotCustomer(c.tags));
  const ids = conversations.map((c: any) => c.id as string);
  const known = new Set(ids);
  const [messages, quotations, orders] = await Promise.all([messagesOf(ids, fromIso, toIso), quotationsSince(fromIso), ordersSince(fromIso)]);
  const inRange = (iso: string) => { const t = parseDbTimestamp(iso).toISOString(); return t >= fromIso && t < toIso; };
  const byChat = new Map<string, Msg[]>();
  for (const m of messages) byChat.set(m.conversation_id, [...(byChat.get(m.conversation_id) || []), m]);
  const quoted = new Set(quotations.filter(q => known.has(q.conversation_id) && inRange(q.created_at)).map(q => q.conversation_id));
  const periodOrders = orders.filter(o => known.has(o.conversation_id) && inRange(o.created_at));
  const ordered = new Set(periodOrders.map(o => o.conversation_id));
  const paid = new Set(periodOrders.filter(o => PAID.has(o.status)).map(o => o.conversation_id));
  const chats = new Set<string>(), interested = new Set<string>(), readyToPay = new Set<string>();
  for (const [id, list] of byChat) {
    const customerTexts = list.filter(m => m.sender === 'customer').map(m => String(m.content || ''));
    if (customerTexts.length === 0) continue;
    chats.add(id);
    const stage = stageOf({
      customerTexts, botSentPhotos: list.some(m => m.sender === 'bot' && m.type === 'image'),
      bankDetailsSent: list.some(isBankDetails), hasQuotation: quoted.has(id), hasOrder: ordered.has(id)
    });
    if (stage !== 'frio') interested.add(id);
    if (stage === 'listo_para_pagar') readyToPay.add(id);
  }
  return funnelFrom({ from: fromIso, to: toIso, chats, interested, quoted, readyToPay, ordered, paid });
}

// ---------- Rendimiento de los seguimientos ----------

export interface FollowUpRow { template: string; sent: number; responded: number; quoted: number; bought: number }
export interface FollowUpStats { from: string; to: string; total: FollowUpRow; byTemplate: FollowUpRow[]; best: string }

const RESPONSE_DAYS = 3, QUOTE_DAYS = 7, BUY_DAYS = 14;

/** Cuenta, por plantilla, qué pasó después de cada seguimiento (sin consultas: para poder probarlo). */
export function followUpStatsFrom(input: {
  from: string; to: string;
  sent: { conversation_id: string; at: number; template: string }[];
  customerAt: Map<string, number[]>; quotesAt: Map<string, number[]>; ordersAt: Map<string, number[]>;
}): FollowUpStats {
  const rows = new Map<string, FollowUpRow>();
  const total: FollowUpRow = { template: 'Todos', sent: 0, responded: 0, quoted: 0, bought: 0 };
  const sorted = [...input.sent].sort((a, b) => a.at - b.at);
  sorted.forEach((f, i) => {
    const next = sorted.slice(i + 1).find(x => x.conversation_id === f.conversation_id)?.at ?? Infinity;
    const within = (list: number[] | undefined, days: number, limit = Infinity) => (list || []).some(t => t > f.at && t <= Math.min(f.at + days * 86_400_000, limit));
    const row = rows.get(f.template) || { template: f.template, sent: 0, responded: 0, quoted: 0, bought: 0 };
    const responded = within(input.customerAt.get(f.conversation_id), RESPONSE_DAYS, next);
    const quoted = within(input.quotesAt.get(f.conversation_id), QUOTE_DAYS);
    const bought = within(input.ordersAt.get(f.conversation_id), BUY_DAYS);
    for (const r of [row, total]) { r.sent++; if (responded) r.responded++; if (quoted) r.quoted++; if (bought) r.bought++; }
    rows.set(f.template, row);
  });
  const byTemplate = [...rows.values()].sort((a, b) => b.sent - a.sent);
  // La que más respuestas consigue, con al menos 3 envíos para que no sea casualidad.
  const best = byTemplate.filter(r => r.sent >= 3).sort((a, b) => (b.bought - a.bought) || (b.responded / b.sent - a.responded / a.sent))[0]?.template || '';
  return { from: input.from, to: input.to, total, byTemplate, best };
}

export async function followUpPerformance(from: Date, to: Date): Promise<FollowUpStats> {
  const fromIso = from.toISOString(), toIso = to.toISOString();
  const ids = (await getAllConversations()).map((c: any) => c.id as string);
  const sent: { conversation_id: string; at: number; template: string }[] = [];
  for (let i = 0; i < ids.length; i += 60) {
    const { data, error } = await supabase.from('followups').select('conversation_id, created_at, message')
      .in('conversation_id', ids.slice(i, i + 60)).eq('type', 'auto_followup').gte('created_at', fromIso).lt('created_at', toIso).limit(5000);
    if (error) throw new Error(`Error leyendo seguimientos: ${error.message}`);
    for (const r of data || []) sent.push({ conversation_id: r.conversation_id, at: parseDbTimestamp(r.created_at).getTime(), template: String(r.message || 'seguimiento') });
  }
  const chats = [...new Set(sent.map(s => s.conversation_id))];
  const until = new Date(Math.min(Date.now(), to.getTime() + BUY_DAYS * 86_400_000)).toISOString();
  const [messages, quotations, orders] = chats.length
    ? await Promise.all([messagesOf(chats, fromIso, until), quotationsSince(fromIso), ordersSince(fromIso)])
    : [[], [], []] as [Msg[], any[], any[]];
  const group = (list: { conversation_id: string; at: number }[]) => {
    const map = new Map<string, number[]>();
    for (const x of list) map.set(x.conversation_id, [...(map.get(x.conversation_id) || []), x.at]);
    return map;
  };
  return followUpStatsFrom({
    from: fromIso, to: toIso, sent,
    customerAt: group(messages.filter(m => m.sender === 'customer').map(m => ({ conversation_id: m.conversation_id, at: parseDbTimestamp(m.timestamp).getTime() }))),
    quotesAt: group(quotations.map((q: any) => ({ conversation_id: q.conversation_id, at: parseDbTimestamp(q.created_at).getTime() }))),
    ordersAt: group(orders.map((o: any) => ({ conversation_id: o.conversation_id, at: parseDbTimestamp(o.created_at).getTime() })))
  });
}

// ---------- Alertas en tiempo real ----------

export type WatchEvent = Extract<OwnerEvent, 'ready_to_pay_waiting' | 'hot_waiting' | 'quote_stalled' | 'asks_person' | 'undelivered_important'>;

/** Urgentes (a cualquier hora): la clienta quiere pagar y nadie le responde. Lo demás, de 8:00 a 20:00. */
export const URGENT_EVENTS: WatchEvent[] = ['ready_to_pay_waiting'];
export const WATCH_EVENTS: WatchEvent[] = ['ready_to_pay_waiting', 'hot_waiting', 'quote_stalled', 'asks_person', 'undelivered_important'];
export const WAIT_MINUTES = 15;
export const QUOTE_STALLED_HOURS = 24;
const ALERT_FROM_HOUR = 8, ALERT_UNTIL_HOUR = 20;

export interface WatchFinding { event: WatchEvent; conversationId: string; detail: string; /** Desde cuándo pasa (la espera empieza con el último mensaje de la clienta): se avisa una vez por cada espera. */ since?: number }

/**
 * Las reglas sobre un chat (sin consultas: para poder probarlas). messages en orden, de las últimas 48 horas.
 */
export function watchChat(input: {
  conversationId: string; messages: { sender: string; type: string; content: string; at: number }[];
  quotationAt: number | null; hasOrder: boolean; followUpAfterQuote: boolean; now: number;
}): WatchFinding[] {
  const { messages, now } = input;
  const out: WatchFinding[] = [];
  const last = messages[messages.length - 1];
  const customerTexts = messages.filter(m => m.sender === 'customer').map(m => String(m.content || ''));
  if (last && last.sender === 'customer' && !isCourtesy(last.content)) {
    const waited = Math.round((now - last.at) / 60_000);
    if (waited >= WAIT_MINUTES) {
      const stage = stageOf({
        customerTexts: customerTexts.slice(-6), botSentPhotos: messages.some(m => m.sender === 'bot' && m.type === 'image'),
        bankDetailsSent: messages.some(isBankDetails), hasQuotation: input.quotationAt !== null, hasOrder: input.hasOrder
      });
      const said = `"${String(last.content || '').replace(/\s+/g, ' ').slice(0, 140)}"`;
      if (stage === 'listo_para_pagar') out.push({ event: 'ready_to_pay_waiting', conversationId: input.conversationId, detail: `Quiere pagar o confirmar y lleva ${waited} min sin respuesta: ${said}`, since: last.at });
      else if (stage === 'caliente') out.push({ event: 'hot_waiting', conversationId: input.conversationId, detail: `Clienta con datos de compra lleva ${waited} min sin respuesta: ${said}`, since: last.at });
    }
  }
  const askedPerson = messages.filter(m => m.sender === 'customer' && now - m.at < 6 * 3_600_000 && asksForPerson(m.content));
  if (askedPerson.length) {
    const at = askedPerson[askedPerson.length - 1].at;
    const teamAnswered = messages.some(m => m.sender === 'human' && m.at > at);
    if (!teamAnswered) out.push({ event: 'asks_person', conversationId: input.conversationId, detail: `Pide hablar con una persona: "${String(askedPerson[askedPerson.length - 1].content).slice(0, 140)}"` });
  }
  if (input.quotationAt !== null && !input.hasOrder && !input.followUpAfterQuote && now - input.quotationAt >= QUOTE_STALLED_HOURS * 3_600_000) {
    const repliedAfter = messages.some(m => m.sender === 'customer' && m.at > input.quotationAt!);
    if (!repliedAfter) out.push({ event: 'quote_stalled', conversationId: input.conversationId, detail: `Recibió una cotización hace más de ${QUOTE_STALLED_HOURS} horas, no respondió y no le salió ningún seguimiento` });
  }
  return out;
}

/** Un mensaje que importa (cotización, pago, pedido, seguimiento o respuesta del equipo): si no se entregó, se avisa. */
export function importantMessage(m: { sender: string; content: string }): boolean {
  const text = String(m.content || '');
  return m.sender === 'human' || isFollowUpMessage(text) || text.startsWith('🏦') || /\$\s?\d|cotizaci|anticipo|pedido|total/i.test(text);
}

export const alertHours = (now: Date, tz: string) => { const h = localParts(now, tz).hour; return h >= ALERT_FROM_HOUR && h < ALERT_UNTIL_HOUR; };

/** Revisa los chats de la empresa en curso y avisa a la dueña de lo que vale la pena. Devuelve los avisos enviados. */
export async function watchCurrent(now = new Date()): Promise<number> {
  const tz = profile().business.timezone;
  const daytime = alertHours(now, tz);
  const since = new Date(now.getTime() - 48 * 3_600_000);
  const conversations = (await getAllConversations())
    .filter((c: any) => c.status !== 'closed' && !isNotCustomer(c.tags) && c.last_message_time && parseDbTimestamp(c.last_message_time) >= new Date(now.getTime() - 14 * 86_400_000));
  if (conversations.length === 0) return 0;
  const byId = new Map<string, any>(conversations.map((c: any) => [c.id, c]));
  const ids = [...byId.keys()];
  const [messages, quotations, orders] = await Promise.all([
    messagesOf(ids, since.toISOString()),
    quotationsSince(new Date(now.getTime() - 14 * 86_400_000).toISOString()),
    ordersSince(new Date(now.getTime() - 14 * 86_400_000).toISOString())
  ]);
  const { data: followRows } = await supabase.from('followups').select('conversation_id, created_at').in('conversation_id', ids.slice(0, 500)).eq('type', 'auto_followup')
    .gte('created_at', new Date(now.getTime() - 14 * 86_400_000).toISOString()).limit(5000);
  const byChat = new Map<string, Msg[]>();
  for (const m of messages) byChat.set(m.conversation_id, [...(byChat.get(m.conversation_id) || []), m]);
  const latestQuote = new Map<string, number>();
  for (const q of quotations) latestQuote.set(q.conversation_id, Math.max(latestQuote.get(q.conversation_id) || 0, parseDbTimestamp(q.created_at).getTime()));
  const ordered = new Set(orders.map(o => o.conversation_id));
  const findings: WatchFinding[] = [];
  for (const id of new Set([...byChat.keys(), ...latestQuote.keys()])) {
    if (!byId.has(id)) continue;
    const quoteAt = latestQuote.get(id) ?? null;
    findings.push(...watchChat({
      conversationId: id,
      messages: (byChat.get(id) || []).map(m => ({ sender: m.sender, type: m.type, content: String(m.content || ''), at: parseDbTimestamp(m.timestamp).getTime() })),
      quotationAt: quoteAt, hasOrder: ordered.has(id),
      followUpAfterQuote: quoteAt !== null && (followRows || []).some((f: any) => f.conversation_id === id && parseDbTimestamp(f.created_at).getTime() > quoteAt),
      now: now.getTime()
    }));
  }
  // Mensajes importantes que WhatsApp no entregó (los del plazo de 24 horas ya se guardan y salen solos al responder).
  const { data: undelivered } = await supabase.from('notifications').select('conversation_id, message, created_at').in('conversation_id', ids.slice(0, 500))
    .eq('event_type', UNDELIVERED_EVENT).gte('created_at', new Date(now.getTime() - 24 * 3_600_000).toISOString()).limit(200);
  for (const row of undelivered || []) {
    const [waId, code, ...rest] = String(row.message || '').split('|');
    if (code === '131047') continue;
    const msg = (byChat.get(row.conversation_id) || []).find(m => m.wa_message_id === waId);
    if (msg && !importantMessage(msg)) continue;
    findings.push({ event: 'undelivered_important', conversationId: row.conversation_id, detail: `WhatsApp no entregó un mensaje: ${rest.join('|').slice(0, 160)}` });
  }

  let sent = 0;
  for (const f of findings) {
    if (!daytime && !URGENT_EVENTS.includes(f.event)) continue;
    // Una sola alerta por chat y tipo: las de espera, una por cada vez que la clienta queda esperando.
    const hours = f.since ? (now.getTime() - f.since) / 3_600_000 + 0.05 : f.event === 'quote_stalled' ? 24 * 7 : f.event === 'asks_person' ? 12 : 24;
    if (await hasRecentNotification(f.conversationId, f.event, hours)) continue;
    const conv = byId.get(f.conversationId);
    await notifyOwner({ conversationId: conv.id, customerPhone: conv.phone_number, customerName: conv.customer_name || conv.phone_number, event: f.event, detail: f.detail });
    sent++;
  }
  return sent;
}

let watching = false;

export async function runSalesWatch(now = new Date()) {
  if (watching) return;
  watching = true;
  try {
    await runWithTenant(undefined, () => watchCurrent(now)).catch(error => console.error('❌ Vigilancia de ventas de VELAMIA:', error.message));
    for (const tenant of await getActiveTenants().catch(() => [])) {
      await runWithTenant(tenant, () => watchCurrent(now)).catch(error => console.error(`❌ Vigilancia de ventas de ${tenant.name}:`, error.message));
    }
  } finally {
    watching = false;
  }
}

export function startSalesWatch() {
  setTimeout(() => void runSalesWatch(), 2 * 60 * 1000);
  setInterval(() => void runSalesWatch(), 5 * 60 * 1000);
  console.log(`🚨 Vigilancia de ventas activa: clienta lista para pagar o caliente esperando más de ${WAIT_MINUTES} min, cotización sin avance, pide una persona, mensaje no entregado`);
}

// ---------- Para el CRM ----------

/** Prioridad de cada aviso (la del prompt del supervisor): alta, media o baja. */
export const ALERT_PRIORITY: Record<string, 'alta' | 'media' | 'baja'> = {
  ready_to_pay_waiting: 'alta', hot_waiting: 'alta', complaint: 'alta', card_payment: 'alta', payment_proof: 'alta',
  quote_stalled: 'media', undelivered_important: 'media', asks_person: 'media', owner_question: 'media', bot_error: 'alta'
};

/** Los avisos de las últimas horas (de la vigilancia y los de siempre: reclamos, pagos, preguntas), del más nuevo al más viejo. */
export async function recentAlerts(hours = 48): Promise<{ conversationId: string; customer: string; event: string; detail: string; at: string; priority: string }[]> {
  const conversations = await getAllConversations();
  const names = new Map<string, string>(conversations.map((c: any) => [c.id, String(c.customer_name || c.phone_number || 'Cliente')]));
  const ids = [...names.keys()];
  const since = new Date(Date.now() - hours * 3_600_000).toISOString();
  const rows: any[] = [];
  for (let i = 0; i < ids.length; i += 60) {
    const { data, error } = await supabase.from('notifications').select('conversation_id, event_type, message, created_at')
      .in('conversation_id', ids.slice(i, i + 60)).in('event_type', Object.keys(ALERT_PRIORITY)).gte('created_at', since).limit(500);
    if (error) throw new Error(`Error leyendo los avisos: ${error.message}`);
    rows.push(...(data || []));
  }
  return rows
    .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))
    .slice(0, 50)
    .map(r => ({ conversationId: r.conversation_id, customer: names.get(r.conversation_id) || 'Cliente', event: r.event_type, detail: String(r.message || '').slice(0, 300), at: r.created_at, priority: ALERT_PRIORITY[r.event_type] || 'baja' }));
}
