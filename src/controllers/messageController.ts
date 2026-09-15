import {
  getConversation,
  createConversation,
  getConversationHistory,
  saveMessage,
  touchConversation,
  isMessageAlreadyProcessed,
  createQuotation,
  createOrder,
  getOrdersByConversation,
  getConfig,
  getAllProducts,
  searchProducts
} from '../db';
import { sendTextMessage, sendImageMessage, getMediaUrl, downloadMedia } from '../services/whatsapp';
import {
  generateResponse,
  analyzeUserIntent,
  transcribeAudio,
  describeImage,
  extractOrderItems
} from '../services/openai';
import { uploadBufferToStorage } from '../services/storage';

export async function handleWebhookMessage(message: any, changes: any) {
  try {
    const phoneNumber = message.from;
    const waMessageId = message.id;
    const messageType = message.type;

    // Meta reintenta el webhook si no responde a tiempo: sin esto el bot contestaría dos veces.
    if (waMessageId && await isMessageAlreadyProcessed(waMessageId)) {
      console.log(`↩️  Mensaje ${waMessageId} ya procesado, se ignora`);
      return;
    }

    console.log(`📱 Mensaje recibido de ${phoneNumber} (${messageType})`);

    let conversation = await getConversation(phoneNumber);
    if (!conversation) {
      conversation = await createConversation(phoneNumber, changes?.contacts?.[0]?.profile?.name);
    }
    const conversationId = conversation.id;

    // userContent = lo que se guarda y se ve en el CRM. aiContent = lo que "entiende" la IA.
    let userContent = '';
    let aiContent = '';

    if (messageType === 'text') {
      userContent = message.text.body;
      aiContent = userContent;
    } else if (messageType === 'image') {
      const media = await getMediaUrl(message.image.id);
      const buffer = await downloadMedia(media.url);
      const publicUrl = await uploadBufferToStorage(buffer, media.mimeType);
      const description = await describeImage(publicUrl);
      userContent = `${publicUrl}\n${message.image.caption || description}`;
      aiContent = `[Cliente envió una foto]: ${description}${message.image.caption ? ` (con el mensaje: "${message.image.caption}")` : ''}`;
    } else if (messageType === 'audio') {
      const media = await getMediaUrl(message.audio.id);
      const buffer = await downloadMedia(media.url);
      const publicUrl = await uploadBufferToStorage(buffer, media.mimeType);
      const transcript = await transcribeAudio(buffer, media.mimeType);
      userContent = `${publicUrl}\n🎤 "${transcript}"`;
      aiContent = `[Cliente envió un audio que dice]: "${transcript}"`;
    } else if (messageType === 'document') {
      userContent = `[Cliente envió documento]: ${message.document.filename}`;
      aiContent = userContent;
    } else {
      userContent = `[Mensaje tipo: ${messageType}]`;
      aiContent = userContent;
    }

    // El historial se lee ANTES de guardar el mensaje nuevo; si no, se enviaría duplicado a la IA.
    const history = await getConversationHistory(conversationId, 6);
    const conversationHistory: { role: 'user' | 'assistant'; content: string }[] = history.map((msg: any) => ({
      role: msg.sender === 'customer' ? 'user' as const : 'assistant' as const,
      content: msg.content.replace(/^https?:\/\/\S+\n?/, '')
    }));

    await saveMessage(conversationId, 'customer', messageType, userContent, waMessageId);
    await touchConversation(conversationId);

    const botEnabled = await getConfig('bot_enabled');
    if (botEnabled === 'false') {
      console.log('🚫 Bot desactivado - mensaje guardado, esperando respuesta manual');
      return;
    }

    const intent = await analyzeUserIntent(aiContent);
    console.log(`🎯 Intención detectada: ${intent.intent}`);

    const catalog = await getAllProducts();
    const customPrompt = await getConfig('system_prompt');
    const { response: aiResponse } = await generateResponse(conversationHistory, aiContent, catalog, customPrompt);

    await sendTextMessage(phoneNumber, aiResponse);
    await saveMessage(conversationId, 'bot', 'text', aiResponse);

    if (intent.intent === 'product_inquiry') {
      await handleProductInquiry(conversationId, phoneNumber, intent.entities || []);
    } else if (intent.intent === 'quotation') {
      await handleQuotationIntent(conversationId, phoneNumber, aiContent, catalog);
    } else if (intent.intent === 'order') {
      await handleOrderIntent(conversationId, phoneNumber, aiContent, catalog, conversation.customer_name);
    } else if (intent.intent === 'delivery_status') {
      await handleDeliveryStatusIntent(conversationId, phoneNumber);
    }

  } catch (error) {
    console.error('❌ Error en handleWebhookMessage:', error);
  }
}

