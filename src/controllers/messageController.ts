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
  productNameFromCaption,
  recordFollowUp,
  hasRecentNotification
} from '../db';
import { FOLLOW_UP_MARKER } from '../services/followups';
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
  OrderItem,
  TurnPlan,
  todayInGuayaquil,
  formatDateEc
} from '../services/openai';
import { uploadBufferToStorage } from '../services/storage';
import { shippingCost } from '../services/shippingRates';
import { notifyOwner } from '../services/notifications';

// Suficiente para recordar modelo, cantidad y fecha aunque en medio se hayan enviado varias fotos.
const HISTORY_LIMIT = 30;

// Mensajes cuyo contenido guardado empieza con la URL del archivo (el CRM la muestra aparte).
const MEDIA_TYPES = new Set(['image', 'audio', 'document']);

// Casos en que el bot se aparta hasta que la dueña lo reactive. El comprobante de pago solo avisa.
const PAUSING_HANDOFFS = new Set(['card_payment', 'complaint']);

// Inicio del mensaje con los datos bancarios: permite saber si ya se enviaron en el chat.
const BANK_DETAILS_MARKER = '🏦 Datos para transferencia';

// Palabras con que la clienta confirma una compra o elige cómo pagar. "Quiero 4 docenas para Quito"
// solo da datos: sin una de estas no se registra pedido aunque la IA lo haya marcado.
// Palabras con que la clienta pide cotización o el valor total. La dueña pidió anotar cotizaciones solo en ese caso,
// aunque el bot mencione un total por su cuenta.
const QUOTE_REQUEST_PATTERN = /(?<!\p{L})(cotiz\p{L}*|total\p{L}*|cu[aá]nt\p{L}*|precio\p{L}*|valor\p{L}*|sale|salen|saldr\p{L}*|cuest\p{L}*|cost\p{L}*|monto|presupuesto)(?!\p{L})/iu;

const CONFIRMATION_PATTERN =/(?<!\p{L})(confirm\p{L}*|reserv\p{L}*|separ\p{L}*|apart\p{L}*|hag[aá]mos\p{L}*|procedamos|proceder|de acuerdo|listo|dale|vamos|ok|okey|okay|s[ií]|claro|perfecto|lo quiero|la quiero|los quiero|las quiero|me (?:lo|la|los|las) llevo|compr\p{L}*|pag\p{L}*|transfer\p{L}*|tarjeta|dep[oó]sit\p{L}*|comprobante|anticipo)(?!\p{L})/iu;

// La clienta suele escribir en varios mensajes seguidos: se espera este silencio antes de responder
// a todos juntos. Si no deja de escribir, se responde igual pasado el tiempo máximo.
export const RESPONSE_DELAY_MS = 5000;
const MAX_RESPONSE_WAIT_MS = 20000;

// Fotos por tanda: si hay más, se pregunta antes de seguir para no saturar el chat.
export const PHOTO_BATCH_SIZE = 4;
export const MORE_PHOTOS_QUESTION = '¿Te gustaría ver más modelos? 😊✨';

type ChatTurn = { role: 'user' | 'assistant'; content: string };

type IncomingItem = { aiContent: string; storedContent: string; messageType: string; waMessageId: string };

type PendingBatch = {
  conversationId: string;
  phoneNumber: string;
  customerName: string;
  items: IncomingItem[];
  firstAt: number;
  timer?: NodeJS.Timeout;
};

/**
 * Los mensajes de un mismo cliente se procesan en fila: guardar, responder y volver a guardar
 * nunca se cruzan, y nunca se crean dos chats para el mismo número.
 */
const queues = new Map<string, Promise<void>>();

// Mensajes ya guardados que esperan la respuesta del bot, por teléfono.
const pendingBatches = new Map<string, PendingBatch>();

// Fotos que quedaron por mostrar tras preguntar "¿más modelos?", por conversación.
const pendingPhotos = new Map<string, string[]>();

function enqueue(key: string, task: () => Promise<void>): Promise<void> {
  const previous = queues.get(key) || Promise.resolve();
  const current = previous.then(task, task);
  queues.set(key, current);
  current.finally(() => {
    if (queues.get(key) === current) queues.delete(key);
  });
  return current;
}

export function handleWebhookMessage(message: any, value: any): Promise<void> {
  const key = String(message?.from || 'desconocido');
  return enqueue(key, () => ingestMessage(message, value));
}

