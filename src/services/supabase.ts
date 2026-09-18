import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { randomUUID, randomBytes, scryptSync, timingSafeEqual } from 'crypto';
import { currentTenant, TenantContext, encryptSecret, decryptSecret, maskSecret, VELAMIA_ID } from './tenant';
import { costOf } from './aiPrices';
import { normalizeProfile, BusinessProfile, STORE_PROFILE } from '../config/businessProfile';

// Cliente único con la service key: ignora RLS, por eso solo se usa en el servidor.
// supabase-js ya reintenta las lecturas ante cortes de red (hasta 4 intentos) y no repite escrituras.
export const supabase: SupabaseClient = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_KEY!);

const PAUSED_UNTIL_RESUMED = '2100-01-01T00:00:00Z';
const UNIQUE_VIOLATION = '23505';

/**
 * Las columnas de fecha son TIMESTAMP sin zona horaria y guardan hora UTC; sin la "Z"
 * JavaScript las leería como hora local y se desfasarían 5 horas en Ecuador.
 */
export function parseDbTimestamp(value: string): Date {
  return new Date(/[zZ]|[+-]\d\d:?\d\d$/.test(value) ? value : `${value}Z`);
}

// ---------- SEPARACIÓN POR NEGOCIO ----------
// Conversaciones, productos, cotizaciones y pedidos llevan business_id. Dentro de un negocio solo se ven
// y tocan sus filas; fuera de un negocio (VELAMIA) solo las que no tienen business_id.
// Mensajes, seguimientos y avisos cuelgan de una conversación, así que quedan separados a través de ella.

const tenantOp = () => (currentTenant() ? 'eq' : 'is');
const tenantValue = () => currentTenant()?.businessId ?? null;
const tenantColumns = () => {
  const tenant = currentTenant();
  return tenant ? { business_id: tenant.businessId } : {};
};

// ---------- CONVERSACIONES ----------

export async function getConversation(phoneNumber: string) {
  const { data, error } = await supabase
    .from('conversations')
    .select('*')
    .eq('phone_number', phoneNumber)
    .filter('business_id', tenantOp(), tenantValue())
    .maybeSingle();

  if (error) throw new Error(`Error obteniendo conversación: ${error.message}`);
  return data;
}

export async function createConversation(phoneNumber: string, customerName?: string) {
  const now = new Date().toISOString();
  const { data, error } = await supabase
    .from('conversations')
    .insert([{
      id: randomUUID(),
      ...tenantColumns(),
      phone_number: phoneNumber,
      customer_name: customerName,
      status: 'active',
      last_message_time: now,
      created_at: now,
      updated_at: now
    }])
    .select()
    .single();

  // Dos mensajes simultáneos de un cliente nuevo: el segundo encuentra el chat ya creado.
  if (error?.code === UNIQUE_VIOLATION) return getConversation(phoneNumber);
  if (error) throw new Error(`Error creando conversación: ${error.message}`);
  return data;
}

export async function getConversationById(conversationId: string) {
  const { data, error } = await supabase
    .from('conversations')
    .select('*')
    .eq('id', conversationId)
    .filter('business_id', tenantOp(), tenantValue())
    .maybeSingle();

  if (error) throw new Error(`Error obteniendo conversación: ${error.message}`);
  return data;
}

/** Marca actividad reciente: el CRM ordena las conversaciones por este campo. */
export async function touchConversation(conversationId: string) {
  const now = new Date().toISOString();
  const { error } = await supabase
    .from('conversations')
    .update({ status: 'active', last_message_time: now, updated_at: now })
    .eq('id', conversationId)
    .filter('business_id', tenantOp(), tenantValue());

  if (error) throw new Error(`Error actualizando actividad: ${error.message}`);
}

export async function getAllConversations() {
  const { data, error } = await supabase
    .from('conversations')
    .select('*')
    .filter('business_id', tenantOp(), tenantValue())
    .order('last_message_time', { ascending: false });

  if (error) throw new Error(`Error obteniendo conversaciones: ${error.message}`);
  return data || [];
}

/**
 * Elimina un chat y todo lo relacionado. Las tablas tienen ON DELETE CASCADE, pero se borra
 * cada una explícitamente para no depender de cómo quedó configurada la base.
 * Devuelve las URLs de archivos del cliente para borrarlas también del almacenamiento.
 */
export async function deleteConversationCompletely(conversationId: string): Promise<{ mediaUrls: string[] }> {
  const { data: messages, error: readError } = await supabase
    .from('messages')
    .select('content')
    .eq('conversation_id', conversationId);

  if (readError) throw new Error(`Error leyendo mensajes del chat: ${readError.message}`);

  const mediaUrls = (messages || [])
    .map(m => String(m.content || '').match(/^https?:\/\/\S+/)?.[0])
    .filter(Boolean) as string[];

  // Orden: primero lo que depende de otras tablas (followups apunta a orders).
  for (const table of ['followups', 'notifications', 'quotations', 'orders', 'messages']) {
    const { error } = await supabase.from(table).delete().eq('conversation_id', conversationId);
    if (error) throw new Error(`Error borrando ${table}: ${error.message}`);
  }

  const { error } = await supabase.from('conversations').delete().eq('id', conversationId);
  if (error) throw new Error(`Error borrando conversación: ${error.message}`);

  return { mediaUrls };
}

// ---------- MENSAJES ----------

export async function saveMessage(
  conversationId: string,
  sender: 'customer' | 'bot',
  type: string,
  content: string,
  waMessageId?: string
) {
  const { data, error } = await supabase
    .from('messages')
    .insert([{
      id: randomUUID(),
      conversation_id: conversationId,
      sender,
      type,
      content,
      wa_message_id: waMessageId,
      timestamp: new Date().toISOString()
    }])
    .select()
    .single();

  if (error) throw new Error(`Error guardando mensaje: ${error.message}`);
  return data;
}

export async function isMessageAlreadyProcessed(waMessageId: string): Promise<boolean> {
  return !!(await getMessageByWaId(waMessageId));
}

export async function getMessageByWaId(waMessageId: string) {
  const { data, error } = await supabase
    .from('messages')
    .select('*')
    .eq('wa_message_id', waMessageId)
    .maybeSingle();

  if (error) throw new Error(`Error buscando mensaje: ${error.message}`);
  return data;
}

/**
 * Los últimos N mensajes en orden cronológico. Se piden del más nuevo al más viejo:
 * con orden ascendente y límite, un chat largo mostraría los antiguos y escondería los nuevos.
 */
