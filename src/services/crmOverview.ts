import { profile, todayLocal } from '../config/businessProfile';
import {
  getRecentMessages,
  getOrderRefs,
  getQuotationRefs,
  getQuotationsByConversation,
  getOrdersByConversation,
  getConversationById,
  getAllProducts,
  getMessages,
  getAllConversations,
  getConversationNotes,
  getConversationTasks,
  productNameFromCaption,
  parseDbTimestamp
} from './supabase';

const DAY = 24 * 60 * 60 * 1000;
const MEDIA_LABELS: Record<string, string> = { image: '📷 Foto', audio: '🎤 Audio', document: '📎 Documento', video: '🎬 Video' };

/** Instante UTC en que empieza ese día (AAAA-MM-DD) en la zona horaria del negocio. */
function localMidnight(dateStr: string, timezone: string): Date {
  const guess = new Date(`${dateStr}T00:00:00Z`);
  const asLocal = new Date(guess.toLocaleString('en-US', { timeZone: timezone }));
  return new Date(guess.getTime() - (asLocal.getTime() - guess.getTime()));
}

function previousDate(dateStr: string): string {
  return new Date(new Date(`${dateStr}T00:00:00Z`).getTime() - DAY).toISOString().slice(0, 10);
}

const median = (values: number[]) => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};

const key = (text: unknown) => String(text ?? '').normalize('NFD').replace(/\p{Diacritic}/gu, '').replace(/\s+/g, ' ').trim().toLowerCase();

/** Lo de hoy contra ayer: chats con mensajes del cliente, pedidos, cotizaciones y cuánto tarda la primera respuesta. */
export async function getTodaySummary() {
  const p = profile();
  const timezone = p.business.timezone;
  const todayStr = todayLocal(p);
  const todayStart = localMidnight(todayStr, timezone);
  const yesterdayStart = localMidnight(previousDate(todayStr), timezone);
  const since = yesterdayStart.toISOString();

  const [messages, orders, quotations] = await Promise.all([
    getRecentMessages(since),
    getOrderRefs(since),
    getQuotationRefs(since)
  ]);

  const inRange = (iso: string, from: Date, to: Date) => {
    const t = parseDbTimestamp(iso).getTime();
    return t >= from.getTime() && t < to.getTime();
  };

  const day = (from: Date, to: Date) => {
    const chronological = messages
      .filter(m => inRange(m.timestamp, from, to))
      .sort((a, b) => parseDbTimestamp(a.timestamp).getTime() - parseDbTimestamp(b.timestamp).getTime());

    const chats = new Set(chronological.filter(m => m.sender === 'customer').map(m => m.conversation_id));
    const waiting = new Map<string, number>();
    const gaps: number[] = [];
    for (const m of chronological) {
      const at = parseDbTimestamp(m.timestamp).getTime();
      if (m.sender === 'customer') {
        if (!waiting.has(m.conversation_id)) waiting.set(m.conversation_id, at);
      } else if (waiting.has(m.conversation_id)) {
        gaps.push((at - waiting.get(m.conversation_id)!) / 1000);
        waiting.delete(m.conversation_id);
      }
    }

    // Qué parte de las respuestas del día las dio el bot (el resto las escribió una persona del equipo).
    const replies = chronological.filter(m => m.sender === 'bot' || m.sender === 'human');
    return {
      conversations: chats.size,
      orders: orders.filter(o => inRange(o.created_at, from, to)).length,
      quotations: quotations.filter(q => inRange(q.created_at, from, to)).length,
      responseSeconds: median(gaps),
      botShare: replies.length ? Math.round(replies.filter(m => m.sender === 'bot').length / replies.length * 100) : null
    };
  };

  return {
    date: todayStr,
    timezone,
    today: day(todayStart, new Date(todayStart.getTime() + DAY)),
    yesterday: day(yesterdayStart, todayStart)
  };
}

function previewText(m: { type: string; content: string | null }): string {
  const content = String(m.content || '');
  if (MEDIA_LABELS[m.type]) {
    const caption = content.replace(/^https?:\/\/\S+\n?/, '').replace(/\*/g, '').trim();
    return caption ? `${MEDIA_LABELS[m.type]} · ${caption}`.slice(0, 120) : MEDIA_LABELS[m.type];
  }
  return content.replace(/\s+/g, ' ').trim().slice(0, 120);
}

