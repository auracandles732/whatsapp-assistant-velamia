import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { randomUUID, randomBytes, createHash } from 'crypto';
import { currentTenant, TenantContext, encryptSecret, decryptSecret, maskSecret } from './tenant';
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

// ---------- PRODUCTOS ----------

// El empaque del producto se guarda en la columna description (existía sin uso): así no hace falta migrar la base.
export async function createProduct(name: string, price: number, category: string, imageUrl?: string, packaging?: string) {
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

export async function updateProduct(productId: string, updates: { name?: string; price?: number; category?: string; image_url?: string; description?: string }) {
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
  if (clean(c.metaAccessToken)) columns.meta_access_token = encryptSecret(clean(c.metaAccessToken));
  if (clean(c.openaiApiKey)) columns.openai_api_key = encryptSecret(clean(c.openaiApiKey));
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
  invalidateTenantCache();
  accessCache.clear();
  return data ? toPublicBusiness(data) : null;
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
  return (data || []).map(toPublicBusiness);
}

// ---------- TOKENS DE ACCESO DE NEGOCIOS ----------
// El token se muestra una sola vez; en la base queda solo su hash SHA-256.

const TOKEN_DAYS = 90;
const hashToken = (plaintoken: string) => createHash('sha256').update(plaintoken).digest('hex');

export type BusinessRole = 'owner' | 'manager' | 'staff';

export interface BusinessAccess {
  tokenId: string;
  businessId: string;
  userId: string | null;
  role: BusinessRole;
}

export async function createBusinessAccessToken(businessId: string, businessUserId?: string) {
  const plaintoken = randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + TOKEN_DAYS * 24 * 60 * 60 * 1000).toISOString();

  const { data, error } = await supabase
    .from('business_access_tokens')
    .insert([{
      id: randomUUID(),
      business_id: businessId,
      business_user_id: businessUserId || null,
      token_hash: hashToken(plaintoken),
      active: true,
      created_at: new Date().toISOString(),
      expires_at: expiresAt
    }])
    .select('id')
    .single();

  if (error) throw new Error(`Error creando token de acceso: ${error.message}`);
  return { plaintoken, tokenId: data.id as string, expiresAt };
}

/** Revisa que el token siga activo y vigente, y que su negocio y su usuario sigan activos. */
async function checkAccess(column: 'token_hash' | 'id', value: string): Promise<BusinessAccess | null> {
  const { data, error } = await supabase
    .from('business_access_tokens')
    .select('id, business_id, business_user_id, expires_at, active, businesses(active), business_users(active, role)')
    .eq(column, value)
    .maybeSingle();

  if (error) throw new Error(`Error validando token: ${error.message}`);
  if (!data || !data.active) return null;
  if (data.expires_at && parseDbTimestamp(data.expires_at) < new Date()) return null;

  const business: any = Array.isArray(data.businesses) ? data.businesses[0] : data.businesses;
  if (!business?.active) return null;

  const user: any = Array.isArray(data.business_users) ? data.business_users[0] : data.business_users;
  if (data.business_user_id && !user?.active) return null;

  return {
    tokenId: data.id,
    businessId: data.business_id,
    userId: data.business_user_id || null,
    role: (['owner', 'manager', 'staff'].includes(user?.role) ? user.role : 'owner') as BusinessRole
  };
}

/** Valida el token que escribe el dueño del negocio al entrar al CRM. */
export async function validateBusinessAccessToken(plaintoken: string): Promise<BusinessAccess | null> {
  if (!/^[0-9a-f]{64}$/i.test(plaintoken)) return null;
  const access = await checkAccess('token_hash', hashToken(plaintoken.toLowerCase()));
  if (access) {
    const { error } = await supabase.from('business_access_tokens').update({ last_used: new Date().toISOString() }).eq('id', access.tokenId);
    if (error) console.error('No se pudo registrar el uso del token:', error.message);
  }
  return access;
}