/** Programa (o reprograma) la respuesta: se envía tras RESPONSE_DELAY_MS sin mensajes nuevos. */
function scheduleResponse(key: string, batch: PendingBatch) {
  if (batch.timer) clearTimeout(batch.timer);
  const remaining = batch.firstAt + MAX_RESPONSE_WAIT_MS - Date.now();
  const delay = Math.max(0, Math.min(RESPONSE_DELAY_MS, remaining));
  // La tanda se cierra recién cuando le toca su turno en la fila: un mensaje que se estaba guardando
  // (una foto o un audio tardan) entra en esta misma respuesta en vez de quedar desordenado.
  batch.timer = setTimeout(() => {
    enqueue(key, async () => {
      if (pendingBatches.get(key) !== batch) return;
      pendingBatches.delete(key);
      if (batch.timer) clearTimeout(batch.timer);
      await respondToBatch(batch);
    });
  }, delay);
}

/**
 * Render detiene la instancia anterior al publicar una versión: se responde ya lo que estaba
 * en espera y se aguardan las respuestas en curso, sin pasar del tiempo indicado.
 */
export async function flushPendingResponses(timeoutMs: number) {
  for (const [key, batch] of [...pendingBatches]) {
    if (batch.timer) clearTimeout(batch.timer);
    pendingBatches.delete(key);
    enqueue(key, () => respondToBatch(batch));
  }
  await Promise.race([
    Promise.allSettled([...queues.values()]),
    new Promise(resolve => setTimeout(resolve, timeoutMs))
  ]);
}

/** Olvida lo que estaba en memoria de un chat eliminado desde el CRM. */
export function forgetConversation(phoneNumber: string, conversationId: string) {
  const batch = pendingBatches.get(String(phoneNumber));
  if (batch?.conversationId === conversationId) {
    if (batch.timer) clearTimeout(batch.timer);
    pendingBatches.delete(String(phoneNumber));
  }
  pendingPhotos.delete(conversationId);
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
      case 'system':
        // Un 👍 a un mensaje o un aviso de WhatsApp (por ejemplo cambio de número) no se contestan.
        return null;

      case 'request_welcome':
        // La clienta abrió el chat por primera vez sin escribir todavía.
        return { userContent: '👋 Abrió el chat', aiContent: '[El cliente abrió el chat por primera vez; salúdalo y ofrécele ayuda]' };

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

/** Guarda el mensaje en el CRM al instante y lo deja esperando la respuesta del bot. */
async function ingestMessage(message: any, value: any) {
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

    // La URL del archivo debe seguir al inicio para que el CRM la muestre.
    let storedContent = userContent;
    if (quotedLabel) {
      storedContent = MEDIA_TYPES.has(messageType)
        ? userContent.replace(/^(\S+)\n?/, `$1\n${quotedLabel}\n`)
        : `${quotedLabel}\n${userContent}`;
    }

    const [lastMessage] = await getConversationHistory(conversationId, 1);

    await saveMessage(conversationId, 'customer', messageType, storedContent, waMessageId);
    await touchConversation(conversationId);

    // Las plantillas de seguimiento dicen "responde NO": se respeta siempre, aunque el bot esté pausado.
    const answeredFollowUp = lastMessage?.sender === 'bot' && String(lastMessage.content || '').startsWith(FOLLOW_UP_MARKER);
    // También cuenta si toca un botón "No" de la plantilla.
    if (answeredFollowUp && ['text', 'button', 'interactive'].includes(messageType) && /^\s*no\s*[.!¡]*\s*$/i.test(userContent)) {
      await recordFollowUp(conversationId, 'opt_out', 'La clienta respondió NO a los seguimientos');
      console.log(`🔕 ${phoneNumber} no quiere más seguimientos`);
      if ((await getConfig('bot_enabled')) !== 'false' && !(await isBotPaused(conversationId))) {
        await sendAndSaveText(conversationId, phoneNumber, 'Listo 🤍 No te enviaré más mensajes de seguimiento. Si más adelante necesitas velitas para tu evento, aquí estaré ✨');
      }
      return;
    }

    const key = String(phoneNumber);
    let batch = pendingBatches.get(key);
    if (!batch) {
      batch = { conversationId, phoneNumber, customerName, items: [], firstAt: Date.now() };
      pendingBatches.set(key, batch);
    }
    batch.items.push({ aiContent, storedContent, messageType, waMessageId });
    scheduleResponse(key, batch);
  } catch (error) {
    console.error('❌ Error guardando mensaje:', error);
  }
}