export async function getMessages(conversationId: string, limit: number = 300) {
  const { data, error } = await supabase
    .from('messages')
    .select('*')
    .eq('conversation_id', conversationId)
    .order('timestamp', { ascending: false })
    .limit(limit);

  if (error) throw new Error(`Error obteniendo mensajes: ${error.message}`);
  return (data || []).reverse();
}

/** Últimos N mensajes en orden cronológico. */
export async function getConversationHistory(conversationId: string, limit: number = 10) {
  const { data, error } = await supabase
    .from('messages')
    .select('*')
    .eq('conversation_id', conversationId)
    .order('timestamp', { ascending: false })
    .limit(limit);

  if (error) throw new Error(`Error obteniendo historial: ${error.message}`);
  return (data || []).reverse();
}

/** Nombre del producto dentro del texto de una foto enviada ("🕯️ *NOMBRE*\n💰 ..."). */
export function productNameFromCaption(content: string): string | null {
  const match = content.match(/\*([^*]+)\*/);
  return match ? match[1].trim() : null;
}

/** Productos cuya foto ya se envió en la conversación, para no repetirlas. */
export async function getSentProductNames(conversationId: string): Promise<string[]> {
  const { data, error } = await supabase
    .from('messages')
    .select('content')
    .eq('conversation_id', conversationId)
    .eq('sender', 'bot')
    .eq('type', 'image');

  if (error) throw new Error(`Error obteniendo fotos enviadas: ${error.message}`);
  const names = (data || []).map(m => productNameFromCaption(m.content)).filter(Boolean) as string[];
  return [...new Set(names)];
}

// ---------- PAUSA DEL BOT POR CONVERSACIÓN ----------

/**
 * Pausa el bot en una conversación. Sin minutos, queda pausado hasta que alguien
 * lo reactive desde el CRM (así el bot nunca responde encima de una persona).
 */
export async function pauseBot(conversationId: string, minutes?: number) {
  const pausedUntil = minutes
    ? new Date(Date.now() + minutes * 60 * 1000).toISOString()
    : PAUSED_UNTIL_RESUMED;

  const { error } = await supabase
    .from('conversations')
    .update({ bot_paused_until: pausedUntil })
    .eq('id', conversationId)
    .filter('business_id', tenantOp(), tenantValue());

  if (error) throw new Error(`Error pausando bot: ${error.message}`);
}

export async function resumeBot(conversationId: string) {
  const { error } = await supabase
    .from('conversations')
    .update({ bot_paused_until: null })
    .eq('id', conversationId)
    .filter('business_id', tenantOp(), tenantValue());

  if (error) throw new Error(`Error reactivando bot: ${error.message}`);
}

export async function isBotPaused(conversationId: string): Promise<boolean> {
  const conversation = await getConversationById(conversationId);
  if (!conversation?.bot_paused_until) return false;
  return parseDbTimestamp(conversation.bot_paused_until) > new Date();
}

// ---------- COTIZACIONES ----------
// products se guarda como arreglo en la columna JSONB (sin JSON.stringify).

export async function createQuotation(conversationId: string, phoneNumber: string, products: any[], totalAmount: number) {
  const expiresAt = new Date();
  expiresAt.setDate(expiresAt.getDate() + 3);

  const { data, error } = await supabase
    .from('quotations')
    .insert([{
      id: randomUUID(),
      ...tenantColumns(),
      conversation_id: conversationId,
      customer_phone: phoneNumber,
      products,
      total_amount: totalAmount,
      status: 'pending',
      created_at: new Date().toISOString(),
      expires_at: expiresAt.toISOString()
    }])
    .select()
    .single();

  if (error) throw new Error(`Error creando cotización: ${error.message}`);
  return data;
}

/** Todas las cotizaciones con el nombre del cliente; antes marca como vencidas las que pasaron su fecha. */
export async function getAllQuotations() {
  const { error: expireError } = await supabase
    .from('quotations')
    .update({ status: 'expired' })
    .eq('status', 'pending')
    .lt('expires_at', new Date().toISOString())
    .filter('business_id', tenantOp(), tenantValue());

  // Marcar vencidas es secundario: si falla, igual se muestra la lista y se reintenta en la próxima carga.
  if (expireError) console.error('No se pudieron marcar cotizaciones vencidas:', expireError.message);

  const { data, error } = await supabase
    .from('quotations')
    .select('*, conversations(customer_name, phone_number)')
    .filter('business_id', tenantOp(), tenantValue())
    .order('created_at', { ascending: false });

  if (error) throw new Error(`Error obteniendo cotizaciones: ${error.message}`);
  return data || [];
}

/** Cotización pendiente reciente, para ajustarla cuando el cliente cambia cantidad o detalles. */
export async function getRecentPendingQuotation(conversationId: string, hours: number = 24) {
  const since = new Date(Date.now() - hours * 60 * 60 * 1000);
  const { data, error } = await supabase
    .from('quotations')
    .select('*')
    .eq('conversation_id', conversationId)
    .eq('status', 'pending')
    .gte('created_at', since.toISOString())
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) throw new Error(`Error buscando cotización reciente: ${error.message}`);
  return data;
}

export async function updateQuotationItems(quotationId: string, products: any[], totalAmount: number) {
  const expiresAt = new Date();
  expiresAt.setDate(expiresAt.getDate() + 3);

  const { data, error } = await supabase
    .from('quotations')
    .update({ products, total_amount: totalAmount, expires_at: expiresAt.toISOString() })
    .eq('id', quotationId)
    .filter('business_id', tenantOp(), tenantValue())
    .select()
    .single();

  if (error) throw new Error(`Error actualizando cotización: ${error.message}`);
  return data;
}

export async function updateQuotationStatus(quotationId: string, status: 'pending' | 'accepted' | 'expired') {
  const { data, error } = await supabase
    .from('quotations')
    .update({ status })
    .eq('id', quotationId)
    .filter('business_id', tenantOp(), tenantValue())
    .select()
    .maybeSingle();

  if (error) throw new Error(`Error actualizando cotización: ${error.message}`);
  return data;
}

// ---------- PEDIDOS ----------

export async function createOrder(
  conversationId: string, phoneNumber: string, customerName: string, products: any[], totalAmount: number,
  deliveryDate?: string, address?: string
) {
  const { data, error } = await supabase
    .from('orders')
    .insert([{
      id: randomUUID(),
      ...tenantColumns(),
      conversation_id: conversationId,
      customer_name: customerName,
      customer_phone: phoneNumber,
      customer_address: address || null,
      products,
      total_amount: totalAmount,
      status: 'pending',
      created_at: new Date().toISOString(),
      delivery_date: deliveryDate || null
    }])
    .select()
    .single();

  if (error) throw new Error(`Error creando pedido: ${error.message}`);
  return data;
}