// La sesión del CRM se revisa en cada petición: un minuto de caché basta para que revocar surta efecto rápido.
const accessCache = new Map<string, { at: number; access: BusinessAccess | null }>();

export async function getActiveAccessById(tokenId: string): Promise<BusinessAccess | null> {
  const hit = accessCache.get(tokenId);
  if (hit && Date.now() - hit.at < TENANT_CACHE_MS) return hit.access;
  const access = await checkAccess('id', tokenId);
  if (accessCache.size > 1000) accessCache.clear();
  accessCache.set(tokenId, { at: Date.now(), access });
  return access;
}

export async function listBusinessAccessTokens(businessId: string) {
  const { data, error } = await supabase
    .from('business_access_tokens')
    .select('id, business_user_id, created_at, last_used, expires_at, active, business_users(email, full_name)')
    .eq('business_id', businessId)
    .order('created_at', { ascending: false });

  if (error) throw new Error(`Error obteniendo tokens: ${error.message}`);
  return data || [];
}

export async function revokeBusinessAccessToken(businessId: string, tokenId: string): Promise<boolean> {
  const { data, error } = await supabase
    .from('business_access_tokens')
    .update({ active: false })
    .eq('id', tokenId)
    .eq('business_id', businessId)
    .select('id');

  if (error) throw new Error(`Error revocando token: ${error.message}`);
  accessCache.delete(tokenId);
  return (data || []).length > 0;
}

// ---------- BUSINESS USERS ----------

export interface BusinessUser {
  id: string;
  business_id: string;
  email: string;
  full_name: string;
  role: 'owner' | 'manager' | 'staff';
  active: boolean;
  created_at: string;
  updated_at: string;
}

/** Crea un nuevo usuario para un negocio. */
export async function createBusinessUser(
  businessId: string,
  email: string,
  fullName: string,
  role: 'owner' | 'manager' | 'staff' = 'owner'
): Promise<BusinessUser> {
  const now = new Date().toISOString();
  const { data, error } = await supabase
    .from('business_users')
    .insert([{
      id: randomUUID(),
      business_id: businessId,
      email,
      full_name: fullName,
      role,
      active: true,
      created_at: now,
      updated_at: now
    }])
    .select()
    .single();

  if (error?.code === UNIQUE_VIOLATION) {
    throw new Error(`El email ${email} ya existe en este negocio`);
  }
  if (error) throw new Error(`Error creando usuario: ${error.message}`);
  return data;
}

/** Obtiene todos los usuarios de un negocio. */
export async function getBusinessUsers(businessId: string): Promise<BusinessUser[]> {
  const { data, error } = await supabase
    .from('business_users')
    .select('*')
    .eq('business_id', businessId)
    .eq('active', true)
    .order('created_at', { ascending: false });

  if (error) throw new Error(`Error obteniendo usuarios: ${error.message}`);
  return data || [];
}

/** Obtiene un usuario específico. */
export async function getBusinessUser(userId: string): Promise<BusinessUser | null> {
  const { data, error } = await supabase
    .from('business_users')
    .select('*')
    .eq('id', userId)
    .maybeSingle();

  if (error) throw new Error(`Error obteniendo usuario: ${error.message}`);
  return data || null;
}

/** Actualiza un usuario. */
export async function updateBusinessUser(userId: string, updates: Partial<BusinessUser>) {
  const { data, error } = await supabase
    .from('business_users')
    .update({ ...updates, updated_at: new Date().toISOString() })
    .eq('id', userId)
    .select()
    .single();

  if (error) throw new Error(`Error actualizando usuario: ${error.message}`);
  return data;
}

/** Desactiva un usuario (soft delete). */
export async function deactivateBusinessUser(userId: string) {
  const user = await updateBusinessUser(userId, { active: false });
  // Un usuario desactivado no debe poder seguir entrando con tokens que ya tenía.
  const { error } = await supabase.from('business_access_tokens').update({ active: false }).eq('business_user_id', userId);
  if (error) throw new Error(`Error revocando tokens del usuario: ${error.message}`);
  accessCache.clear();
  return user;
}
