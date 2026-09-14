import { v4 as uuidv4 } from 'uuid';
import {
  getConversation,
  createConversation,
  getConversationHistory,
  saveMessage,
  updateConversation,
  createQuotation,
  createOrder,
  getOrdersByConversation,
  getConfig,
  getAllProducts,
  getProductsByCategory
} from '../db';
import { sendTextMessage, sendImageMessage } from '../services/whatsapp';
import { generateResponse, analyzeUserIntent } from '../services/openai';

export async function handleWebhookMessage(message: any, changes: any) {
  try {
    const phoneNumber = message.from;
    const messageId = message.id;
    const timestamp = message.timestamp;
    const messageType = message.type;

    console.log(`📱 Mensaje recibido de ${phoneNumber} (${messageType})`);

    // Obtener o crear conversación
    let conversation = await getConversation(phoneNumber);

    if (!conversation) {
      conversation = await createConversation(phoneNumber);
    }

    const conversationId = conversation.id;

    // Extraer contenido del mensaje
    let userContent = '';
    if (messageType === 'text') {
      userContent = message.text.body;
    } else if (messageType === 'image') {
      userContent = `[Cliente envió imagen]: ${message.image.caption || 'sin descripción'}`;
    } else if (messageType === 'document') {
      userContent = `[Cliente envió documento]: ${message.document.filename}`;
    } else {
      userContent = `[Mensaje tipo: ${messageType}]`;
    }

    // Guardar mensaje recibido
    await saveMessage(conversationId, 'customer', messageType, userContent);

    // Actualizar última actividad de conversación (siempre, incluso si el bot está apagado)
    await updateConversation(conversationId, { status: 'active' });

    // Verificar si el bot está activo (control manual desde el CRM)
    const botEnabled = await getConfig('bot_enabled');
    if (botEnabled === 'false') {
      console.log('🚫 Bot desactivado - mensaje guardado, esperando respuesta manual');
      return;
    }

    // Analizar intención
    const intent = await analyzeUserIntent(userContent);
    console.log(`🎯 Intención detectada: ${intent.intent}`);

    // Obtener historial de conversación
    const history = await getConversationHistory(conversationId, 5);
    const conversationHistory: { role: 'user' | 'assistant'; content: string }[] = history.map((msg: any) => ({
      role: msg.sender === 'customer' ? 'user' as const : 'assistant' as const,
      content: msg.content
    }));

    // Generar respuesta con IA
    const { response: aiResponse } = await generateResponse(conversationHistory, userContent);
    console.log(`🤖 Respuesta IA generada`);

    // Enviar respuesta al cliente
    await sendTextMessage(phoneNumber, aiResponse);
    await saveMessage(conversationId, 'bot', 'text', aiResponse);

    // Procesar según intención detectada
    if (intent.intent === 'product_inquiry') {
      await handleProductInquiry(conversationId, phoneNumber, intent.entities || []);
    } else if (intent.intent === 'quotation') {
      await handleQuotationIntent(conversationId, phoneNumber, userContent);
    } else if (intent.intent === 'order') {
      await handleOrderIntent(conversationId, phoneNumber, userContent);
    } else if (intent.intent === 'delivery_status') {
      await handleDeliveryStatusIntent(conversationId, phoneNumber);
    }

  } catch (error) {
    console.error('❌ Error en handleWebhookMessage:', error);
  }
}

async function handleProductInquiry(conversationId: string, phoneNumber: string, entities: string[]) {
  try {
    console.log('🕯️ Buscando productos para enviar fotos...');

    let products = await getAllProducts();

    // Si el cliente mencionó una categoría/evento específico, filtrar
    const searchTerm = entities.find(e => typeof e === 'string');
    if (searchTerm) {
      const filtered = await getProductsByCategory(searchTerm);
      if (filtered && filtered.length > 0) {
        products = filtered;
      }
    }

    if (!products || products.length === 0) {
      return;
    }

    // Enviar hasta 3 fotos de productos con precio y descripción
    const toSend = products.slice(0, 3);
    for (const product of toSend) {
      if (product.image_url) {
        const caption = `🕯️ *${product.name}*\n${product.description}\n💰 $${product.price}`;
        await sendImageMessage(phoneNumber, product.image_url, caption);
        await saveMessage(conversationId, 'bot', 'image', caption);
      }
    }
  } catch (error) {
    console.error('❌ Error enviando fotos de productos:', error);
  }
}

async function handleQuotationIntent(conversationId: string, phoneNumber: string, message: string) {
  try {
    console.log('📋 Procesando solicitud de cotización...');

    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + 3);

    const products = [{ name: 'Vela Aromática Premium', price: 25.00, quantity: 1 }];
    const totalAmount = 25.00;

    const quotation = await createQuotation(conversationId, phoneNumber, products, totalAmount);

    const quotationMessage = `✅ *Cotización generada*\n\nID: ${quotation.id.substring(0, 8).toUpperCase()}\nTotal: $${totalAmount.toFixed(2)}\nVálida hasta: ${expiresAt.toLocaleDateString('es-EC')}\n\n¿Te gustaría confirmar?`;

    await sendTextMessage(phoneNumber, quotationMessage);
  } catch (error) {
    console.error('❌ Error en handleQuotationIntent:', error);
  }
}

async function handleOrderIntent(conversationId: string, phoneNumber: string, message: string) {
  try {
    console.log('🛍️ Procesando solicitud de pedido...');

    const products = [{ name: 'Vela Aromática Premium', price: 25.00, quantity: 1 }];
    const totalAmount = 25.00;

    const order = await createOrder(conversationId, phoneNumber, 'Cliente', products, totalAmount);

    const orderMessage = `🎉 *Pedido registrado*\n\nID: ${order.id.substring(0, 8).toUpperCase()}\nTotal: $${totalAmount.toFixed(2)}\n\nNuestro equipo se pondrá en contacto para confirmar detalles de entrega. ¡Gracias por tu compra!`;

    await sendTextMessage(phoneNumber, orderMessage);
  } catch (error) {
    console.error('❌ Error en handleOrderIntent:', error);
  }
}

async function handleDeliveryStatusIntent(conversationId: string, phoneNumber: string) {
  try {
    console.log('📦 Buscando estado de entrega...');

    const orders = await getOrdersByConversation(conversationId);

    if (orders && orders.length > 0) {
      const lastOrder = orders[0];
      const statusMap: { [key: string]: string } = {
        pending: '⏳ Pendiente',
        confirmed: '✅ Confirmado',
        shipped: '📦 En camino',
        delivered: '🎉 Entregado',
        cancelled: '❌ Cancelado'
      };

      const statusMessage = `📦 *Estado de tu pedido*\n\nID: ${lastOrder.id.substring(0, 8).toUpperCase()}\nEstado: ${statusMap[lastOrder.status] || lastOrder.status}\nFecha: ${new Date(lastOrder.created_at).toLocaleDateString('es-EC')}\n\n¿Necesitas más información?`;

      await sendTextMessage(phoneNumber, statusMessage);
    } else {
      await sendTextMessage(phoneNumber, 'No encontré pedidos asociados a este número. ¿Quieres hacer uno nuevo?');
    }
  } catch (error) {
    console.error('❌ Error en handleDeliveryStatusIntent:', error);
  }
}
