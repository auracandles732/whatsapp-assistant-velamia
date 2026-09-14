import { v4 as uuidv4 } from 'uuid';
import { runQuery, getQuery, allQuery } from '../db.js';
import { sendTextMessage } from '../services/whatsapp.js';
import { generateFollowUp } from '../services/openai.js';

export interface OrderInput {
  conversationId: string;
  phoneNumber: string;
  customerName: string;
  products: { name: string; quantity: number; price: number }[];
  deliveryAddress: string;
  paymentMethod?: string;
}

export async function createOrder(orderData: OrderInput) {
  try {
    const orderId = uuidv4();
    const totalAmount = orderData.products.reduce((sum, p) => sum + (p.price * p.quantity), 0);

    await runQuery(
      `INSERT INTO orders (id, conversation_id, customer_name, customer_phone, customer_address, products, total_amount, status, payment_method, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        orderId,
        orderData.conversationId,
        orderData.customerName,
        orderData.phoneNumber,
        orderData.deliveryAddress,
        JSON.stringify(orderData.products),
        totalAmount,
        'pending',
        orderData.paymentMethod || 'undefined',
        new Date().toISOString()
      ]
    );

    // Enviar confirmación
    const productSummary = orderData.products.map(p => `• ${p.name} x${p.quantity}`).join('\n');
    const orderMessage = `🎉 ¡Pedido confirmado!\n\nID: ${orderId.substring(0, 8).toUpperCase()}\n\nProductos:\n${productSummary}\n\nTotal: $${totalAmount.toFixed(2)}\nEntrega en: ${orderData.deliveryAddress}\n\nNos pondremos en contacto para confirmar detalles de envío.`;

    await sendTextMessage(orderData.phoneNumber, orderMessage);

    return orderId;
  } catch (error) {
    console.error('Error creando pedido:', error);
    throw error;
  }
}

export async function getOrder(orderId: string) {
  return await getQuery(
    'SELECT * FROM orders WHERE id = ?',
    [orderId]
  );
}

export async function getOrdersByConversation(conversationId: string) {
  return await allQuery(
    'SELECT * FROM orders WHERE conversation_id = ? ORDER BY created_at DESC',
    [conversationId]
  );
}

export async function updateOrderStatus(orderId: string, status: 'pending' | 'confirmed' | 'shipped' | 'delivered' | 'cancelled') {
  await runQuery(
    'UPDATE orders SET status = ? WHERE id = ?',
    [status, orderId]
  );

  const order = await getOrder(orderId);
  if (order) {
    const statusMessages: { [key: string]: string } = {
      pending: '⏳ Tu pedido está siendo procesado...',
      confirmed: '✅ Tu pedido ha sido confirmado',
      shipped: '📦 Tu pedido ha sido enviado',
      delivered: '🎉 Tu pedido ha sido entregado',
      cancelled: '❌ Tu pedido ha sido cancelado'
    };

    const followUpMessage = await generateFollowUp(statusMessages[status], order.customer_name);
    await sendTextMessage(order.customer_phone, followUpMessage);
  }
}

export async function createFollowUp(
  conversationId: string,
  orderId: string,
  followUpType: 'reminder' | 'update' | 'feedback',
  scheduledTime: Date
) {
  try {
    const followUpId = uuidv4();
    const order = await getOrder(orderId);

    let followUpMessage = '';
    switch (followUpType) {
      case 'reminder':
        followUpMessage = `👋 Hola ${order.customer_name}, ¿cómo va tu pedido ${orderId.substring(0, 8).toUpperCase()}? Si tienes dudas, escríbenos.`;
        break;
      case 'update':
        followUpMessage = `📦 Actualización de tu pedido: ${orderId.substring(0, 8).toUpperCase()}. Estamos trabajando para entregarlo pronto.`;
        break;
      case 'feedback':
        followUpMessage = `⭐ ¿Ya recibiste tu pedido? Nos encantaría conocer tu opinión sobre VELAMIA.`;
        break;
    }

    await runQuery(
      `INSERT INTO followups (id, conversation_id, order_id, type, message, scheduled_time, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        followUpId,
        conversationId,
        orderId,
        followUpType,
        followUpMessage,
        scheduledTime.toISOString(),
        'pending',
        new Date().toISOString()
      ]
    );

    return followUpId;
  } catch (error) {
    console.error('Error creando seguimiento:', error);
    throw error;
  }
}

export async function getPendingFollowUps(limit: number = 10) {
  return await allQuery(
    `SELECT * FROM followups
     WHERE status = 'pending' AND scheduled_time <= datetime('now')
     ORDER BY scheduled_time ASC
     LIMIT ?`,
    [limit]
  );
}

export async function sendPendingFollowUps() {
  try {
    const pendingFollowUps = await getPendingFollowUps();

    for (const followUp of pendingFollowUps) {
      const order = await getOrder(followUp.order_id);
      if (order) {
        await sendTextMessage(order.customer_phone, followUp.message);

        await runQuery(
          'UPDATE followups SET status = ? WHERE id = ?',
          ['sent', followUp.id]
        );

        console.log(`✅ Seguimiento enviado: ${followUp.id}`);
      }
    }
  } catch (error) {
    console.error('Error enviando seguimientos:', error);
  }
}

export async function closeSale(conversationId: string, orderId: string) {
  try {
    // Actualizar estado de conversación
    await runQuery(
      'UPDATE conversations SET status = ? WHERE id = ?',
      ['closed', conversationId]
    );

    // Actualizar estado de pedido
    await updateOrderStatus(orderId, 'confirmed');

    // Crear seguimiento de feedback
    const followUpDate = new Date();
    followUpDate.setDate(followUpDate.getDate() + 3); // Seguimiento en 3 días

    await createFollowUp(conversationId, orderId, 'feedback', followUpDate);

    console.log(`✅ Venta cerrada: ${orderId}`);
  } catch (error) {
    console.error('Error cerrando venta:', error);
    throw error;
  }
}
