import { v4 as uuidv4 } from 'uuid';
import { runQuery, getQuery, allQuery } from '../db.js';
import { sendTextMessage, sendImageMessage } from '../services/whatsapp.js';
import { generateResponse, analyzeUserIntent, generateQuotation, generateFollowUp } from '../services/openai.js';

export async function handleWebhookMessage(message: any, changes: any) {
  try {
    const phoneNumber = message.from;
    const messageId = message.id;
    const timestamp = message.timestamp;
    const messageType = message.type;

    console.log(`📱 Mensaje recibido de ${phoneNumber} (${messageType})`);

    // Obtener o crear conversación
    let conversation = await getQuery(
      'SELECT * FROM conversations WHERE phone_number = ?',
      [phoneNumber]
    );

    if (!conversation) {
      const conversationId = uuidv4();
      await runQuery(
        `INSERT INTO conversations (id, phone_number, status, last_message_time, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [conversationId, phoneNumber, 'active', new Date().toISOString(), new Date().toISOString(), new Date().toISOString()]
      );
      conversation = { id: conversationId, phone_number: phoneNumber };
    }

    const conversationId = conversation.id;

    // Guardar mensaje recibido
    await runQuery(
      `INSERT INTO messages (id, conversation_id, sender, type, content, timestamp)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [messageId, conversationId, 'customer', messageType, JSON.stringify(message), new Date(timestamp * 1000).toISOString()]
    );

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
    const history = await allQuery(
      `SELECT sender, content FROM messages
       WHERE conversation_id = ?
       ORDER BY timestamp DESC LIMIT 5`,
      [conversationId]
    );

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
    await runQuery(
      `INSERT INTO messages (id, conversation_id, sender, type, content, timestamp)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [uuidv4(), conversationId, 'bot', 'text', aiResponse, new Date().toISOString()]
    );

    // Actualizar último mensaje
    await runQuery(
      `UPDATE conversations SET last_message_time = ?, updated_at = ? WHERE id = ?`,
      [new Date().toISOString(), new Date().toISOString(), conversationId]
    );

  } catch (error) {
    console.error('Error en handleWebhookMessage:', error);
  }
}

async function handleQuotationRequest(conversationId: string, phoneNumber: string, message: string) {
  try {
    console.log('📋 Procesando solicitud de cotización...');

    // Aquí iría lógica para extraer productos del mensaje
    // Por ahora, crear una cotización de ejemplo
    const quotationId = uuidv4();
    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + 3);

    await runQuery(
      `INSERT INTO quotations (id, conversation_id, customer_phone, products, total_amount, status, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        quotationId,
        conversationId,
        phoneNumber,
        JSON.stringify([{ name: 'Vela Aromática Premium', price: 25.00, quantity: 1 }]),
        25.00,
        'pending',
        new Date().toISOString(),
        expiresAt.toISOString()
      ]
    );

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

    await runQuery(
      `INSERT INTO orders (id, conversation_id, customer_phone, products, total_amount, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        orderId,
        conversationId,
        phoneNumber,
        JSON.stringify([{ name: 'Vela Aromática Premium', price: 25.00, quantity: 1 }]),
        25.00,
        'pending',
        new Date().toISOString()
      ]
    );

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

    const order = await getQuery(
      `SELECT * FROM orders WHERE conversation_id = ? ORDER BY created_at DESC LIMIT 1`,
      [conversationId]
    );

    if (order) {
      const statusMessage = `📦 Estado de tu pedido ${order.id.substring(0, 8)}:\nEstado: ${order.status}\nCreado: ${new Date(order.created_at).toLocaleDateString('es-EC')}\n\n¿Necesitas más información?`;
      await sendTextMessage(phoneNumber, statusMessage);
    } else {
      await sendTextMessage(phoneNumber, 'No encontré pedidos asociados a este número. ¿Quieres hacer uno nuevo?');
    }
  } catch (error) {
    console.error('Error en handleDeliveryStatus:', error);
  }
}