export const ORDER_STATUSES = ['pending', 'confirmed', 'shipped', 'delivered', 'cancelled'] as const;
export type OrderStatus = typeof ORDER_STATUSES[number];

/** Todos los pedidos con el nombre del cliente, del más reciente al más antiguo. */
export async function getAllOrders() {
  const { data, error } = await supabase
    .from('orders')
    .select('*, conversations(customer_name, phone_number)')
    .filter('business_id', tenantOp(), tenantValue())
    .order('created_at', { ascending: false });

  if (error) throw new Error(`Error obteniendo pedidos: ${error.message}`);
  return data || [];
}

export async function updateOrderStatus(orderId: string, status: OrderStatus) {
  const { data, error } = await supabase
    .from('orders')
    .update({ status })
    .eq('id', orderId)
    .filter('business_id', tenantOp(), tenantValue())
    .select()
    .maybeSingle();

  if (error) throw new Error(`Error actualizando pedido: ${error.message}`);
  return data;
}

export async function getOrdersByConversation(conversationId: string) {
  const { data, error } = await supabase
    .from('orders')
    .select('*')
    .eq('conversation_id', conversationId)
    .order('created_at', { ascending: false });

  if (error) throw new Error(`Error obteniendo pedidos: ${error.message}`);
  return data || [];
}

/** Pedido pendiente creado en las últimas horas, para actualizarlo en vez de duplicarlo. */
export async function getRecentPendingOrder(conversationId: string, hours: number = 24) {
  const since = new Date(Date.now() - hours * 60 * 60 * 1000);
  const { data, error } = await supabase
    .from('orders')
    .select('*')
    .eq('conversation_id', conversationId)
    .eq('status', 'pending')
    .gte('created_at', since.toISOString())
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) throw new Error(`Error buscando pedido reciente: ${error.message}`);
  return data;
}

export async function updateOrderItems(orderId: string, products: any[], totalAmount: number, deliveryDate?: string, address?: string) {
  const { data, error } = await supabase
    .from('orders')
    .update({
      products,
      total_amount: totalAmount,
      ...(deliveryDate ? { delivery_date: deliveryDate } : {}),
      ...(address ? { customer_address: address } : {})
    })
    .eq('id', orderId)
    .filter('business_id', tenantOp(), tenantValue())
    .select()
    .single();

  if (error) throw new Error(`Error actualizando pedido: ${error.message}`);
  return data;
}

/** Pedidos del período sin contar los cancelados. */
export async function getSalesMetrics(days: number = 30) {
  const startDate = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

  const { data, error } = await supabase
    .from('orders')
    .select('total_amount, status')
    .neq('status', 'cancelled')
    .filter('business_id', tenantOp(), tenantValue())
    .gte('created_at', startDate.toISOString());

  if (error) throw new Error(`Error obteniendo métricas: ${error.message}`);

  const orders = data || [];
  return {
    totalOrders: orders.length,
    totalRevenue: orders.reduce((sum, o) => sum + Number(o.total_amount || 0), 0)
  };
}

// ---------- DATOS PARA LAS VISTAS DEL CRM (resumen de hoy, vistas previas, resumen del cliente) ----------

export interface RecentMessage {
  conversation_id: string;
  sender: string;
  type: string;
  content: string | null;
  timestamp: string;
}

/** Mensajes desde una fecha, de todos los chats del negocio. Se piden por tandas para no pasarse del largo de la URL. */
export async function getRecentMessages(sinceIso: string, maxRows = 3000): Promise<RecentMessage[]> {
  const ids = (await getAllConversations()).map((c: any) => c.id as string);
  const rows: RecentMessage[] = [];
  for (let i = 0; i < ids.length; i += 60) {
    const { data, error } = await supabase
      .from('messages')
      .select('conversation_id, sender, type, content, timestamp')
      .in('conversation_id', ids.slice(i, i + 60))
      .gte('timestamp', sinceIso)
      .order('timestamp', { ascending: false })
      .limit(maxRows);

    if (error) throw new Error(`Error obteniendo mensajes recientes: ${error.message}`);
    rows.push(...((data || []) as RecentMessage[]));
  }
  return rows;
}

/** Pedidos vigentes (sin cancelados) del negocio, con su chat y fecha. */
export async function getOrderRefs(sinceIso?: string): Promise<Array<{ conversation_id: string; created_at: string; total_amount: number }>> {
  let query = supabase
    .from('orders')
    .select('conversation_id, created_at, total_amount')
    .neq('status', 'cancelled')
    .filter('business_id', tenantOp(), tenantValue());
  if (sinceIso) query = query.gte('created_at', sinceIso);

  const { data, error } = await query.limit(5000);
  if (error) throw new Error(`Error obteniendo pedidos: ${error.message}`);
  return data || [];
}

export async function getQuotationRefs(sinceIso: string): Promise<Array<{ conversation_id: string; created_at: string }>> {
  const { data, error } = await supabase
    .from('quotations')
    .select('conversation_id, created_at')
    .filter('business_id', tenantOp(), tenantValue())
    .gte('created_at', sinceIso)
    .limit(5000);

  if (error) throw new Error(`Error obteniendo cotizaciones: ${error.message}`);
  return data || [];
}

export async function getQuotationsByConversation(conversationId: string) {
  const { data, error } = await supabase
    .from('quotations')
    .select('*')
    .eq('conversation_id', conversationId)
    .order('created_at', { ascending: false });

  if (error) throw new Error(`Error obteniendo cotizaciones del chat: ${error.message}`);
  return data || [];
}

// ---------- CONSUMO DE IA ----------

/**
 * Deja registrado lo que costó una llamada a OpenAI, para saber cuánto consume cada empresa.
 * Nunca interrumpe la atención: si falla el registro, solo se anota en el log.
 */
export async function recordAiUsage(usage: { model: string; purpose: string; input: number; cached: number; output: number }) {
  try {
    const { error } = await supabase.from('ai_usage').insert([{
      id: randomUUID(),
      ...tenantColumns(),
      created_at: new Date().toISOString(),
      model: usage.model,
      purpose: usage.purpose,
      input_tokens: usage.input,
      cached_tokens: usage.cached,
      output_tokens: usage.output
    }]);
    if (error) throw new Error(error.message);
  } catch (error: any) {
    console.warn('⚠️ No se pudo registrar el consumo de IA:', error.message);
  }
}

export interface AiUsageSummary {
  calls: number;
  input: number;
  cached: number;
  output: number;
  /** Costo estimado en dólares con los precios publicados por OpenAI. */
  cost: number;
}

const EMPTY_USAGE = (): AiUsageSummary => ({ calls: 0, input: 0, cached: 0, output: 0, cost: 0 });

