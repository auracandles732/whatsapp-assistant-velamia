import { v4 as uuidv4 } from 'uuid';
import { runQuery, getQuery, allQuery } from '../db.js';
import { sendTextMessage } from '../services/whatsapp.js';
import { generateResponse, analyzeUserIntent } from '../services/openai.js';

export async function handleWebhookMessage(message: any, changes: any) {
  try {
    const phoneNumber = message.from;
    const messageId = message.id;
    const timestamp = message.timestamp;
    const messageType = message.type;

    console.log(`📱 Mensaje recibido de ${phoneNumber} (${messageType})`);

    // Obtener o crear conversación
    let conversation = await getQuery('conversations', { phone_number: phoneNumber });

    if (!conversation) {
      const conversationId = uuidv4();
      await runQuery('conversations', {
        id: conversationId,
        phone_number: phoneNumber,
        status: 'active',
        last_message_time: new Date().toISOString(),
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      });
      conversation = { id: conversationId, phone_number: phoneNumber };
    }

    const conversationId = conversation.id;

    // Guardar mensaje recibido
    await runQuery('messages', {
      id: messageId,
      conversation_id: conversationId,
      sender: 'customer',
      type: messageType,
      content: JSON.stringify(message),
      timestamp: new Date(timestamp * 1000).toISOString()
    });

    // Procesar diferentes tipos de mensajes
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

    // Analizar intención del usuario
    const intent = await analyzeUserIntent(userContent);

    // Obtener historial de conversación (últimos 5 mensajes)
    const history = await allQuery('messages', { conversation_id: conversationId }, 5);

    const conversationHistory = history.reverse().map((msg: any) => {
      let content = msg.content;
      try {
        const parsed = JSON.parse(content);
        content = parsed.text?.body || parsed.caption || JSON.stringify(parsed);
      } catch (e) {
        // ya es string
      }
      return {
        role: msg.sender === 'customer' ? 'user' : 'assistant',
        content
      };
    });

    // Generar respuesta con IA
    const { response: aiResponse } = await generateResponse(
      conversationHistory,
      userContent
    );

    console.log(`🤖 Respuesta IA: ${aiResponse.substring(0, 100)}...`);

    // Procesar acciones según intención
    if (intent.intent === 'quotation') {
      await handleQuotationRequest(conversationId, phoneNumber, userContent);
    } else if (intent.intent === 'order') {
      await handleOrderRequest(conversationId, phoneNumber, userContent);
    } else if (intent.intent === 'payment') {
      await handlePaymentRequest(conversationId, phoneNumber, userContent);
    } else if (intent.intent === 'delivery_status') {
      await handleDeliveryStatus(conversationId, phoneNumber);
    }

    // Enviar respuesta de IA
    await sendTextMessage(phoneNumber, aiResponse);

    // Guardar respuesta de IA
    await runQuery('messages', {
      id: uuidv4(),
      conversation_id: conversationId,
      sender: 'bot',
      type: 'text',
      content: aiResponse,
      timestamp: new Date().toISOString()
    });

    // Actualizar último mensaje
    await runQuery('conversations',
      {
        last_message_time: new Date().toISOString(),
        updated_at: new Date().toISOString()
      },
      'update',
      { id: conversationId }
    );

  } catch (error) {
    console.error('Error en handleWebhookMessage:', error);
  }
}

async function handleQuotationRequest(conversationId: string, phoneNumber: string, message: string) {
  try {
    console.log('📋 Procesando solicitud de cotización...');

    const quotationId = uuidv4();
    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + 3);

    await runQuery('quotations', {
      id: quotationId,
      conversation_id: conversationId,
      customer_phone: phoneNumber,
      products: JSON.stringify([{ name: 'Vela Aromática Premium', price: 25.00, quantity: 1 }]),
      total_amount: 25.00,
      status: 'pending',
      created_at: new Date().toISOString(),
      expires_at: expiresAt.toISOString()
    });

    const quotationMessage = `✅ Cotización generada: ID ${quotationId.substring(0, 8)}\nVálida hasta: ${expiresAt.toLocaleDateString('es-EC')}\nTotal: $25.00`;
    await sendTextMessage(phoneNumber, quotationMessage);
  } catch (error) {
    console.error('Error en handleQuotationRequest:', error);
  }
}

async function handleOrderRequest(conversationId: string, phoneNumber: string, message: string) {
  try {
    console.log('🛍️ Procesando solicitud de pedido...');

    const orderId = uuidv4();

    await runQuery('orders', {
      id: orderId,
      conversation_id: conversationId,
      customer_phone: phoneNumber,
      products: JSON.stringify([{ name: 'Vela Aromática Premium', price: 25.00, quantity: 1 }]),
      total_amount: 25.00,
      status: 'pending',
      created_at: new Date().toISOString()
    });

    const orderMessage = `🎉 Pedido registrado: ID ${orderId.substring(0, 8)}\nNuestro equipo se pondrá en contacto para confirmar detalles de entrega.`;
    await sendTextMessage(phoneNumber, orderMessage);
  } catch (error) {
    console.error('Error en handleOrderRequest:', error);
  }
}

async function handlePaymentRequest(conversationId: string, phoneNumber: string, message: string) {
  try {
    console.log('💳 Procesando solicitud de pago...');

    const paymentMessage = `💳 Opciones de pago:\n1. Transferencia bancaria\n2. Tarjeta de crédito/débito\n3. PayPal\n4. Contra-entrega (si disponible)\n\n¿Cuál prefieres?`;
    await sendTextMessage(phoneNumber, paymentMessage);
  } catch (error) {
    console.error('Error en handlePaymentRequest:', error);
  }
}

async function handleDeliveryStatus(conversationId: string, phoneNumber: string) {
  try {
    console.log('📦 Buscando estado de entrega...');

    const orders = await allQuery('orders', { conversation_id: conversationId }, 1);

    if (orders && orders.length > 0) {
      const order = orders[0];
      const statusMessage = `📦 Estado de tu pedido ${order.id.substring(0, 8)}:\nEstado: ${order.status}\nCreado: ${new Date(order.created_at).toLocaleDateString('es-EC')}\n\n¿Necesitas más información?`;
      await sendTextMessage(phoneNumber, statusMessage);
    } else {
      await sendTextMessage(phoneNumber, 'No encontré pedidos asociados a este número. ¿Quieres hacer uno nuevo?');
    }
  } catch (error) {
    console.error('Error en handleDeliveryStatus:', error);
  }
}
