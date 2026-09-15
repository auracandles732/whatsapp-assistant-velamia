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
  extractOrderItems,
  TurnPlan
} from '../services/openai';
import { uploadBufferToStorage } from '../services/storage';
import { notifyOwner } from '../services/notifications';

// Suficiente para recordar modelo, cantidad y fecha aunque en medio se hayan enviado varias fotos.
const HISTORY_LIMIT = 30;

// Mensajes cuyo contenido guardado empieza con la URL del archivo (el CRM la muestra aparte).
const MEDIA_TYPES = new Set(['image', 'audio', 'document']);

type ChatTurn = { role: 'user' | 'assistant'; content: string };

/**
 * Los mensajes de un mismo cliente se procesan en fila: si escribe tres seguidos, cada
 * respuesta ve la anterior y nunca se crean dos chats para el mismo número.
 */
const queues = new Map<string, Promise<void>>();

export function handleWebhookMessage(message: any, value: any): Promise<void> {
  const key = String(message?.from || 'desconocido');
  const previous = queues.get(key) || Promise.resolve();
  const current = previous.then(() => processMessage(message, value));
  queues.set(key, current);
  current.finally(() => {
    if (queues.get(key) === current) queues.delete(key);
  });
  return current;
}

/** Convierte un mensaje guardado en lo que la IA necesita leer (sin URLs de archivos). */
function toAiText(msg: any): string {
  const raw = String(msg.content || '');
  const text = MEDIA_TYPES.has(msg.type) ? raw.replace(/^https?:\/\/\S+\n?/, '').trim() : raw.trim();
  if (msg.sender === 'bot' && msg.type === 'image') {
    const name = productNameFromCaption(raw);
    return name ? `[Foto enviada del producto: ${name}]` : `[Foto enviada] ${text}`;
  }
  if (msg.sender === 'customer' && msg.type === 'image') return `[El cliente envió una foto]: ${text}`;
  if (msg.sender === 'customer' && msg.type === 'audio') return `[El cliente envió un audio]: ${text}`;
  if (msg.sender === 'customer' && msg.type === 'document') return `[El cliente envió un documento]: ${text}`;
  return text;
}

/** Envía un texto y lo guarda con el id de WhatsApp, para reconocerlo si el cliente lo responde. */
async function sendAndSaveText(conversationId: string, phoneNumber: string, text: string) {
  const sent = await sendTextMessage(phoneNumber, text);
  await saveMessage(conversationId, 'bot', 'text', text, getSentMessageId(sent));
}

/** Descarga un archivo de WhatsApp y lo sube al almacenamiento; devuelve su URL pública. */
async function storeIncomingMedia(mediaId: string) {
  const media = await getMediaUrl(mediaId);
  const buffer = await downloadMedia(media.url);
  const publicUrl = await uploadBufferToStorage(buffer, media.mimeType);
  return { publicUrl, buffer, mimeType: media.mimeType };
}

/**
 * Traduce cada tipo de mensaje de WhatsApp a lo que se guarda en el CRM (userContent)
 * y a lo que entiende la IA (aiContent). Devuelve null si el mensaje no requiere atención.
 */
async function readIncomingContent(message: any): Promise<{ userContent: string; aiContent: string } | null> {
  const type = message.type;

  try {
    switch (type) {
      case 'text':
        return { userContent: message.text.body, aiContent: message.text.body };

      case 'image': {
        const { publicUrl } = await storeIncomingMedia(message.image.id);
        const description = await describeImage(publicUrl);
        const caption = message.image.caption;
        return {
          userContent: `${publicUrl}\n${caption || description}`,
          aiContent: `[El cliente envió una foto]: ${description}${caption ? ` (con el mensaje: "${caption}")` : ''}`
        };
      }

      case 'audio': {
        const { publicUrl, buffer, mimeType } = await storeIncomingMedia(message.audio.id);
        const transcript = await transcribeAudio(buffer, mimeType);
        return {
          userContent: `${publicUrl}\n🎤 "${transcript}"`,
          aiContent: `[El cliente envió un audio que dice]: "${transcript}"`
        };
      }

      case 'document': {
        // Suele ser un comprobante de pago en PDF: se guarda para verlo desde el CRM.
        const { publicUrl } = await storeIncomingMedia(message.document.id);
        const name = message.document.filename || 'documento';
        const caption = message.document.caption ? ` (con el mensaje: "${message.document.caption}")` : '';
        return {
          userContent: `${publicUrl}\n📄 ${name}${message.document.caption ? `\n${message.document.caption}` : ''}`,
          aiContent: `[El cliente envió un documento llamado "${name}"]${caption}`
        };
      }

      case 'video': {
        const caption = message.video?.caption;
        return {
          userContent: `🎬 [Video]${caption ? `\n${caption}` : ''}`,
          aiContent: `[El cliente envió un video]${caption ? ` (con el mensaje: "${caption}")` : ''}`
        };
      }

      case 'sticker':
        return { userContent: '🙂 [Sticker]', aiContent: '[El cliente envió un sticker]' };

      case 'location': {
        const loc = message.location || {};
        const place = [loc.name, loc.address].filter(Boolean).join(', ');
        const coords = `${loc.latitude}, ${loc.longitude}`;
        return {
          userContent: `📍 Ubicación: ${place ? `${place} ` : ''}(${coords})\nhttps://maps.google.com/?q=${coords.replace(' ', '')}`,
          aiContent: `[El cliente envió su ubicación${place ? `: ${place}` : ''}]`
        };
      }

      case 'contacts':
        return { userContent: '👤 [Contacto compartido]', aiContent: '[El cliente compartió un contacto]' };

      case 'button':
        return { userContent: message.button?.text || '[Botón]', aiContent: message.button?.text || '[Botón]' };

      case 'interactive': {
        const title = message.interactive?.button_reply?.title || message.interactive?.list_reply?.title || '[Respuesta interactiva]';
        return { userContent: title, aiContent: title };
      }

      case 'reaction':
        // Un 👍 a un mensaje no es algo que el bot deba contestar.
        return null;

      default:
        return { userContent: `[Mensaje tipo: ${type}]`, aiContent: `[El cliente envió un mensaje de tipo ${type} que no se puede leer]` };
    }
  } catch (error: any) {
    // Si falla la descarga o el análisis del archivo, igual queda registro y el bot pide reenviarlo.
    console.error(`❌ No se pudo procesar el ${type}:`, error.message);
    return {
      userContent: `[${type} que no se pudo descargar]`,
      aiContent: `[El cliente envió un ${type} que no se pudo abrir; pídele amablemente que lo reenvíe]`
    };
  }
}