function addUsage(summary: AiUsageSummary, row: any) {
  summary.calls++;
  summary.input += row.input_tokens || 0;
  summary.cached += row.cached_tokens || 0;
  summary.output += row.output_tokens || 0;
  summary.cost = Math.round((summary.cost + costOf(row)) * 1e6) / 1e6;
  return summary;
}

/** Consumo de una empresa en tres periodos, para ver el gasto de hoy, de la semana y del mes. */
export interface UsagePeriods {
  today: AiUsageSummary;
  week: AiUsageSummary;
  month: AiUsageSummary;
}

const emptyPeriods = (): UsagePeriods => ({ today: EMPTY_USAGE(), week: EMPTY_USAGE(), month: EMPTY_USAGE() });

/** Suma la fila a los periodos que le corresponden según su fecha. */
function addToPeriods(periods: UsagePeriods, row: any, startOfToday: number, weekAgo: number) {
  const at = new Date(row.created_at).getTime();
  addUsage(periods.month, row);
  if (at >= weekAgo) addUsage(periods.week, row);
  if (at >= startOfToday) addUsage(periods.today, row);
}

function periodLimits() {
  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  return { startOfToday, weekAgo: now.getTime() - 7 * 24 * 60 * 60 * 1000 };
}

/** Consumo de los últimos 30 días por empresa (clave VELAMIA_ID para la instalación original). */
export async function getUsageByBusiness(days = 30): Promise<Record<string, UsagePeriods>> {
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
  const { data, error } = await supabase
    .from('ai_usage')
    .select('business_id,created_at,model,input_tokens,cached_tokens,output_tokens')
    .gte('created_at', since);

  if (error) throw new Error(`Error obteniendo consumo: ${error.message}`);
  const { startOfToday, weekAgo } = periodLimits();
  const totals: Record<string, UsagePeriods> = {};
  for (const row of data || []) {
    const key = row.business_id || VELAMIA_ID;
    addToPeriods((totals[key] ||= emptyPeriods()), row, startOfToday, weekAgo);
  }
  return totals;
}

/** Consumo de la empresa actual: hoy, semana, mes y el detalle por día. */
export async function getTenantUsage(days = 30) {
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
  const { data, error } = await supabase
    .from('ai_usage')
    .select('created_at,model,input_tokens,cached_tokens,output_tokens')
    .filter('business_id', tenantOp(), tenantValue())
    .gte('created_at', since);

  if (error) throw new Error(`Error obteniendo consumo: ${error.message}`);
  const { startOfToday, weekAgo } = periodLimits();
  const periods = emptyPeriods();
  const byDay: Record<string, AiUsageSummary> = {};
  for (const row of data || []) {
    addToPeriods(periods, row, startOfToday, weekAgo);
    addUsage((byDay[String(row.created_at).slice(0, 10)] ||= EMPTY_USAGE()), row);
  }
  return { days, ...periods, byDay };
}

// ---------- PRODUCTOS ----------

// El empaque del producto se guarda en la columna description (existía sin uso): así no hace falta migrar la base.
/** Unidad de venta, medida y piezas por unidad de un producto: vacíos = se usa la unidad del negocio. */
export interface ProductUnit {
  sale_unit?: string | null;
  measure?: string | null;
  pieces_per_unit?: number | null;
}

export async function createProduct(name: string, price: number, category: string, imageUrl?: string, packaging?: string, unit: ProductUnit = {}) {
  const { data, error } = await supabase
    .from('products')
    .insert([{
      id: randomUUID(),
      ...tenantColumns(),
      name,
      description: packaging || '',
      price,
      stock: 999,
      category,
      image_url: imageUrl,
      sale_unit: unit.sale_unit || null,
      measure: unit.measure || null,
      pieces_per_unit: unit.pieces_per_unit || null,
      created_at: new Date().toISOString()
    }])
    .select()
    .single();

  if (error) throw new Error(`Error creando producto: ${error.message}`);
  return data;
}

export async function getAllProducts() {
  const { data, error } = await supabase
    .from('products')
    .select('*')
    .filter('business_id', tenantOp(), tenantValue())
    .order('category', { ascending: true })
    .order('name', { ascending: true });

  if (error) throw new Error(`Error obteniendo catálogo: ${error.message}`);
  return data || [];
}

export async function updateProduct(productId: string, updates: { name?: string; price?: number; category?: string; image_url?: string; description?: string } & ProductUnit) {
  const { data, error } = await supabase
    .from('products')
    .update(updates)
    .eq('id', productId)
    .filter('business_id', tenantOp(), tenantValue())
    .select()
    .maybeSingle();

  if (error) throw new Error(`Error actualizando producto: ${error.message}`);
  return data;
}

/** Elimina el producto y devuelve la fila borrada (para limpiar su foto), o null si no existía. */
export async function deleteProduct(productId: string) {
  const { data, error } = await supabase
    .from('products')
    .delete()
    .eq('id', productId)
    .filter('business_id', tenantOp(), tenantValue())
    .select()
    .maybeSingle();

  if (error) throw new Error(`Error eliminando producto: ${error.message}`);
  return data;
}

// ---------- CONFIGURACIÓN ----------
// Cada negocio guarda su prompt, datos bancarios y estado del bot con su propio prefijo de clave.

function configKey(key: string): string {
  const tenant = currentTenant();
  return tenant ? `business:${tenant.businessId}:${key}` : key;
}

export async function getConfig(key: string): Promise<string | undefined> {
  const { data, error } = await supabase
    .from('business_config')
    .select('value')
    .eq('key', configKey(key))
    .maybeSingle();

  if (error) throw new Error(`Error leyendo configuración: ${error.message}`);
  return data?.value;
}

export async function setConfig(key: string, value: string) {
  const { data, error } = await supabase
    .from('business_config')
    .upsert({ key: configKey(key), value, updated_at: new Date().toISOString() })
    .select()
    .single();

  if (error) throw new Error(`Error guardando configuración: ${error.message}`);
  return data;
}

/** El número del perfil del negocio manda; owner_phone queda para instalaciones anteriores al perfil. */
export async function getOwnerPhone(): Promise<string | null> {
  const { profile } = await import('../config/businessProfile');
  return profile().alerts.ownerPhone || (await getConfig('owner_phone')) || null;
}

// ---------- SEGUIMIENTOS AUTOMÁTICOS ----------
// Se registran en la tabla followups: 'auto_followup' por cada plantilla enviada y
// 'opt_out' cuando la clienta responde NO.