/** Último mensaje de cada chat (para la lista) y los chats que ya compraron algo. */
export async function getListOverview() {
  const since = new Date(Date.now() - 14 * DAY).toISOString();
  const [messages, orders, conversations] = await Promise.all([getRecentMessages(since, 4000), getOrderRefs(), getAllConversations()]);

  const previews: Record<string, { text: string; sender: string; timestamp: string }> = {};
  for (const m of messages) {
    const current = previews[m.conversation_id];
    if (!current || parseDbTimestamp(m.timestamp).getTime() > parseDbTimestamp(current.timestamp).getTime()) {
      previews[m.conversation_id] = { text: previewText(m), sender: m.sender, timestamp: m.timestamp };
    }
  }

  // Sin la migración 020 no existe last_read_at: en ese caso no se muestran mensajes sin leer.
  const unread: Record<string, number> = {};
  for (const conv of conversations as any[]) {
    if (!('last_read_at' in conv)) break;
    const readAt = conv.last_read_at ? parseDbTimestamp(conv.last_read_at).getTime() : 0;
    const count = messages.filter(m => m.conversation_id === conv.id && m.sender === 'customer' && parseDbTimestamp(m.timestamp).getTime() > readAt).length;
    if (count > 0) unread[conv.id] = count;
  }

  return { previews, clientIds: [...new Set(orders.map(o => o.conversation_id))], unread };
}

function shippingPlace(products: unknown): string {
  try {
    const list = typeof products === 'string' ? JSON.parse(products || '[]') : products;
    const line = (Array.isArray(list) ? list : []).find((i: any) => i?.type === 'shipping');
    return line ? String(line.name || '').replace(/^Envío a\s*/i, '').trim() : '';
  } catch {
    return '';
  }
}

const capitalize = (text: string) => (text ? text.charAt(0).toUpperCase() + text.slice(1).toLowerCase() : text);

const agoText = (ms: number) => {
  const minutes = Math.round(ms / 60000);
  if (minutes < 60) return `${Math.max(1, minutes)} min`;
  if (minutes < 48 * 60) return `${Math.round(minutes / 60)} h`;
  return `${Math.round(minutes / 1440)} días`;
};

export interface CrmAlert { level: 'info' | 'warn'; title: string; text: string }

/** Avisos calculados con reglas simples sobre el chat (sin gastar IA): qué merece atención ahora. */
export function buildAlerts(conversation: any, messages: any[], quotations: any[]): CrmAlert[] {
  const alerts: CrmAlert[] = [];
  const now = Date.now();
  const at = (m: any) => parseDbTimestamp(m.timestamp).getTime();
  const last = messages[messages.length - 1];
  const paused = !!conversation.bot_paused_until && parseDbTimestamp(conversation.bot_paused_until).getTime() > now;

  if (last && last.sender === 'customer' && paused && now - at(last) > 10 * 60 * 1000) {
    alerts.push({ level: 'warn', title: 'Cliente esperando respuesta', text: `Escribió hace ${agoText(now - at(last))} y el bot está en pausa: te toca responder.` });
  }

  const pending = quotations.find((q: any) => q.status === 'pending'
    && now - parseDbTimestamp(q.created_at).getTime() > DAY
    && (!q.expires_at || parseDbTimestamp(q.expires_at).getTime() > now));
  if (pending) {
    alerts.push({ level: 'warn', title: 'Cotización sin respuesta', text: `La cotización de $${Number(pending.total_amount || 0).toFixed(2)} lleva ${agoText(now - parseDbTimestamp(pending.created_at).getTime())} sin confirmarse.` });
  }

  const bankIndex = messages.map((m: any) => String(m.content || '').startsWith('🏦 Datos para transferencia')).lastIndexOf(true);
  if (bankIndex >= 0 && messages.slice(bankIndex + 1).some((m: any) => m.sender === 'customer' && m.type === 'image' && now - at(m) < 72 * 60 * 60 * 1000)) {
    alerts.push({ level: 'info', title: 'Posible comprobante de pago', text: 'Envió una imagen después de recibir los datos bancarios. Revísala y confirma el pago.' });
  }

  const recent = messages
    .filter((m: any) => m.sender === 'customer' && m.type === 'text' && now - at(m) < 3 * DAY)
    .slice(-15)
    .map((m: any) => String(m.content || '').toLowerCase())
    .join(' ');
  const topics: string[] = [];
  if (/precio|cu[aá]nto (cuesta|vale|es|sale)|cost[oa]/.test(recent)) topics.push('precios');
  if (/env[ií]o|entreg|domicilio/.test(recent)) topics.push('envíos');
  if (/disponib|stock/.test(recent)) topics.push('disponibilidad');
  if (/cotiza|presupuesto/.test(recent)) topics.push('cotización');
  if (/instala/.test(recent)) topics.push('instalación');
  if (topics.length >= 2) {
    alerts.push({ level: 'info', title: 'Alta intención de compra', text: `Ha consultado ${topics.join(', ')}.` });
  }

  return alerts.slice(0, 3);
}

