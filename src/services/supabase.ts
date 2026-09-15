import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { v4 as uuidv4 } from 'uuid';

const SUPABASE_URL = process.env.SUPABASE_URL!;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY!;

export const supabase: SupabaseClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

// CONVERSACIONES
export async function createConversation(phoneNumber: string, customerName?: string) {
  const { data, error } = await supabase
    .from('conversations')
    .insert([{
      id: uuidv4(),
      phone_number: phoneNumber,
      customer_name: customerName,
      status: 'active',
      last_message_time: new Date().toISOString(),
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    }])
    .select()
    .single();

  if (error) throw new Error(`Error creando conversación: ${error.message}`);
  return data;
}

export async function getConversation(phoneNumber: string) {
  const { data, error } = await supabase
    .from('conversations')
    .select('*')
    .eq('phone_number', phoneNumber)
    .single();

  if (error && error.code !== 'PGRST116') throw error;
  return data;
}

export async function getConversationById(conversationId: string) {
  const { data, error } = await supabase
    .from('conversations')
    .select('*')
    .eq('id', conversationId)
    .single();

  if (error && error.code !== 'PGRST116') throw error;
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

export async function updateConversation(conversationId: string, updates: any) {
  const { data, error } = await supabase
    .from('conversations')
    .update({
      ...updates,
      updated_at: new Date().toISOString()
    })
    .eq('id', conversationId)
    .select()
    .single();

  if (error) throw new Error(`Error actualizando conversación: ${error.message}`);
  return data;
}

export async function getAllConversations() {
  const { data, error } = await supabase
    .from('conversations')
    .select('*')
    .order('last_message_time', { ascending: false });

  if (error) throw new Error(`Error obteniendo conversaciones: ${error.message}`);
  return data || [];
}

// MENSAJES
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
  const { data, error } = await supabase
    .from('messages')
    .select('id')
    .eq('wa_message_id', waMessageId)
    .maybeSingle();

  if (error) throw new Error(`Error verificando mensaje duplicado: ${error.message}`);
  return !!data;
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

export async function getConversationHistory(conversationId: string, limit: number = 10) {
  const { data, error } = await supabase
    .from('messages')
    .select('*')
    .eq('conversation_id', conversationId)
    .order('timestamp', { ascending: false })
    .limit(limit);

  if (error) throw new Error(`Error obteniendo historial: ${error.message}`);
  return data?.reverse() || [];
}

export async function deleteOldMessages(conversationId: string, daysOld: number = 90) {
  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - daysOld);

  const { error } = await supabase
    .from('messages')
    .delete()
    .eq('conversation_id', conversationId)
    .lt('timestamp', cutoffDate.toISOString());

  if (error) throw new Error(`Error eliminando mensajes: ${error.message}`);
}