/** Responde en un solo turno a todos los mensajes que la clienta envió seguidos. */
async function respondToBatch(batch: PendingBatch) {
  const { conversationId, phoneNumber, customerName, items } = batch;
  try {
    if ((await getConfig('bot_enabled')) === 'false') {
      console.log('🚫 Bot desactivado - mensaje guardado, esperando respuesta manual');
      return;
    }

    // Se revisa al responder: la dueña pudo escribir desde el CRM durante la espera.
    if (await isBotPaused(conversationId)) {
      console.log('⏸️ Bot pausado en este chat - lo atiende una persona');
      return;
    }

    // Los mensajes de la tanda ya están guardados: se quitan del historial para no enviarlos dos veces a la IA.
    const batchIds = new Set(items.map(i => i.waMessageId).filter(Boolean));
    const history = (await getConversationHistory(conversationId, HISTORY_LIMIT + items.length))
      .filter((m: any) => !(m.sender === 'customer' && batchIds.has(m.wa_message_id)))
      .slice(-HISTORY_LIMIT);
    const conversationHistory: ChatTurn[] = history.map((msg: any) => ({
      role: msg.sender === 'customer' ? 'user' as const : 'assistant' as const,
      content: toAiText(msg)
    }));

    const [catalog, customPrompt, sentProducts, bankDetails] = await Promise.all([
      getAllProducts(),
      getConfig('system_prompt'),
      getSentProductNames(conversationId),
      getConfig('payment_transfer_info')
    ]);

    const aiContent = items.map(i => i.aiContent).join('\n');
    const customerDetail = items
      .map(i => toAiText({ sender: 'customer', type: i.messageType, content: i.storedContent }))
      .join('\n');
    const bankDetailsSent = history.some((m: any) => m.sender === 'bot' && String(m.content || '').startsWith(BANK_DETAILS_MARKER));

    // Solo cuentan como pendientes si la última pregunta del bot fue "¿más modelos?".
    const lastBot = [...history].reverse().find((m: any) => m.sender === 'bot');
    const offeredMore = lastBot?.type === 'text' && String(lastBot.content || '') === MORE_PHOTOS_QUESTION;
    const pendingProducts = offeredMore
      ? (pendingPhotos.get(conversationId) || []).filter(n => !sentProducts.includes(n))
      : [];

    let plan: TurnPlan;
    try {
      plan = await planTurn({ history: conversationHistory, userMessage: aiContent, catalog, customPrompt, sentProducts, bankDetailsSent, pendingProducts });
    } catch (error: any) {
      // Sin respuesta de la IA la clienta quedaría ignorada: se avisa a la dueña para que conteste.
      // Una vez por hora por chat: si la IA está caída (por ejemplo sin crédito), cada mensaje generaría otro aviso.
      console.error('❌ La IA no respondió:', error.message);
      if (!(await hasRecentNotification(conversationId, 'bot_error', 1))) {
        await notifyOwner({ conversationId, customerPhone: phoneNumber, customerName, event: 'bot_error', detail: customerDetail });
      }
      return;
    }
    console.log(`🎯 ${items.length} mensaje(s) | intención: ${plan.intent} | fotos: ${plan.show_products.length} | revisión manual: ${plan.handoff} | datos bancarios: ${plan.send_bank_details}`);

    // Respuesta vacía y nada más que enviar: la clienta quedaría sin contestar.
    if (!plan.reply && plan.handoff === 'none' && plan.show_products.length === 0) {
      console.error('❌ La IA devolvió una respuesta vacía');
      await notifyOwner({ conversationId, customerPhone: phoneNumber, customerName, event: 'bot_error', detail: customerDetail });
      return;
    }

    if (plan.reply) {
      await sendAndSaveText(conversationId, phoneNumber, plan.reply);
    }

    // Siempre se confirma la fecha, pero si la entrega cae hoy o ya pasó la dueña debe saberlo (una vez al día por chat).
    if (plan.delivery_date && plan.delivery_date <= todayInGuayaquil()
      && !(await hasRecentNotification(conversationId, 'urgent_date'))) {
      await notifyOwner({
        conversationId, customerPhone: phoneNumber, customerName, event: 'urgent_date',
        detail: `Evento ${formatDateEc(plan.event_date)} · entrega calculada ${formatDateEc(plan.delivery_date)}`
      });
    }

    // Pregunta que el bot no pudo contestar: la dueña recibe el aviso y el bot sigue atendiendo.
    if (plan.owner_question) {
      await notifyOwner({ conversationId, customerPhone: phoneNumber, customerName, event: 'owner_question', detail: plan.owner_question });
    }

    // Los datos bancarios se envían tal como la dueña los escribió: la IA nunca redacta números de cuenta.
    if (plan.send_bank_details) {
      if (bankDetails && bankDetails.trim()) {
        await sendAndSaveText(conversationId, phoneNumber, `${BANK_DETAILS_MARKER}\n\n${bankDetails.trim()}`);
      } else {
        await notifyOwner({ conversationId, customerPhone: phoneNumber, customerName, event: 'bank_details_missing', detail: customerDetail });
      }
    }

    // Un pedido falso le avisaría a la dueña sin motivo y frenaría los seguimientos de la clienta.
    let saleIntent = plan.intent;
    if (saleIntent === 'order' && !plan.send_bank_details && plan.handoff === 'none' && !CONFIRMATION_PATTERN.test(aiContent)) {
      console.log('🛍️ La IA marcó pedido sin confirmación de la clienta; no se registra');
      saleIntent = 'other';
    }
    if (saleIntent === 'quotation' && !QUOTE_REQUEST_PATTERN.test(aiContent)) {
      console.log('📋 La IA marcó cotización sin que la clienta la pidiera; no se registra');
      saleIntent = 'other';
    }

    // Se registra antes de la revisión manual: si confirma y elige tarjeta en el mismo mensaje,
    // el bot se pausa y el pedido igual debe quedar anotado.
    if (saleIntent === 'quotation' || saleIntent === 'order') {
      const transcript = [
        ...conversationHistory.slice(-20).map(t => `${t.role === 'user' ? 'Cliente' : 'VELAMIA'}: ${t.content}`),
        `Cliente: ${aiContent}`,
        `VELAMIA: ${plan.reply}`
      ].join('\n');

      await registerSale(saleIntent, { conversationId, phoneNumber, customerName, transcript, catalog, shippingPlace: plan.shipping_place, planItems: plan.order_items });
    }

    if (plan.handoff !== 'none') {
      await notifyOwner({ conversationId, customerPhone: phoneNumber, customerName, event: plan.handoff, detail: customerDetail });
      // Tarjeta y reclamos: el bot queda pausado hasta que lo reactiven desde el CRM.
      if (PAUSING_HANDOFFS.has(plan.handoff)) {
        await pauseBot(conversationId);
        return;
      }
    }

    if (plan.show_products.length > 0) {
      // Si la IA eligió una tanda de las pendientes, se toman todas: las que no entren quedan para la
      // siguiente pregunta en vez de perderse. Si pidió uno o dos modelos concretos, se envían solo esos.
      const continuesPending = pendingProducts.length > 0
        && plan.show_products.length >= Math.min(PHOTO_BATCH_SIZE, pendingProducts.length)
        && plan.show_products.every(n => pendingProducts.includes(n));
      const photos = continuesPending ? pendingProducts : plan.show_products;
      await sendProductPhotos(conversationId, phoneNumber, photos, catalog);
    }

    if (plan.intent === 'delivery_status') {
      await handleDeliveryStatusIntent(conversationId, phoneNumber);
    }
  } catch (error) {
    console.error('❌ Error respondiendo mensaje:', error);
  }
}