/** Todo lo que se sabe de un cliente: compras, ciudad, productos que consultó y en qué anda interesado. */
export async function getConversationSummary(conversationId: string) {
  const conversation = await getConversationById(conversationId);
  if (!conversation) return null;

  const [orders, quotations, messages, catalog, notes, tasks] = await Promise.all([
    getOrdersByConversation(conversationId),
    getQuotationsByConversation(conversationId),
    getMessages(conversationId, 500),
    getAllProducts(),
    getConversationNotes(conversationId),
    getConversationTasks(conversationId)
  ]);

  const valid = orders.filter((o: any) => o.status !== 'cancelled');
  const totalSpent = valid.reduce((sum: number, o: any) => sum + Number(o.total_amount || 0), 0);
  const city = valid.map((o: any) => String(o.customer_address || '').trim() || shippingPlace(o.products)).find(Boolean)
    || quotations.map((q: any) => shippingPlace(q.products)).find(Boolean)
    || '';

  const times = new Map<string, number>();
  for (const m of messages) {
    if (m.sender !== 'bot' || m.type !== 'image') continue;
    const name = productNameFromCaption(String(m.content || ''));
    if (name) times.set(name, (times.get(name) || 0) + 1);
  }

  const byName = new Map(catalog.map((c: any) => [key(c.name), c]));
  const products = [...times.entries()]
    .map(([name, count]) => {
      const found: any = byName.get(key(name));
      return {
        name: found?.name || name,
        price: found ? Number(found.price) : null,
        unit: found?.sale_unit || profile().sales.unitSingular,
        measure: found?.measure || '',
        category: found?.category || '',
        image_url: found?.image_url || '',
        times: count
      };
    })
    .sort((a, b) => b.times - a.times);

  const categoryCounts = new Map<string, number>();
  for (const item of products) if (item.category) categoryCounts.set(item.category, (categoryCounts.get(item.category) || 0) + item.times);
  const topCategory = [...categoryCounts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];

  const badges: string[] = [];
  if (valid.length) badges.push('Cliente');
  if (products.length || quotations.length) badges.push('Interesado');
  if (!badges.length) badges.push('Nuevo');

  return {
    customer: {
      name: conversation.customer_name || '',
      phone: conversation.phone_number,
      city,
      ordersCount: valid.length,
      quotationsCount: quotations.length,
      totalSpent,
      lastOrderAt: valid[0]?.created_at || null,
      frequent: valid.length >= 2,
      since: conversation.created_at
    },
    badges,
    interest: topCategory ? `Interesado en ${capitalize(topCategory)}` : null,
    products,
    tags: Array.isArray(conversation.tags) ? conversation.tags : [],
    closed: conversation.status === 'closed',
    // Sin la migración 020 no hay notas ni acciones: el CRM oculta esas partes.
    phase2: notes !== null && tasks !== null,
    notes: notes || [],
    tasks: tasks || [],
    alerts: buildAlerts(conversation, messages, quotations)
  };
}
