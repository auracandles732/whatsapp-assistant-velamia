import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { v4 as uuidv4 } from 'uuid';

// Cliente único con la service key: ignora RLS, por eso solo se usa en el servidor.
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

// ---------- CONVERSACIONES ----------

export async function getConversation(phoneNumber: string) {
  const { data, error } = await supabase
    .from('conversations')
    .select('*')
    .eq('phone_number', phoneNumber)
    .maybeSingle();

  if (error) throw new Error(`Error obteniendo conversación: ${error.message}`);
  return data;
}

export async function createConversation(phoneNumber: string, customerName?: string) {
  const now = new Date().toISOString();
  const { data, error } = await supabase
    .from('conversations')
    .insert([{
      id: uuidv4(),
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
    .eq('id', conversationId);

  if (error) throw new Error(`Error actualizando actividad: ${error.message}`);
}

export async function getAllConversations() {
  const { data, error } = await supabase
    .from('conversations')
    .select('*')
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
      id: uuidv4(),
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

export async function getMessages(conversationId: string, limit: number = 200) {
  const { data, error } = await supabase
    .from('messages')
    .select('*')
    .eq('conversation_id', conversationId)
    .order('timestamp', { ascending: true })
    .limit(limit);

  if (error) throw new Error(`Error obteniendo mensajes: ${error.message}`);
  return data || [];
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
    .eq('id', conversationId);

  if (error) throw new Error(`Error pausando bot: ${error.message}`);
}

export async function resumeBot(conversationId: string) {
  const { error } = await supabase
    .from('conversations')
    .update({ bot_paused_until: null })
    .eq('id', conversationId);

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
      id: uuidv4(),
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
    .lt('expires_at', new Date().toISOString());

  if (expireError) throw new Error(`Error actualizando cotizaciones vencidas: ${expireError.message}`);

  const { data, error } = await supabase
    .from('quotations')
    .select('*, conversations(customer_name, phone_number)')
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
    .select()
    .maybeSingle();

  if (error) throw new Error(`Error actualizando cotización: ${error.message}`);
  return data;
}

// ---------- PEDIDOS ----------

export async function createOrder(conversationId: string, phoneNumber: string, customerName: string, products: any[], totalAmount: number) {
  const { data, error } = await supabase
    .from('orders')
    .insert([{
      id: uuidv4(),
      conversation_id: conversationId,
      customer_name: customerName,
      customer_phone: phoneNumber,
      products,
      total_amount: totalAmount,
      status: 'pending',
      created_at: new Date().toISOString()
    }])
    .select()
    .single();

  if (error) throw new Error(`Error creando pedido: ${error.message}`);
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

export async function updateOrderItems(orderId: string, products: any[], totalAmount: number) {
  const { data, error } = await supabase
    .from('orders')
    .update({ products, total_amount: totalAmount })
    .eq('id', orderId)
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
    .gte('created_at', startDate.toISOString());

  if (error) throw new Error(`Error obteniendo métricas: ${error.message}`);

  const orders = data || [];
  return {
    totalOrders: orders.length,
    totalRevenue: orders.reduce((sum, o) => sum + Number(o.total_amount || 0), 0)
  };
}

// ---------- PRODUCTOS ----------

export async function createProduct(name: string, price: number, category: string, imageUrl?: string) {
  const { data, error } = await supabase
    .from('products')
    .insert([{
      id: uuidv4(),
      name,
      description: '',
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
    .order('category', { ascending: true })
    .order('name', { ascending: true });

  if (error) throw new Error(`Error obteniendo catálogo: ${error.message}`);
  return data || [];
}

export async function updateProduct(productId: string, updates: { name?: string; price?: number; category?: string; image_url?: string }) {
  const { data, error } = await supabase
    .from('products')
    .update(updates)
    .eq('id', productId)
    .select()
    .maybeSingle();

  if (error) throw new Error(`Error actualizando producto: ${error.message}`);
  return data;
}

export async function deleteProduct(productId: string) {
  const { error } = await supabase
    .from('products')
    .delete()
    .eq('id', productId);

  if (error) throw new Error(`Error eliminando producto: ${error.message}`);
}

// ---------- CONFIGURACIÓN ----------

export async function getConfig(key: string): Promise<string | undefined> {
  const { data, error } = await supabase
    .from('business_config')
    .select('value')
    .eq('key', key)
    .maybeSingle();

  if (error) throw new Error(`Error leyendo configuración: ${error.message}`);
  return data?.value;
}

export async function setConfig(key: string, value: string) {
  const { data, error } = await supabase
    .from('business_config')
    .upsert({ key, value, updated_at: new Date().toISOString() })
    .select()
    .single();

  if (error) throw new Error(`Error guardando configuración: ${error.message}`);
  return data;
}

export async function getOwnerPhone(): Promise<string | null> {
  return (await getConfig('owner_phone')) || null;
}

// ---------- AVISOS A LA DUEÑA ----------

export async function logNotification(conversationId: string, eventType: string, message: string) {
  const now = new Date().toISOString();
  const { error } = await supabase
    .from('notifications')
    .insert([{
      id: uuidv4(),
      conversation_id: conversationId,
      event_type: eventType,
      message,
      sent_at: now,
      created_at: now
    }]);

  if (error) throw new Error(`Error registrando aviso: ${error.message}`);
}