export async function recordFollowUp(conversationId: string, type: 'auto_followup' | 'opt_out', message: string) {
  const now = new Date().toISOString();
  const { error } = await supabase
    .from('followups')
    .insert([{
      id: randomUUID(),
      conversation_id: conversationId,
      type,
      message,
      scheduled_time: now,
      status: 'sent',
      created_at: now
    }]);

  if (error) throw new Error(`Error registrando seguimiento: ${error.message}`);
}

/** Lo necesario para decidir seguimientos de todos los chats con solo tres consultas. */
export async function getFollowUpActivity(days: number) {
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

  const [followUps, optOuts, orders] = await Promise.all([
    supabase.from('followups').select('conversation_id, created_at').eq('type', 'auto_followup').gte('created_at', since),
    supabase.from('followups').select('conversation_id').eq('type', 'opt_out'),
    supabase.from('orders').select('conversation_id').neq('status', 'cancelled').gte('created_at', since)
  ]);

  for (const result of [followUps, optOuts, orders]) {
    if (result.error) throw new Error(`Error leyendo actividad de seguimientos: ${result.error.message}`);
  }

  const sentByConversation = new Map<string, Date[]>();
  for (const row of followUps.data || []) {
    const list = sentByConversation.get(row.conversation_id) || [];
    list.push(parseDbTimestamp(row.created_at));
    sentByConversation.set(row.conversation_id, list);
  }

  return {
    followUps: sentByConversation,
    optedOut: new Set((optOuts.data || []).map(r => r.conversation_id)),
    withOrder: new Set((orders.data || []).map(r => r.conversation_id))
  };
}

// ---------- AVISOS A LA DUEÑA ----------

/** Evita repetir el mismo aviso cada vez que la clienta escribe en la misma conversación. */
export async function hasRecentNotification(conversationId: string, eventType: string, hours: number = 24): Promise<boolean> {
  const since = new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();
  const { data, error } = await supabase
    .from('notifications')
    .select('id')
    .eq('conversation_id', conversationId)
    .eq('event_type', eventType)
    .gte('created_at', since)
    .limit(1);

  if (error) throw new Error(`Error consultando avisos: ${error.message}`);
  return (data || []).length > 0;
}

/** Textos de los avisos recientes de un tipo en un chat (por ejemplo las preguntas ya enviadas a la dueña). */
export async function getRecentNotificationMessages(conversationId: string, eventType: string, hours: number = 24): Promise<string[]> {
  const since = new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();
  const { data, error } = await supabase
    .from('notifications')
    .select('message')
    .eq('conversation_id', conversationId)
    .eq('event_type', eventType)
    .gte('created_at', since)
    .order('created_at', { ascending: true });

  if (error) throw new Error(`Error consultando avisos: ${error.message}`);
  return (data || []).map(n => String(n.message || '')).filter(Boolean);
}

export async function logNotification(conversationId: string, eventType: string, message: string) {
  const now = new Date().toISOString();
  const { error } = await supabase
    .from('notifications')
    .insert([{
      id: randomUUID(),
      conversation_id: conversationId,
      event_type: eventType,
      message,
      sent_at: now,
      created_at: now
    }]);

  if (error) throw new Error(`Error registrando aviso: ${error.message}`);
}

// ---------- NEGOCIOS (MULTI-NEGOCIO) ----------

export interface BusinessRow {
  id: string;
  name: string;
  meta_phone_number: string | null;
  meta_phone_number_id: string | null;
  meta_access_token: string | null;
  meta_business_account_id: string | null;
  openai_api_key: string | null;
  business_profile: Record<string, any>;
  active: boolean;
  owner_phone: string | null;
  created_at: string;
  updated_at: string;
}

/** Lo que el CRM puede ver de un negocio: nunca las claves, solo si están cargadas y sus últimos 4 caracteres. */
export function toPublicBusiness(row: BusinessRow) {
  const hint = (stored: string | null) => {
    if (!stored) return '';
    try {
      return maskSecret(decryptSecret(stored));
    } catch {
      return '••••';
    }
  };
  const { meta_access_token, openai_api_key, ...rest } = row;
  return {
    ...rest,
    meta_access_token_hint: hint(meta_access_token),
    openai_api_key_hint: hint(openai_api_key),
    whatsapp_configured: !!(meta_access_token && row.meta_phone_number_id),
    openai_configured: !!openai_api_key
  };
}

function tenantFromRow(row: BusinessRow): TenantContext {
  const profile = normalizeProfile(row.business_profile, STORE_PROFILE);
  // La clave de OpenAI de las plantillas no pertenece al negocio: la suya va en su columna cifrada.
  profile.ai = { model: profile.ai?.model || 'gpt-5.4-mini' };
  return {
    businessId: row.id,
    name: row.name,
    profile,
    whatsappPhoneId: row.meta_phone_number_id || '',
    whatsappToken: decryptSecret(row.meta_access_token),
    wabaId: row.meta_business_account_id || '',
    openaiApiKey: decryptSecret(row.openai_api_key)
  };
}

// Cada mensaje consulta su negocio; un minuto de caché evita ir a la base por cada uno.
const TENANT_CACHE_MS = 60_000;
const tenantCache = new Map<string, { at: number; tenant: TenantContext | null }>();

export function invalidateTenantCache() {
  tenantCache.clear();
}

async function cachedTenant(cacheKey: string, column: 'id' | 'meta_phone_number_id', value: string): Promise<TenantContext | null> {
  const hit = tenantCache.get(cacheKey);
  if (hit && Date.now() - hit.at < TENANT_CACHE_MS) return hit.tenant;

  const { data, error } = await supabase
    .from('businesses')
    .select('*')
    .eq(column, value)
    .eq('active', true)
    .maybeSingle();

  if (error) throw new Error(`Error buscando negocio: ${error.message}`);
  const tenant = data ? tenantFromRow(data) : null;
  tenantCache.set(cacheKey, { at: Date.now(), tenant });
  return tenant;
}

/** Negocio activo con ese id, listo para atender (null si no existe o está desactivado). */
export function loadTenant(businessId: string): Promise<TenantContext | null> {
  return cachedTenant(`id:${businessId}`, 'id', businessId);
}

/** Negocio dueño del número que recibió el mensaje (Phone Number ID que Meta envía en cada webhook). */
export function getTenantByPhoneNumberId(phoneNumberId: string): Promise<TenantContext | null> {
  return cachedTenant(`phone:${phoneNumberId}`, 'meta_phone_number_id', phoneNumberId);
}

export async function getBusinessRow(businessId: string): Promise<BusinessRow | null> {
  const { data, error } = await supabase.from('businesses').select('*').eq('id', businessId).maybeSingle();
  if (error) throw new Error(`Error obteniendo negocio: ${error.message}`);
  return data;
}