/** Envía hasta PHOTO_BATCH_SIZE fotos; si quedan más, las guarda y pregunta si desea verlas. */
async function sendProductPhotos(conversationId: string, phoneNumber: string, names: string[], catalog: any[]) {
  const products = names
    .map(name => catalog.find(p => p.name === name))
    .filter(p => p && p.image_url);

  const batch = products.slice(0, PHOTO_BATCH_SIZE);
  const rest = products.slice(PHOTO_BATCH_SIZE).map(p => p.name);
  console.log(`🕯️ Enviando ${batch.length} foto(s) de productos${rest.length ? ` (quedan ${rest.length})` : ''}`);

  // Una a una y en orden: si una falla, las demás igual se envían.
  for (const product of batch) {
    try {
      const caption = `🕯️ *${product.name}*\n💰 $${Number(product.price).toFixed(2)} la docena`;
      const sent = await sendImageMessage(phoneNumber, product.image_url, caption);
      await saveMessage(conversationId, 'bot', 'image', `${product.image_url}\n${caption}`, getSentMessageId(sent));
    } catch (error: any) {
      console.error(`❌ No se pudo enviar la foto de ${product.name}:`, error.message);
    }
  }

  if (rest.length > 0) {
    pendingPhotos.set(conversationId, rest);
    await sendAndSaveText(conversationId, phoneNumber, MORE_PHOTOS_QUESTION);
  } else {
    pendingPhotos.delete(conversationId);
  }
}