async function processMessage(message: any, value: any) {
  try {
    const phoneNumber = message.from;
    const waMessageId = message.id;
    const messageType = message.type;

    // Meta reintenta el webhook si no responde a tiempo: sin esto el bot contestaría dos veces.
    if (waMessageId && await isMessageAlreadyProcessed(waMessageId)) {
      console.log(`↩️  Mensaje ${waMessageId} ya procesado, se ignora`);
      return;
    }

    const content = await readIncomingContent(message);
    if (!content) {
      console.log(`↪️  Mensaje ${messageType} de ${phoneNumber} ignorado`);
      return;
    }
    let { userContent, aiContent } = content;

    console.log(`📱 Mensaje recibido de ${phoneNumber} (${messageType})`);

    let conversation = await getConversation(phoneNumber);
    if (!conversation) {
      conversation = await createConversation(phoneNumber, value?.contacts?.[0]?.profile?.name);
    }
    const conversationId = conversation.id;
    const customerName = conversation.customer_name || phoneNumber;

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

    // La URL del archivo debe seguir al inicio para que el CRM la muestre.
    let storedContent = userContent;
    if (quotedLabel) {
      storedContent = MEDIA_TYPES.has(messageType)
        ? userContent.replace(/^(\S+)\n?/, `$1\n${quotedLabel}\n`)
        : `${quotedLabel}\n${userContent}`;
    }

    await saveMessage(conversationId, 'customer', messageType, storedContent, waMessageId);
    await touchConversation(conversationId);

    if ((await getConfig('bot_enabled')) === 'false') {
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

    const customerDetail = toAiText({ sender: 'customer', type: messageType, content: storedContent });

    let plan: TurnPlan;
    try {
      plan = await planTurn({ history: conversationHistory, userMessage: aiContent, catalog, customPrompt, sentProducts });
    } catch (error: any) {
      // Sin respuesta de la IA la clienta quedaría ignorada: se avisa a la dueña para que conteste.
      console.error('❌ La IA no respondió:', error.message);
      await notifyOwner({ conversationId, customerPhone: phoneNumber, customerName, event: 'bot_error', detail: customerDetail });
      return;
    }
    console.log(`🎯 intención: ${plan.intent} | fotos: ${plan.show_products.length} | revisión manual: ${plan.handoff}`);

    // Respuesta vacía y nada más que enviar: la clienta quedaría sin contestar.
    if (!plan.reply && plan.handoff === 'none' && plan.show_products.length === 0) {
      console.error('❌ La IA devolvió una respuesta vacía');
      await notifyOwner({ conversationId, customerPhone: phoneNumber, customerName, event: 'bot_error', detail: customerDetail });
      return;
    }

    if (plan.reply) {
      await sendAndSaveText(conversationId, phoneNumber, plan.reply);
    }

    // Caso de revisión manual: el bot queda pausado en este chat hasta que lo reactiven desde el CRM.
    if (plan.handoff !== 'none') {
      await pauseBot(conversationId);
      await notifyOwner({ conversationId, customerPhone: phoneNumber, customerName, event: plan.handoff, detail: customerDetail });
      return;
    }

    if (plan.show_products.length > 0) {
      await sendProductPhotos(conversationId, phoneNumber, plan.show_products, catalog);
    }

    if (plan.intent === 'quotation' || plan.intent === 'order') {
      const transcript = [
        ...conversationHistory.slice(-20).map(t => `${t.role === 'user' ? 'Cliente' : 'VELAMIA'}: ${t.content}`),
        `Cliente: ${aiContent}`,
        `VELAMIA: ${plan.reply}`
      ].join('\n');

      await registerSale(plan.intent, { conversationId, phoneNumber, customerName, transcript, catalog });
    } else if (plan.intent === 'delivery_status') {
      await handleDeliveryStatusIntent(conversationId, phoneNumber);
    }
  } catch (error) {
    console.error('❌ Error procesando mensaje:', error);
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
  ctx: { conversationId: string; phoneNumber: string; customerName: string; transcript: string; catalog: any[] }
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
      // El cliente vuelve a pedir el total con otra cantidad: se actualiza la misma cotización.
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
    if (orders.length === 0) return;

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