/** Negocios activos con su número de WhatsApp configurado (para los seguimientos automáticos). */
export async function getActiveTenants(): Promise<TenantContext[]> {
  const { data, error } = await supabase
    .from('businesses')
    .select('*')
    .eq('active', true)
    .not('meta_phone_number_id', 'is', null)
    .not('meta_access_token', 'is', null);

  if (error) throw new Error(`Error obteniendo negocios activos: ${error.message}`);
  const tenants: TenantContext[] = [];
  for (const row of data || []) {
    try {
      tenants.push(tenantFromRow(row));
    } catch (err: any) {
      console.error(`❌ No se pudieron leer las claves del negocio ${row.name}:`, err.message);
    }
  }
  return tenants;
}

export interface BusinessCredentials {
  displayPhoneNumber?: string;
  phoneNumberId?: string;
  wabaId?: string;
  metaAccessToken?: string;
  openaiApiKey?: string;
}

/** Solo se cambian los campos enviados con valor: dejar un campo vacío en el CRM conserva la clave guardada. */
function credentialColumns(c: BusinessCredentials) {
  const clean = (v?: string) => (typeof v === 'string' ? v.trim() : '');
  const columns: Record<string, string> = {};
  if (clean(c.displayPhoneNumber)) columns.meta_phone_number = clean(c.displayPhoneNumber).replace(/[^\d+]/g, '');
  if (clean(c.phoneNumberId)) columns.meta_phone_number_id = clean(c.phoneNumberId).replace(/\D/g, '');
  if (clean(c.wabaId)) columns.meta_business_account_id = clean(c.wabaId).replace(/\D/g, '');
  // Al copiar de Meta o de OpenAI se cuelan saltos de línea y espacios: dejarlos rompe la clave.
  const cleanSecret = (v?: string) => clean(v).replace(/\s+/g, '');
  if (cleanSecret(c.metaAccessToken)) columns.meta_access_token = encryptSecret(cleanSecret(c.metaAccessToken));
  if (cleanSecret(c.openaiApiKey)) columns.openai_api_key = encryptSecret(cleanSecret(c.openaiApiKey));
  return columns;
}

function friendlyBusinessError(error: { code?: string; message: string }, action: string) {
  if (error.code === UNIQUE_VIOLATION) return new Error('Ese número de WhatsApp ya está asignado a otro negocio');
  return new Error(`Error ${action} negocio: ${error.message}`);
}

/** Crea un negocio con su perfil inicial y, si ya se tienen, sus claves de WhatsApp y OpenAI (cifradas). */
export async function createBusiness(name: string, businessProfile: BusinessProfile, credentials: BusinessCredentials = {}) {
  const now = new Date().toISOString();
  const { data, error } = await supabase
    .from('businesses')
    .insert([{
      id: randomUUID(),
      name,
      business_profile: { ...businessProfile, ai: { model: businessProfile.ai?.model || 'gpt-5.4-mini' } },
      ...credentialColumns(credentials),
      active: true,
      created_at: now,
      updated_at: now
    }])
    .select()
    .single();

  if (error) throw friendlyBusinessError(error, 'creando');
  invalidateTenantCache();
  return toPublicBusiness(data);
}

export async function updateBusinessCredentials(businessId: string, credentials: BusinessCredentials) {
  const columns = credentialColumns(credentials);
  if (Object.keys(columns).length === 0) throw new Error('No se envió ningún dato para actualizar');
  const { data, error } = await supabase
    .from('businesses')
    .update({ ...columns, updated_at: new Date().toISOString() })
    .eq('id', businessId)
    .select()
    .maybeSingle();

  if (error) throw friendlyBusinessError(error, 'actualizando');
  invalidateTenantCache();
  // Otro número u otra cuenta de WhatsApp: hay que volver a conectarla.
  if (data && (columns.meta_phone_number_id || columns.meta_business_account_id)) {
    await markWebhookConnected(businessId, false);
  }
  return data ? toPublicBusiness(data) : null;
}

export async function updateBusinessInfo(businessId: string, updates: { name?: string; active?: boolean }) {
  const { data, error } = await supabase
    .from('businesses')
    .update({ ...updates, updated_at: new Date().toISOString() })
    .eq('id', businessId)
    .select()
    .maybeSingle();

  if (error) throw friendlyBusinessError(error, 'actualizando');
  // Suspender surte efecto al instante: sin caché, el bot deja de responder y sus usuarios quedan fuera.
  invalidateTenantCache();
  userAccessCache.clear();
  return data ? toPublicBusiness(data) : null;
}

/** Borra todos los archivos de la carpeta de la empresa en un bucket (fotos del catálogo o archivos de clientes). */
async function removeCompanyFolder(bucket: string, businessId: string): Promise<number> {
  let removed = 0;
  // Se lista y borra por tandas hasta vaciar la carpeta.
  for (let round = 0; round < 1000; round++) {
    const { data, error } = await supabase.storage.from(bucket).list(businessId, { limit: 1000 });
    if (error) throw new Error(`Error listando archivos de ${bucket}: ${error.message}`);
    const paths = (data || []).filter(f => f.name).map(f => `${businessId}/${f.name}`);
    if (paths.length === 0) break;
    const { error: removeError } = await supabase.storage.from(bucket).remove(paths);
    if (removeError) throw new Error(`Error borrando archivos de ${bucket}: ${removeError.message}`);
    removed += paths.length;
  }
  return removed;
}

/**
 * Elimina una empresa por completo y sin residuos: chats, mensajes, seguimientos, avisos, cotizaciones,
 * pedidos, catálogo, usuarios, accesos, configuración, archivos y claves. No se puede deshacer.
 * Solo acepta el id de un negocio: VELAMIA (sin business_id) nunca entra aquí.
 */