async function handleProductInquiry(conversationId: string, phoneNumber: string, entities: string[]) {
  try {
    // Solo se envían fotos de lo que el cliente pidió: si pregunta por algo que no existe
    // (p. ej. "boda"), recibir fotos de otra categoría confunde más de lo que ayuda.
    const terms = entities.filter(e => typeof e === 'string' && e.trim().length > 2);
    const found = new Map<string, any>();
    for (const term of terms) {
      for (const product of await searchProducts(term)) found.set(product.id, product);
    }

    const toSend = [...found.values()].filter(p => p.image_url).slice(0, 5);
    if (toSend.length === 0) return;

    console.log(`🕯️ Enviando ${toSend.length} foto(s) de productos`);

    for (const product of toSend) {
      const caption = `🕯️ *${product.name}*\n💰 $${product.price} la docena`;
      await sendImageMessage(phoneNumber, product.image_url, caption);
      await saveMessage(conversationId, 'bot', 'image', `${product.image_url}\n${caption}`);
    }
  } catch (error) {
    console.error('❌ Error enviando fotos de productos:', error);
  }
}

async function handleQuotationIntent(
  conversationId: string,
  phoneNumber: string,
  message: string,
  catalog: any[]
) {
  try {
    const items = await extractOrderItems(message, catalog);
    if (items.length === 0) {
      console.log('📋 Cotización no generada: el cliente aún no especificó productos del catálogo');
      return;
    }

    const totalAmount = items.reduce((sum, i) => sum + i.price * i.quantity, 0);
    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + 3);

    const quotation = await createQuotation(conversationId, phoneNumber, items, totalAmount);

    const detalle = items
      .map(i => `• ${i.name} — ${i.quantity} doc. × $${i.price} = $${(i.price * i.quantity).toFixed(2)}`)
      .join('\n');

    const quotationMessage = `✅ *Cotización*\n\n${detalle}\n\n*Total: $${totalAmount.toFixed(2)}*\nVálida hasta: ${expiresAt.toLocaleDateString('es-EC')}\nCódigo: ${quotation.id.substring(0, 8).toUpperCase()}\n\n¿Deseas confirmar tu pedido?`;

    await sendTextMessage(phoneNumber, quotationMessage);
    await saveMessage(conversationId, 'bot', 'text', quotationMessage);
  } catch (error) {
    console.error('❌ Error en handleQuotationIntent:', error);
  }
}

async function handleOrderIntent(
  conversationId: string,
  phoneNumber: string,
  message: string,
  catalog: any[],
  customerName?: string
) {
  try {
    const items = await extractOrderItems(message, catalog);
    if (items.length === 0) {
      console.log('🛍️ Pedido no registrado: el cliente aún no especificó productos del catálogo');
      return;
    }

    const totalAmount = items.reduce((sum, i) => sum + i.price * i.quantity, 0);
    const order = await createOrder(conversationId, phoneNumber, customerName || 'Cliente', items, totalAmount);

    const detalle = items
      .map(i => `• ${i.name} — ${i.quantity} doc. × $${i.price}`)
      .join('\n');

    const orderMessage = `🎉 *Pedido registrado*\n\n${detalle}\n\n*Total: $${totalAmount.toFixed(2)}*\nCódigo: ${order.id.substring(0, 8).toUpperCase()}\n\nTe contactaremos para confirmar la entrega. ¡Gracias por tu compra!`;

    await sendTextMessage(phoneNumber, orderMessage);
    await saveMessage(conversationId, 'bot', 'text', orderMessage);
  } catch (error) {
    console.error('❌ Error en handleOrderIntent:', error);
  }
}

async function handleDeliveryStatusIntent(conversationId: string, phoneNumber: string) {
  try {
    const orders = await getOrdersByConversation(conversationId);
    if (!orders || orders.length === 0) return;

    const lastOrder = orders[0];
    const statusMap: { [key: string]: string } = {
      pending: '⏳ Pendiente',
      confirmed: '✅ Confirmado',
      shipped: '📦 En camino',
      delivered: '🎉 Entregado',
      cancelled: '❌ Cancelado'
    };

    const statusMessage = `📦 *Estado de tu pedido*\n\nCódigo: ${lastOrder.id.substring(0, 8).toUpperCase()}\nEstado: ${statusMap[lastOrder.status] || lastOrder.status}\nFecha: ${new Date(lastOrder.created_at).toLocaleDateString('es-EC')}`;

    await sendTextMessage(phoneNumber, statusMessage);
    await saveMessage(conversationId, 'bot', 'text', statusMessage);
  } catch (error) {
    console.error('❌ Error en handleDeliveryStatusIntent:', error);
  }
}
