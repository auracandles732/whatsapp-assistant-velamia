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
  isBotPaused,
  pauseBot,
  getMessageByWaId,
  getSentProductNames,
  getRecentPendingOrder,
  updateOrderItems,
  getRecentPendingQuotation,
  updateQuotationItems,
  updateQuotationStatus,
  productNameFromCaption
} from '../db';
import {
  sendTextMessage,
  sendImageMessage,
  getMediaUrl,
  downloadMedia,
  getSentMessageId
} from '../services/whatsapp';
import {
  planTurn,
  transcribeAudio,
  describeImage,
  extractOrderItems
} from '../services/openai';
import { uploadBufferToStorage } from '../services/storage';
import { notifyOwner } from '../services/notifications';

// Suficiente para recordar modelo, cantidad y fecha aunque en medio se hayan enviado varias fotos.
const HISTORY_LIMIT = 30;

type ChatTurn = { role: 'user' | 'assistant'; content: string };

/** Convierte un mensaje guardado en lo que la IA necesita leer (sin URLs). */
function toAiText(msg: any): string {
  const text = String(msg.content || '').replace(/^https?:\/\/\S+\n?/, '').trim();
  if (msg.sender === 'bot' && msg.type === 'image') {
    const name = productNameFromCaption(msg.content);
    return name ? `[Foto enviada del producto: ${name}]` : `[Foto enviada] ${text}`;
  }
  if (msg.sender === 'customer' && msg.type === 'image') return `[El cliente envió una foto]: ${text}`;
  if (msg.sender === 'customer' && msg.type === 'audio') return `[El cliente envió un audio]: ${text}`;
  return text;
}

/** Envía un texto y lo guarda con el id de WhatsApp, para reconocerlo si el cliente lo responde. */
async function sendAndSaveText(conversationId: string, phoneNumber: string, text: string) {
  const sent = await sendTextMessage(phoneNumber, text);
  await saveMessage(conversationId, 'bot', 'text', text, getSentMessageId(sent));
}

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
    const customerName = conversation.customer_name || phoneNumber;

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
      aiContent = `[El cliente envió una foto]: ${description}${message.image.caption ? ` (con el mensaje: "${message.image.caption}")` : ''}`;
    } else if (messageType === 'audio') {
      const media = await getMediaUrl(message.audio.id);
      const buffer = await downloadMedia(media.url);
      const publicUrl = await uploadBufferToStorage(buffer, media.mimeType);
      const transcript = await transcribeAudio(buffer, media.mimeType);
      userContent = `${publicUrl}\n🎤 "${transcript}"`;
      aiContent = `[El cliente envió un audio que dice]: "${transcript}"`;
    } else if (messageType === 'document') {
      userContent = `[Cliente envió documento]: ${message.document.filename}`;
      aiContent = userContent;
    } else if (messageType === 'button') {
      userContent = message.button?.text || '[Botón]';
      aiContent = userContent;
    } else if (messageType === 'interactive') {
      userContent = message.interactive?.button_reply?.title || message.interactive?.list_reply?.title || '[Respuesta interactiva]';
      aiContent = userContent;
    } else {
      userContent = `[Mensaje tipo: ${messageType}]`;
      aiContent = userContent;
    }

    // Si el cliente respondió citando un mensaje (por ejemplo una foto del catálogo),
    // la IA necesita saber de qué producto habla.
    let quotedLabel = '';
    const quotedId = message.context?.id;
    if (quotedId) {
      const quoted = await getMessageByWaId(quotedId);
      if (quoted) {
        const productName = quoted.type === 'image' ? productNameFromCaption(quoted.content) : null;
        const reference = productName
          ? `la foto del producto ${productName}`
          : `este mensaje: "${toAiText(quoted).slice(0, 200)}"`;
        aiContent = `[El cliente responde a ${reference}] ${aiContent}`;
        if (productName) quotedLabel = `↪️ Responde a la foto: ${productName}`;
      }
    }

    // El historial se lee ANTES de guardar el mensaje nuevo; si no, se enviaría duplicado a la IA.
    const history = await getConversationHistory(conversationId, HISTORY_LIMIT);
    const conversationHistory: ChatTurn[] = history.map((msg: any) => ({
      role: msg.sender === 'customer' ? 'user' as const : 'assistant' as const,
      content: toAiText(msg)
    }));

    // La URL de foto/audio debe seguir al inicio para que el CRM la muestre.
    let storedContent = userContent;
    if (quotedLabel) {
      storedContent = /^https?:\/\//.test(userContent)
        ? userContent.replace(/^(\S+)\n?/, `$1\n${quotedLabel}\n`)
        : `${quotedLabel}\n${userContent}`;
    }

    await saveMessage(conversationId, 'customer', messageType, storedContent, waMessageId);
    await touchConversation(conversationId);

    const botEnabled = await getConfig('bot_enabled');
    if (botEnabled === 'false') {
      console.log('🚫 Bot desactivado - mensaje guardado, esperando respuesta manual');
      return;
    }

    if (await isBotPaused(conversationId)) {
      console.log('⏸️ Bot pausado en este chat - lo atiende una persona');
      return;
    }

    const [catalog, customPrompt, sentProducts] = await Promise.all([
      getAllProducts(),
      getConfig('system_prompt'),
      getSentProductNames(conversationId)
    ]);

    const plan = await planTurn({
      history: conversationHistory,
      userMessage: aiContent,
      catalog,
      customPrompt,
      sentProducts
    });
    console.log(`🎯 intención: ${plan.intent} | fotos: ${plan.show_products.length} | pasar a persona: ${plan.handoff}`);

    if (plan.reply) {
      await sendAndSaveText(conversationId, phoneNumber, plan.reply);
    }

    // El bot se aparta: queda pausado en este chat hasta que alguien lo reactive desde el CRM.
    if (plan.handoff !== 'none') {
      await pauseBot(conversationId);
      await notifyOwner({
        conversationId,
        customerPhone: phoneNumber,
        customerName,
        event: plan.handoff,
        detail: toAiText({ sender: 'customer', type: messageType, content: userContent })
      });
      return;
    }

    if (plan.show_products.length > 0) {
      await sendProductPhotos(conversationId, phoneNumber, plan.show_products, catalog);
    }

    if (plan.intent === 'quotation' || plan.intent === 'order') {
      const transcript = [
        ...conversationHistory.slice(-10).map(t => `${t.role === 'user' ? 'Cliente' : 'VELAMIA'}: ${t.content}`),
        `Cliente: ${aiContent}`,
        `VELAMIA: ${plan.reply}`
      ].join('\n');

      await registerSale(plan.intent, {
        conversationId,
        phoneNumber,
        customerName,
        transcript,
        catalog,
        lastMessage: aiContent
      });
    } else if (plan.intent === 'delivery_status') {
      await handleDeliveryStatusIntent(conversationId, phoneNumber);
    }
  } catch (error) {
    console.error('❌ Error en handleWebhookMessage:', error);
  }
}