export async function deleteBusinessCompletely(businessId: string) {
  if (!/^[0-9a-f-]{36}$/i.test(businessId)) throw new Error('Id de empresa inválido');
  const row = await getBusinessRow(businessId);
  if (!row) return null;

  const summary: Record<string, number> = {};
  const count = (key: string, n: number) => { summary[key] = (summary[key] || 0) + n; };

  // 1) Todo lo que cuelga de sus conversaciones.
  const { data: conversations, error: convError } = await supabase.from('conversations').select('id').eq('business_id', businessId);
  if (convError) throw new Error(`Error leyendo conversaciones: ${convError.message}`);
  const conversationIds = (conversations || []).map(c => c.id);
  for (let i = 0; i < conversationIds.length; i += 100) {
    const chunk = conversationIds.slice(i, i + 100);
    // Orden: primero lo que depende de otras tablas (followups apunta a orders).
    for (const table of ['followups', 'notifications', 'quotations', 'orders', 'messages']) {
      const { data, error } = await supabase.from(table).delete().in('conversation_id', chunk).select('id');
      if (error) throw new Error(`Error borrando ${table}: ${error.message}`);
      count(table, (data || []).length);
    }
  }

  // 2) Tablas con business_id propio.
  for (const table of ['quotations', 'orders', 'conversations', 'products', 'business_access_tokens', 'business_users']) {
    const { data, error } = await supabase.from(table).delete().eq('business_id', businessId).select('id');
    if (error) throw new Error(`Error borrando ${table}: ${error.message}`);
    count(table, (data || []).length);
  }

  // 3) Su configuración (prompt, datos bancarios, estado del bot).
  const { data: configRows, error: configError } = await supabase
    .from('business_config')
    .delete()
    .like('key', `business:${businessId}:%`)
    .select('key');
  if (configError) throw new Error(`Error borrando configuración: ${configError.message}`);
  count('business_config', (configRows || []).length);

  // 4) Sus archivos: fotos del catálogo y archivos que enviaron sus clientes.
  for (const bucket of ['product-images', 'chat-media']) {
    count(`archivos_${bucket}`, await removeCompanyFolder(bucket, businessId));
  }

  // 5) La empresa (perfil y claves cifradas).
  const { error } = await supabase.from('businesses').delete().eq('id', businessId);
  if (error) throw new Error(`Error borrando la empresa: ${error.message}`);

  invalidateTenantCache();
  userAccessCache.clear();
  return { name: row.name, summary };
}

export async function saveTenantProfile(businessId: string, businessProfile: BusinessProfile) {
  const { error } = await supabase
    .from('businesses')
    .update({ business_profile: businessProfile, updated_at: new Date().toISOString() })
    .eq('id', businessId);

  if (error) throw new Error(`Error guardando perfil del negocio: ${error.message}`);
  invalidateTenantCache();
}

/** Todos los negocios (activos e inactivos) sin sus claves. */
export async function getAllBusinesses() {
  const { data, error } = await supabase
    .from('businesses')
    .select('*')
    .order('created_at', { ascending: false });

  if (error) throw new Error(`Error obteniendo negocios: ${error.message}`);
  const rows = data || [];
  const readiness = await Promise.all(rows.map(row => getBusinessReadiness(row)));
  return rows.map((row, i) => ({ ...toPublicBusiness(row), readiness: readiness[i] }));
}

// ---------- ¿EL BOT DE LA EMPRESA ESTÁ LISTO? ----------

/** Clave donde se anota que el número de la empresa quedó conectado al webhook (fecha). */
export const webhookConnectedKey = (businessId: string) => `business:${businessId}:whatsapp_webhook_connected`;

export async function markWebhookConnected(businessId: string, connected: boolean) {
  if (connected) {
    const { error } = await supabase
      .from('business_config')
      .upsert({ key: webhookConnectedKey(businessId), value: new Date().toISOString(), updated_at: new Date().toISOString() });
    if (error) throw new Error(`Error guardando conexión: ${error.message}`);
  } else {
    const { error } = await supabase.from('business_config').delete().eq('key', webhookConnectedKey(businessId));
    if (error) throw new Error(`Error guardando conexión: ${error.message}`);
  }
}

export interface ReadinessItem {
  key: string;
  label: string;
  ok: boolean;
  /** true = sin esto el bot no atiende; false = atiende, pero incompleto. */
  required: boolean;
  hint: string;
}

/**
 * Lista de lo que necesita una empresa para que su bot atienda bien.
 * botReady solo es true si están todas las obligatorias: WhatsApp, OpenAI y número conectado.
 */
export async function getBusinessReadiness(row: BusinessRow) {
  const prefix = `business:${row.id}:`;
  const [configResult, productsResult] = await Promise.all([
    supabase.from('business_config').select('key, value').like('key', `${prefix}%`),
    supabase.from('products').select('id', { count: 'exact', head: true }).eq('business_id', row.id)
  ]);
  if (configResult.error) throw new Error(`Error leyendo configuración: ${configResult.error.message}`);
  if (productsResult.error) throw new Error(`Error contando productos: ${productsResult.error.message}`);

  const config = new Map((configResult.data || []).map(c => [c.key.slice(prefix.length), String(c.value || '')]));
  const profile = normalizeProfile(row.business_profile, STORE_PROFILE);
  const products = productsResult.count || 0;

  const items: ReadinessItem[] = [
    {
      key: 'whatsapp', label: 'Claves de WhatsApp', required: true,
      ok: !!(row.meta_access_token && row.meta_phone_number_id && row.meta_business_account_id),
      hint: 'Carga token de Meta, Phone Number ID y WhatsApp Business Account ID en 🔑 Claves'
    },
    {
      key: 'webhook', label: 'Número conectado', required: true,
      ok: !!config.get('whatsapp_webhook_connected'),
      hint: 'Pulsa "Conectar WhatsApp" en 🔑 Claves para que los mensajes lleguen al bot'
    },
    {
      key: 'openai', label: 'Clave de OpenAI', required: true,
      ok: !!row.openai_api_key,
      hint: 'Sin esta clave el bot no puede pensar ni responder'
    },
    {
      key: 'catalog', label: 'Catálogo', required: false,
      ok: products > 0,
      hint: 'Sin productos el bot no puede mostrar fotos ni dar precios'
    },
    {
      key: 'ownerPhone', label: 'Número para avisos a la dueña', required: false,
      ok: !!(profile.alerts.ownerPhone || config.get('owner_phone')),
      hint: 'Sin él nadie se entera de pedidos, pagos ni reclamos (⚙️ Configuración)'
    },
    {
      key: 'bankDetails', label: 'Datos bancarios', required: false,
      ok: !profile.payments.transferEnabled || !!config.get('payment_transfer_info')?.trim(),
      hint: 'Si acepta transferencias, el bot necesita los datos para enviarlos (⚙️ Configuración)'
    }
  ];

  const missingRequired = items.filter(i => i.required && !i.ok);
  return {
    items,
    products,
    botReady: row.active && missingRequired.length === 0,
    summary: !row.active
      ? 'Empresa suspendida: el bot no atiende'
      : missingRequired.length
        ? `El bot NO atenderá: falta ${missingRequired.map(i => i.label.toLowerCase()).join(', ')}`
        : items.some(i => !i.ok)
          ? 'Bot listo, con configuración pendiente'
          : 'Bot listo'
  };
}

export type BusinessRole = 'owner' | 'manager' | 'staff';

/** Quién entró al CRM: su usuario, su empresa (null = VELAMIA) y su rol. */
export interface BusinessAccess {
  businessId: string | null;
  userId: string;
  role: BusinessRole;
}