/**
 * Registra cotizaciones y pedidos en la base. No envía mensajes extra al cliente:
 * la respuesta de la IA ya incluye el detalle y un segundo mensaje con cifras solo confunde.
 */
async function registerSale(
  kind: 'quotation' | 'order',
  ctx: { conversationId: string; phoneNumber: string; customerName: string; transcript: string; catalog: any[]; shippingPlace: string; planItems: TurnPlan['order_items'] }
) {
  try {
    // Los mismos modelos y docenas con que se calculó el valor que recibió la clienta, para que el CRM cuadre.
    // Solo si la IA no los identificó en el turno se leen de nuevo de la conversación.
    const items: OrderItem[] = ctx.planItems.length > 0
      ? ctx.planItems.map(i => ({ name: i.name, price: i.price, quantity: i.dozens, personalization: i.personalization }))
      : await extractOrderItems(ctx.transcript, ctx.catalog);
    if (items.length === 0) {
      console.log(`📋 ${kind} sin productos claros del catálogo; no se registra`);
      return;
    }

    // La clienta ve un solo valor; en el CRM el envío queda como línea aparte para la dueña.
    const dozens = items.reduce((sum, i) => sum + i.quantity, 0);
    const shipping = ctx.shippingPlace ? shippingCost(ctx.shippingPlace, dozens) : null;
    const products: any[] = shipping
      ? [...items, { type: 'shipping', name: `Envío a ${shipping.place}`, price: shipping.cost, quantity: 1 }]
      : items;
    const totalAmount = Math.round((items.reduce((sum, i) => sum + i.price * i.quantity, 0) + (shipping?.cost || 0)) * 100) / 100;
    const pendingQuotation = await getRecentPendingQuotation(ctx.conversationId);

    if (kind === 'quotation') {
      // El cliente vuelve a pedir el total con otra cantidad: se actualiza la misma cotización.
      if (pendingQuotation) {
        await updateQuotationItems(pendingQuotation.id, products, totalAmount);
        console.log(`📋 Cotización ${pendingQuotation.id.substring(0, 8)} actualizada: $${totalAmount.toFixed(2)}`);
      } else {
        await createQuotation(ctx.conversationId, ctx.phoneNumber, products, totalAmount);
        console.log(`📋 Cotización registrada: $${totalAmount.toFixed(2)}`);
      }
      return;
    }

    // El cliente confirmó: la cotización en curso queda como aceptada.
    if (pendingQuotation) {
      await updateQuotationItems(pendingQuotation.id, products, totalAmount);
      await updateQuotationStatus(pendingQuotation.id, 'accepted');
    }

    // Un cliente suele confirmar varias veces o ajustar detalles después de confirmar:
    // se actualiza el pedido pendiente reciente en lugar de duplicarlo o de dejarlo desactualizado.
    const existing = await getRecentPendingOrder(ctx.conversationId);
    if (existing) {
      await updateOrderItems(existing.id, products, totalAmount);
      console.log(`🛍️ Pedido ${existing.id.substring(0, 8)} actualizado: $${totalAmount.toFixed(2)}`);
      return;
    }

    await createOrder(ctx.conversationId, ctx.phoneNumber, ctx.customerName, products, totalAmount);
    console.log(`🛍️ Pedido registrado: $${totalAmount.toFixed(2)}`);

    const detail = items
      .map(i => `${i.quantity} doc. ${i.name}${i.personalization ? ` (${i.personalization})` : ''}`)
      .join(', ') + `${shipping ? ` · envío a ${shipping.place}` : ' · sin ciudad de envío'} · Total $${totalAmount.toFixed(2)}`;
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