async function sendProductPhotos(conversationId: string, phoneNumber: string, names: string[], catalog: any[]) {
  const products = names
    .map(name => catalog.find(p => p.name === name))
    .filter(p => p && p.image_url);

  console.log(`🕯️ Enviando ${products.length} foto(s) de productos`);

  // Una a una y en orden: si una falla, las demás igual se envían.
  for (const product of products) {
    try {
      const caption = `🕯️ *${product.name}*\n💰 $${product.price} la docena`;
      const sent = await sendImageMessage(phoneNumber, product.image_url, caption);
      await saveMessage(conversationId, 'bot', 'image', `${product.image_url}\n${caption}`, getSentMessageId(sent));
    } catch (error: any) {
      console.error(`❌ No se pudo enviar la foto de ${product.name}:`, error.message);
    }
  }
}

/**
 * Registra cotizaciones y pedidos en la base. No envía mensajes extra al cliente:
 * la respuesta de la IA ya incluye el detalle y un segundo mensaje con cifras solo confunde.
 */
async function registerSale(
  kind: 'quotation' | 'order',
  ctx: { conversationId: string; phoneNumber: string; customerName: string; transcript: string; catalog: any[]; lastMessage: string }
) {
  try {
    const items = await extractOrderItems(ctx.transcript, ctx.catalog);
    if (items.length === 0) {
      console.log(`📋 ${kind} sin productos claros del catálogo; no se registra`);
      return;
    }

    const totalAmount = items.reduce((sum, i) => sum + i.price * i.quantity, 0);

    const pendingQuotation = await getRecentPendingQuotation(ctx.conversationId);

    if (kind === 'quotation') {
      // El cliente ajusta cantidad o colores varias veces: se actualiza la misma cotización.
      if (pendingQuotation) {
        await updateQuotationItems(pendingQuotation.id, items, totalAmount);
        console.log(`📋 Cotización ${pendingQuotation.id.substring(0, 8)} actualizada: $${totalAmount.toFixed(2)}`);
      } else {
        await createQuotation(ctx.conversationId, ctx.phoneNumber, items, totalAmount);
        console.log(`📋 Cotización registrada: $${totalAmount.toFixed(2)}`);
      }
      return;
    }

    // El cliente confirmó: la cotización en curso queda como aceptada.
    if (pendingQuotation) {
      await updateQuotationItems(pendingQuotation.id, items, totalAmount);
      await updateQuotationStatus(pendingQuotation.id, 'accepted');
    }

    // Un cliente suele confirmar varias veces o ajustar detalles después de confirmar:
    // se actualiza el pedido pendiente reciente en lugar de duplicarlo o de dejarlo desactualizado.
    const existing = await getRecentPendingOrder(ctx.conversationId);
    if (existing) {
      await updateOrderItems(existing.id, items, totalAmount);
      console.log(`🛍️ Pedido ${existing.id.substring(0, 8)} actualizado: $${totalAmount.toFixed(2)}`);
      return;
    }

    await createOrder(ctx.conversationId, ctx.phoneNumber, ctx.customerName, items, totalAmount);
    console.log(`🛍️ Pedido registrado: $${totalAmount.toFixed(2)}`);

    const detail = items
      .map(i => `${i.quantity} doc. ${i.name}${i.personalization ? ` (${i.personalization})` : ''}`)
      .join(', ') + ` · Total $${totalAmount.toFixed(2)}`;
    await notifyOwner({
      conversationId: ctx.conversationId,
      customerPhone: ctx.phoneNumber,
      customerName: ctx.customerName,
      event: 'new_order',
      detail
    });
  } catch (error) {
    console.error(`❌ Error registrando ${kind}:`, error);
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

    const statusMessage = `📦 *Estado de tu pedido*\n\nCódigo: ${lastOrder.id.substring(0, 8).toUpperCase()}\nEstado: ${statusMap[lastOrder.status] || lastOrder.status}`;
    await sendAndSaveText(conversationId, phoneNumber, statusMessage);
  } catch (error) {
    console.error('❌ Error en handleDeliveryStatusIntent:', error);
  }
}