// ---------- USUARIOS DE EMPRESAS (usuario y contraseña) ----------
// El usuario es el correo, único en toda la plataforma. business_id vacío = usuario de VELAMIA.

export interface BusinessUser {
  id: string;
  business_id: string | null;
  email: string;
  full_name: string;
  role: BusinessRole;
  active: boolean;
  created_at: string;
  updated_at: string;
}

const USER_COLUMNS = 'id, business_id, email, full_name, role, active, created_at, updated_at';
export const MIN_PASSWORD_LENGTH = 8;

/** scrypt con sal propia por usuario: la contraseña nunca se guarda ni se puede recuperar. */
function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, 64);
  return `scrypt:${salt.toString('base64url')}:${hash.toString('base64url')}`;
}

function verifyPassword(password: string, stored: string | null): boolean {
  const [scheme, salt, hash] = String(stored || '').split(':');
  if (scheme !== 'scrypt' || !salt || !hash) return false;
  const expected = Buffer.from(hash, 'base64url');
  const actual = scryptSync(password, Buffer.from(salt, 'base64url'), expected.length);
  return timingSafeEqual(actual, expected);
}

function checkPasswordRules(password: string) {
  if (typeof password !== 'string' || password.length < MIN_PASSWORD_LENGTH) {
    throw new Error(`La contraseña debe tener al menos ${MIN_PASSWORD_LENGTH} caracteres`);
  }
}

const companyFilter = (businessId: string | null) => (businessId ? 'eq' : 'is');

export async function createBusinessUser(
  businessId: string | null,
  email: string,
  fullName: string,
  role: BusinessRole,
  password: string
): Promise<BusinessUser> {
  checkPasswordRules(password);
  const now = new Date().toISOString();
  const { data, error } = await supabase
    .from('business_users')
    .insert([{
      id: randomUUID(),
      business_id: businessId,
      email: email.trim().toLowerCase(),
      full_name: fullName.trim(),
      role,
      password_hash: hashPassword(password),
      active: true,
      created_at: now,
      updated_at: now
    }])
    .select(USER_COLUMNS)
    .single();

  if (error?.code === UNIQUE_VIOLATION) throw new Error(`El usuario ${email} ya existe`);
  if (error) throw new Error(`Error creando usuario: ${error.message}`);
  return data as BusinessUser;
}

export async function getBusinessUsers(businessId: string | null): Promise<BusinessUser[]> {
  const { data, error } = await supabase
    .from('business_users')
    .select(USER_COLUMNS)
    .filter('business_id', companyFilter(businessId), businessId)
    .order('created_at', { ascending: true });

  if (error) throw new Error(`Error obteniendo usuarios: ${error.message}`);
  return (data || []) as BusinessUser[];
}

export async function getBusinessUser(userId: string): Promise<BusinessUser | null> {
  const { data, error } = await supabase.from('business_users').select(USER_COLUMNS).eq('id', userId).maybeSingle();
  if (error) throw new Error(`Error obteniendo usuario: ${error.message}`);
  return (data as BusinessUser) || null;
}

export async function updateBusinessUser(userId: string, updates: { full_name?: string; role?: BusinessRole; active?: boolean; password?: string }) {
  const { password, ...rest } = updates;
  const columns: Record<string, any> = { ...rest, updated_at: new Date().toISOString() };
  if (password !== undefined) {
    checkPasswordRules(password);
    columns.password_hash = hashPassword(password);
  }
  const { data, error } = await supabase
    .from('business_users')
    .update(columns)
    .eq('id', userId)
    .select(USER_COLUMNS)
    .single();

  if (error) throw new Error(`Error actualizando usuario: ${error.message}`);
  userAccessCache.delete(userId);
  return data as BusinessUser;
}

export async function deactivateBusinessUser(userId: string) {
  return updateBusinessUser(userId, { active: false });
}

/** Ingreso con usuario y contraseña. Devuelve null si no coincide o si el usuario o su empresa están desactivados. */
export async function authenticateBusinessUser(email: string, password: string): Promise<BusinessAccess | null> {
  const { data, error } = await supabase
    .from('business_users')
    .select('id, business_id, role, active, password_hash, businesses(active)')
    .eq('email', email.trim().toLowerCase())
    .maybeSingle();

  if (error) throw new Error(`Error validando usuario: ${error.message}`);
  // Se calcula el hash aunque el usuario no exista: así no se puede saber qué correos están registrados.
  const valid = verifyPassword(password, data?.password_hash || 'scrypt:AAAAAAAAAAAAAAAAAAAAAA:' + 'A'.repeat(86));
  if (!data || !valid || !data.active) return null;

  const business: any = Array.isArray(data.businesses) ? data.businesses[0] : data.businesses;
  if (data.business_id && !business?.active) return null;

  return { businessId: data.business_id, userId: data.id, role: normalizeRole(data.role) };
}

function normalizeRole(role: unknown): BusinessRole {
  return (['owner', 'manager', 'staff'].includes(String(role)) ? role : 'staff') as BusinessRole;
}

// Cada petición del CRM revisa que el usuario siga activo; un minuto de caché evita ir a la base cada vez.
const userAccessCache = new Map<string, { at: number; access: BusinessAccess | null }>();

export async function getActiveUserAccess(userId: string): Promise<BusinessAccess | null> {
  const hit = userAccessCache.get(userId);
  if (hit && Date.now() - hit.at < TENANT_CACHE_MS) return hit.access;

  const { data, error } = await supabase
    .from('business_users')
    .select('id, business_id, role, active, businesses(active)')
    .eq('id', userId)
    .maybeSingle();

  if (error) throw new Error(`Error validando usuario: ${error.message}`);
  const business: any = data && (Array.isArray(data.businesses) ? data.businesses[0] : data.businesses);
  const access = data && data.active && (!data.business_id || business?.active)
    ? { businessId: data.business_id, userId: data.id, role: normalizeRole(data.role) }
    : null;

  if (userAccessCache.size > 1000) userAccessCache.clear();
  userAccessCache.set(userId, { at: Date.now(), access });
  return access;
}

/** El propio usuario cambia su contraseña confirmando la actual. */
export async function changeOwnPassword(userId: string, currentPassword: string, newPassword: string): Promise<boolean> {
  const { data, error } = await supabase.from('business_users').select('password_hash').eq('id', userId).maybeSingle();
  if (error) throw new Error(`Error validando usuario: ${error.message}`);
  if (!data || !verifyPassword(currentPassword, data.password_hash)) return false;
  await updateBusinessUser(userId, { password: newPassword });
  return true;
}