// COTIZACIONES
export async function createQuotation(conversationId: string, phoneNumber: string, products: any, totalAmount: number) {
  const expiresAt = new Date();
  expiresAt.setDate(expiresAt.getDate() + 3);

  const { data, error } = await supabase
    .from('quotations')
    .insert([{
      id: uuidv4(),
      conversation_id: conversationId,
      customer_phone: phoneNumber,
      products: JSON.stringify(products),
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

export async function getQuotation(quotationId: string) {
  const { data, error } = await supabase
    .from('quotations')
    .select('*')
    .eq('id', quotationId)
    .single();

  if (error && error.code !== 'PGRST116') throw error;
  return data;
}

export async function getQuotationsByConversation(conversationId: string) {
  const { data, error } = await supabase
    .from('quotations')
    .select('*')
    .eq('conversation_id', conversationId)
    .order('created_at', { ascending: false });

  if (error) throw new Error(`Error obteniendo cotizaciones: ${error.message}`);
  return data || [];
}

export async function updateQuotationStatus(quotationId: string, status: 'pending' | 'accepted' | 'expired') {
  const { data, error } = await supabase
    .from('quotations')
    .update({ status })
    .eq('id', quotationId)
    .select()
    .single();

  if (error) throw new Error(`Error actualizando cotización: ${error.message}`);
  return data;
}

export async function getExpiredQuotations() {
  const { data, error } = await supabase
    .from('quotations')
    .select('*')
    .eq('status', 'pending')
    .lt('expires_at', new Date().toISOString());

  if (error) throw new Error(`Error obteniendo cotizaciones expiradas: ${error.message}`);
  return data || [];
}

// PEDIDOS
export async function createOrder(conversationId: string, phoneNumber: string, customerName: string, products: any, totalAmount: number, address?: string) {
  const { data, error } = await supabase
    .from('orders')
    .insert([{
      id: uuidv4(),
      conversation_id: conversationId,
      customer_name: customerName,
      customer_phone: phoneNumber,
      customer_address: address,
      products: JSON.stringify(products),
      total_amount: totalAmount,
      status: 'pending',
      created_at: new Date().toISOString()
    }])
    .select()
    .single();

  if (error) throw new Error(`Error creando pedido: ${error.message}`);
  return data;
}

export async function getOrder(orderId: string) {
  const { data, error } = await supabase
    .from('orders')
    .select('*')
    .eq('id', orderId)
    .single();

  if (error && error.code !== 'PGRST116') throw error;
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

export async function updateOrderStatus(orderId: string, status: 'pending' | 'confirmed' | 'shipped' | 'delivered' | 'cancelled') {
  const { data, error } = await supabase
    .from('orders')
    .update({ status })
    .eq('id', orderId)
    .select()
    .single();

  if (error) throw new Error(`Error actualizando pedido: ${error.message}`);
  return data;
}

export async function getOrdersByStatus(status: string) {
  const { data, error } = await supabase
    .from('orders')
    .select('*')
    .eq('status', status)
    .order('created_at', { ascending: true });

  if (error) throw new Error(`Error obteniendo pedidos por estado: ${error.message}`);
  return data || [];
}

export async function getSalesMetrics(days: number = 30) {
  const startDate = new Date();
  startDate.setDate(startDate.getDate() - days);

  const { data, error } = await supabase
    .from('orders')
    .select('total_amount, status, created_at')
    .gte('created_at', startDate.toISOString());

  if (error) throw new Error(`Error obteniendo métricas: ${error.message}`);

  const metrics = {
    totalOrders: data?.length || 0,
    totalRevenue: data?.reduce((sum, o) => sum + (o.total_amount || 0), 0) || 0,
    deliveredOrders: data?.filter(o => o.status === 'delivered').length || 0,
    pendingOrders: data?.filter(o => o.status === 'pending').length || 0,
    averageOrderValue: data?.length ? (data.reduce((sum, o) => sum + (o.total_amount || 0), 0) / data.length) : 0
  };

  return metrics;
}

// SEGUIMIENTOS
export async function createFollowUp(conversationId: string, orderId: string, type: 'reminder' | 'update' | 'feedback', message: string, scheduledTime: Date) {
  const { data, error } = await supabase
    .from('followups')
    .insert([{
      id: uuidv4(),
      conversation_id: conversationId,
      order_id: orderId,
      type,
      message,
      scheduled_time: scheduledTime.toISOString(),
      status: 'pending',
      created_at: new Date().toISOString()
    }])
    .select()
    .single();

  if (error) throw new Error(`Error creando seguimiento: ${error.message}`);
  return data;
}

export async function getPendingFollowUps(limit: number = 10) {
  const { data, error } = await supabase
    .from('followups')
    .select('*')
    .eq('status', 'pending')
    .lte('scheduled_time', new Date().toISOString())
    .order('scheduled_time', { ascending: true })
    .limit(limit);

  if (error) throw new Error(`Error obteniendo seguimientos pendientes: ${error.message}`);
  return data || [];
}

export async function markFollowUpAsSent(followUpId: string) {
  const { data, error } = await supabase
    .from('followups')
    .update({ status: 'sent' })
    .eq('id', followUpId)
    .select()
    .single();

  if (error) throw new Error(`Error marcando seguimiento como enviado: ${error.message}`);
  return data;
}

export async function getFollowUpsByOrder(orderId: string) {
  const { data, error } = await supabase
    .from('followups')
    .select('*')
    .eq('order_id', orderId)
    .order('created_at', { ascending: false });

  if (error) throw new Error(`Error obteniendo seguimientos: ${error.message}`);
  return data || [];
}

// PRODUCTOS
export async function createProduct(name: string, description: string, price: number, stock: number, category: string, imageUrl?: string) {
  const { data, error } = await supabase
    .from('products')
    .insert([{
      id: uuidv4(),
      name,
      description,
      price,
      stock,
      category,
      image_url: imageUrl,
      created_at: new Date().toISOString()
    }])
    .select()
    .single();

  if (error) throw new Error(`Error creando producto: ${error.message}`);
  return data;
}

export async function getProduct(productId: string) {
  const { data, error } = await supabase
    .from('products')
    .select('*')
    .eq('id', productId)
    .single();

  if (error && error.code !== 'PGRST116') throw error;
  return data;
}

/** Busca por categoría o nombre, sin distinguir mayúsculas ni coincidencia exacta. */
export async function searchProducts(term: string) {
  const safeTerm = term.replace(/[%,()]/g, '');
  if (!safeTerm.trim()) return [];

  const { data, error } = await supabase
    .from('products')
    .select('*')
    .or(`category.ilike.%${safeTerm}%,name.ilike.%${safeTerm}%`)
    .order('name', { ascending: true });

  if (error) throw new Error(`Error buscando productos: ${error.message}`);
  return data || [];
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

export async function updateProductStock(productId: string, newStock: number) {
  const { data, error } = await supabase
    .from('products')
    .update({ stock: newStock })
    .eq('id', productId)
    .select()
    .single();

  if (error) throw new Error(`Error actualizando stock: ${error.message}`);
  return data;
}

export async function updateProduct(productId: string, updates: { name?: string; price?: number; category?: string; image_url?: string; description?: string }) {
  const { data, error } = await supabase
    .from('products')
    .update(updates)
    .eq('id', productId)
    .select()
    .single();

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

export async function decreaseProductStock(productId: string, quantity: number) {
  const product = await getProduct(productId);
  if (!product) throw new Error('Producto no encontrado');

  return updateProductStock(productId, Math.max(0, product.stock - quantity));
}

// CONFIGURACIÓN
export async function getConfig(key: string) {
  const { data, error } = await supabase
    .from('business_config')
    .select('value')
    .eq('key', key)
    .single();

  if (error && error.code !== 'PGRST116') throw error;
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

// ANALYTICS
export async function getConversationCount() {
  const { count, error } = await supabase
    .from('conversations')
    .select('*', { count: 'exact' });

  if (error) throw new Error(`Error contando conversaciones: ${error.message}`);
  return count || 0;
}

export async function getActiveConversations(hoursAgo: number = 24) {
  const cutoffTime = new Date();
  cutoffTime.setHours(cutoffTime.getHours() - hoursAgo);

  const { data, error } = await supabase
    .from('conversations')
    .select('*')
    .gte('last_message_time', cutoffTime.toISOString());

  if (error) throw new Error(`Error obteniendo conversaciones activas: ${error.message}`);
  return data || [];
}

export async function getTotalRevenue() {
  const { data, error } = await supabase
    .from('orders')
    .select('total_amount')
    .eq('status', 'delivered');

  if (error) throw new Error(`Error calculando ingresos: ${error.message}`);
  return data?.reduce((sum, o) => sum + (o.total_amount || 0), 0) || 0;
}

// PAUSA DEL BOT (Punto 1)
/**
 * Pausa el bot en una conversación por un tiempo determinado.
 * Cuando el usuario escribe manualmente, se pausa automáticamente.
 */
export async function pauseBotUntil(conversationId: string, minutes: number = 10) {
  const pausedUntil = new Date();
  pausedUntil.setMinutes(pausedUntil.getMinutes() + minutes);

  const { error } = await supabase
    .from('conversations')
    .update({ bot_paused_until: pausedUntil.toISOString() })
    .eq('id', conversationId);

  if (error) throw new Error(`Error pausando bot: ${error.message}`);
}

/**
 * Reanuda el bot en una conversación.
 */
export async function resumeBot(conversationId: string) {
  const { error } = await supabase
    .from('conversations')
    .update({ bot_paused_until: null })
    .eq('id', conversationId);

  if (error) throw new Error(`Error reanudando bot: ${error.message}`);
}

/**
 * Verifica si el bot está pausado en esta conversación.
 */
export async function isBotPaused(conversationId: string): Promise<boolean> {
  const { data, error } = await supabase
    .from('conversations')
    .select('bot_paused_until')
    .eq('id', conversationId)
    .single();

  if (error) throw new Error(`Error verificando pausa del bot: ${error.message}`);
  if (!data?.bot_paused_until) return false;

  const pausedUntil = new Date(data.bot_paused_until);
  return pausedUntil > new Date();
}

// NOTIFICACIONES (Punto 2)
/**
 * Obtiene el número de teléfono del dueño para notificaciones.
 */
export async function getOwnerPhone(): Promise<string | null> {
  const value = await getConfig('owner_phone');
  return value || null;
}

/**
 * Registra que se envió una notificación al dueño.
 */
export async function logNotification(conversationId: string, eventType: string, message: string) {
  const { error } = await supabase
    .from('notifications')
    .insert([{
      id: uuidv4(),
      conversation_id: conversationId,
      event_type: eventType,
      message,
      sent_at: new Date().toISOString(),
      created_at: new Date().toISOString()
    }]);

  if (error) throw new Error(`Error registrando notificación: ${error.message}`);
}
