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
  TurnPlan
} from '../services/openai';
import { profile, todayLocal, formatDate, quantityText } from '../config/businessProfile';
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
// Pedidos claros del valor total ("cuánto sería el total", "me cotizas"): con ellos se anota la cotización
// aunque la IA no la marque. Preguntar el precio de un modelo no entra aquí.
const TOTAL_REQUEST_PATTERN = /(?<!\p{L})(cotiz\p{L}*|total|presupuesto|cu[aá]nto\s+(?:ser[ií]a|me\s+sale|sale|saldr[ií]a|queda|quedar[ií]a|es\s+todo|pago|pagar[ií]a|debo))(?!\p{L})/iu;

const QUOTE_REQUEST_PATTERN =/(?<!\p{L})(cotiz\p{L}*|total\p{L}*|cu[aá]nt\p{L}*|precio\p{L}*|valor\p{L}*|sale|salen|saldr\p{L}*|cuest\p{L}*|cost\p{L}*|monto|presupuesto)(?!\p{L})/iu;

// Las palabras débiles ("ok", "sí", "perfecto") no confirman si en el mismo mensaje pregunta el precio.
const STRONG_CONFIRMATION = /(?<!\p{L})(confirm\p{L}*|reserv\p{L}*|separ\p{L}*|apart\p{L}*|hag[aá]mos\p{L}*|procedamos|proceder|lo quiero|la quiero|los quiero|las quiero|me (?:lo|la|los|las) llevo|compr[aeoó]\p{L}*|transfer\p{L}*|tarjeta|dep[oó]sit\p{L}*|comprobante)(?!\p{L})/iu;
const WEAK_CONFIRMATION = /(?<!\p{L})(de acuerdo|listo|dale|vamos|ok|okey|okay|s[ií]|claro|perfecto|pag\p{L}*|anticipo)(?!\p{L})/iu;

// La clienta suele escribir en varios mensajes seguidos: se espera este silencio antes de responder
// a todos juntos. Si no deja de escribir, se responde igual pasado el tiempo máximo.
export const RESPONSE_DELAY_MS = 5000;

// Pausas entre mensajes seguidos del bot para que no lleguen todos de golpe.
export const MESSAGE_GAP_MS = 3000; // entre el texto, las fotos y la pregunta final
export const PHOTO_GAP_MS = 2000;   // entre fotos de la misma tanda
const lastSentAt = new Map<string, number>();
// Al apagar el servidor se responde sin pausas: Render corta el proceso a los pocos segundos.
let shuttingDown = false;

async function waitGap(phoneNumber: string, gapMs: number) {
  const last = lastSentAt.get(phoneNumber);
  const wait = last ? last + gapMs - Date.now() : 0;
  if (!shuttingDown && wait > 0) await new Promise(resolve => setTimeout(resolve, wait));
  lastSentAt.set(phoneNumber, Date.now());
  if (lastSentAt.size > 500) {
    for (const [phone, at] of lastSentAt) if (Date.now() - at > 60_000) lastSentAt.delete(phone);
  }
}
const MAX_RESPONSE_WAIT_MS = 20000;

// Fotos por tanda: si hay más, se pregunta antes de seguir para no saturar el chat.
export const PHOTO_BATCH_SIZE = 4;
// El emoji de cada variante es fijo para un mismo perfil: así se reconoce la pregunta al leer el historial.
const withEmojis = (texts: string[]) => {
  const emojis = profile().style.decorativeEmojis;
  return texts.map((t, i) => `${t} ${emojis[(i + 1) % emojis.length]}`);
};

// Se pregunta DESPUÉS de las fotos: antes de verlas la clienta no puede elegir.
export const likedPhotoQuestions = () => {
  const models = profile().sales.productLabelPlural.toLowerCase();
  return withEmojis(['¿Cuál te gustó más?', `¿Cuál de estos ${models} te gusta más?`, '¿Cuál prefieres?']);
};
export const likedSinglePhotoQuestions = () => {
  const model = profile().sales.productLabel.toLowerCase();
  return withEmojis([`¿Te gusta este ${model}?`, '¿Qué te parece?', '¿Te gustó?']);
};

const pick = (options: string[]) => options[Math.floor(Math.random() * options.length)];

/** Fecha de entrega guardada en un pedido o cotización anterior. */
function deliveryDateFromProducts(value: any): string {
  try {
    const list = typeof value === 'string' ? JSON.parse(value || '[]') : (value || []);
    const found = (Array.isArray(list) ? list : []).find((i: any) => i?.type === 'delivery' && i?.date);
    return found ? String(found.date) : '';
  } catch {
    return '';
  }
}

/** La fecha de entrega no se repite en cada mensaje: se rescata del último resumen enviado. */
function lastDeliveryDateFromHistory(history: any[]): string {
  for (const m of [...history].reverse()) {
    if (m.sender !== 'bot') continue;
    const match = String(m.content || '').match(/Entrega:?\*?\s*(\d{2})\/(\d{2})\/(\d{4})/i);
    if (match) return `${match[3]}-${match[2]}-${match[1]}`;
  }
  return '';
}

const daysUntil = (isoDate: string) =>
  Math.round((Date.parse(`${isoDate}T00:00:00Z`) - Date.parse(`${todayLocal()}T00:00:00Z`)) / 86_400_000);

// Varias formas de preguntar para no repetir siempre la misma frase y los mismos emojis.
export const morePhotosQuestions = () => {
  const models = profile().sales.productLabelPlural.toLowerCase();
  return withEmojis([`¿Te gustaría ver más ${models}?`, `¿Quieres que te muestre más ${models}?`, '¿Te enseño más opciones?', '¿Deseas ver más opciones?']);
};

// Emojis de las últimas respuestas del bot: la IA los evita para no repetir siempre los mismos.
// Los emojis al inicio de cada línea de una lista (🕯️ Modelo, 💰 Total…) son etiquetas y no cuentan.
function recentBotEmojis(history: any[]): string[] {
  const texts = history.filter(m => m.sender === 'bot' && m.type === 'text').slice(-4);
  const lines = texts.flatMap(m => String(m.content || '').split('\n').map(l => l.replace(/^\s*\p{Extended_Pictographic}️?/u, '')));
  return [...new Set(lines.flatMap(l => l.match(/\p{Extended_Pictographic}/gu) || []))];
}

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
  shuttingDown = true;
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
  await waitGap(phoneNumber, MESSAGE_GAP_MS);
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
        await sendAndSaveText(conversationId, phoneNumber, profile().followUps.optOutMessage);
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
    const offeredMore = lastBot?.type === 'text' && morePhotosQuestions().includes(String(lastBot.content || ''));
    const pendingProducts = offeredMore
      ? (pendingPhotos.get(conversationId) || []).filter(n => !sentProducts.includes(n))
      : [];

    let plan: TurnPlan;
    try {
      plan = await planTurn({
        history: conversationHistory, userMessage: aiContent, catalog, customPrompt, sentProducts, bankDetailsSent, pendingProducts,
        recentEmojis: recentBotEmojis(history)
      });
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

    // Siempre se confirma la fecha, pero una entrega muy justa la revisa la dueña (una vez al día por chat).
    if (plan.delivery_date && daysUntil(plan.delivery_date) <= profile().dates.urgentDays
      && !(await hasRecentNotification(conversationId, 'urgent_date'))) {
      const days = daysUntil(plan.delivery_date);
      const cuando = days < 0 ? 'ya pasó' : days === 0 ? 'es hoy' : days === 1 ? 'es mañana' : `faltan ${days} días`;
      await notifyOwner({
        conversationId, customerPhone: phoneNumber, customerName, event: 'urgent_date',
        detail: `${profile().dates.eventLabel.replace(/^./, c => c.toUpperCase())} ${formatDate(plan.event_date)} · entrega ${formatDate(plan.delivery_date)} (${cuando})`
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
    const asksPrice = QUOTE_REQUEST_PATTERN.test(aiContent);
    const confirms = STRONG_CONFIRMATION.test(aiContent) || (WEAK_CONFIRMATION.test(aiContent) && !asksPrice);
    if (saleIntent === 'order' && !plan.send_bank_details && plan.handoff === 'none' && !confirms) {
      // "Ok, ¿cuánto sería el total?" pide la cotización, no confirma la compra.
      saleIntent = asksPrice ? 'quotation' : 'other';
      console.log(`🛍️ La IA marcó pedido sin confirmación de la clienta; se registra como: ${saleIntent === 'quotation' ? 'cotización' : 'nada'}`);
    }
    // Si el bot le dio el valor total, es una cotización aunque la clienta no usara esa palabra:
    // la dueña quiere revisarlas todas.
    const gaveTotal = plan.order_total > 0 && plan.reply.includes(plan.order_total.toFixed(2));
    if (saleIntent !== 'order' && (gaveTotal || (plan.order_total > 0 && TOTAL_REQUEST_PATTERN.test(aiContent)))) {
      saleIntent = 'quotation';
    }
    if (saleIntent === 'quotation' && !gaveTotal && !QUOTE_REQUEST_PATTERN.test(aiContent)) {
      console.log('📋 La IA marcó cotización sin que la clienta la pidiera; no se registra');
      saleIntent = 'other';
    }

    // La personalización y los ajustes de cantidad suelen llegar después de confirmar:
    // mientras haya un pedido en curso, se mantiene al día con lo último que dijo la clienta.
    if (saleIntent !== 'order' && saleIntent !== 'quotation' && plan.order_items.length > 0
      && await getRecentPendingOrder(conversationId)) {
      saleIntent = 'order';
    }

    // Se registra antes de la revisión manual: si confirma y elige tarjeta en el mismo mensaje,
    // el bot se pausa y el pedido igual debe quedar anotado.
    if (saleIntent === 'quotation' || saleIntent === 'order') {
      const transcript = [
        ...conversationHistory.slice(-20).map(t => `${t.role === 'user' ? 'Cliente' : 'VELAMIA'}: ${t.content}`),
        `Cliente: ${aiContent}`,
        `VELAMIA: ${plan.reply}`
      ].join('\n');

      await registerSale(saleIntent, {
        conversationId, phoneNumber, customerName, transcript, catalog,
        shippingPlace: plan.shipping_place, planItems: plan.order_items,
        deliveryDate: plan.delivery_date || lastDeliveryDateFromHistory(history)
      });
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
      // Si la IA ya preguntó algo en su mensaje, el sistema no agrega otra pregunta.
      await sendProductPhotos(conversationId, phoneNumber, photos, catalog, !plan.reply.includes('?'));
    }

    if (plan.intent === 'delivery_status') {
      await handleDeliveryStatusIntent(conversationId, phoneNumber);
    }
  } catch (error) {
    console.error('❌ Error respondiendo mensaje:', error);
  }
}

/** Envía hasta PHOTO_BATCH_SIZE fotos; si quedan más, las guarda y pregunta si desea verlas. */
async function sendProductPhotos(conversationId: string, phoneNumber: string, names: string[], catalog: any[], askAfter = true) {
  const products = names
    .map(name => catalog.find(p => p.name === name))
    .filter(p => p && p.image_url);

  const batch = products.slice(0, PHOTO_BATCH_SIZE);
  const rest = products.slice(PHOTO_BATCH_SIZE).map(p => p.name);
  console.log(`📸 Enviando ${batch.length} foto(s) de productos${rest.length ? ` (quedan ${rest.length})` : ''}`);
  const { business, sales } = profile();

  // Una a una y en orden: si una falla, las demás igual se envían.
  for (const product of batch) {
    try {
      const caption = `${business.productEmoji} *${product.name}*\n💰 $${Number(product.price).toFixed(2)} ${sales.priceSuffix}`;
      await waitGap(phoneNumber, product === batch[0] ? MESSAGE_GAP_MS : PHOTO_GAP_MS);
      const sent = await sendImageMessage(phoneNumber, product.image_url, caption);
      await saveMessage(conversationId, 'bot', 'image', `${product.image_url}\n${caption}`, getSentMessageId(sent));
    } catch (error: any) {
      console.error(`❌ No se pudo enviar la foto de ${product.name}:`, error.message);
    }
  }

  if (rest.length > 0) {
    pendingPhotos.set(conversationId, rest);
    await sendAndSaveText(conversationId, phoneNumber, pick(morePhotosQuestions()));
  } else {
    pendingPhotos.delete(conversationId);
    // Ya vio las fotos: recién ahora tiene sentido preguntarle cuál le gustó.
    if (askAfter && batch.length > 0) {
      await sendAndSaveText(conversationId, phoneNumber, pick(batch.length === 1 ? likedSinglePhotoQuestions() : likedPhotoQuestions()));
    }
  }
}

/**
 * Registra cotizaciones y pedidos en la base. No envía mensajes extra al cliente:
 * la respuesta de la IA ya incluye el detalle y un segundo mensaje con cifras solo confunde.
 */
async function registerSale(
  kind: 'quotation' | 'order',
  ctx: {
    conversationId: string; phoneNumber: string; customerName: string; transcript: string;
    catalog: any[]; shippingPlace: string; planItems: TurnPlan['order_items']; deliveryDate: string;
  }
) {
  try {
    // Los mismos modelos y docenas con que se calculó el valor que recibió la clienta, para que el CRM cuadre.
    // Solo si la IA no los identificó en el turno se leen de nuevo de la conversación.
    const items: OrderItem[] = ctx.planItems.length > 0
      ? ctx.planItems.map(i => ({ name: i.name, price: i.price, quantity: i.quantity, personalization: i.personalization }))
      : await extractOrderItems(ctx.transcript, ctx.catalog);
    if (items.length === 0) {
      console.log(`📋 ${kind} sin productos claros del catálogo; no se registra`);
      return;
    }

    // La clienta ve un solo valor; en el CRM el envío queda como línea aparte para la dueña.
    const units = items.reduce((sum, i) => sum + i.quantity, 0);
    const shipping = ctx.shippingPlace ? shippingCost(ctx.shippingPlace, units) : null;
    const totalAmount = Math.round((items.reduce((sum, i) => sum + i.price * i.quantity, 0) + (shipping?.cost || 0)) * 100) / 100;

    const pendingQuotation = await getRecentPendingQuotation(ctx.conversationId);
    const existingOrder = await getRecentPendingOrder(ctx.conversationId);
    // Con un pedido en curso, lo que venga después (personalización, cambio de cantidad) actualiza ese pedido
    // en lugar de abrir otra cotización: si no, la dueña vería el pedido sin los detalles finales.
    if (kind === 'quotation' && existingOrder) kind = 'order';
    // Si en este turno no se mencionó la fecha, se conserva la que ya tenía el pedido o la cotización.
    const deliveryDate = ctx.deliveryDate
      || deliveryDateFromProducts(existingOrder?.products)
      || deliveryDateFromProducts(pendingQuotation?.products);

    const products: any[] = [
      ...items,
      ...(shipping ? [{ type: 'shipping', name: `Envío a ${shipping.place}`, price: shipping.cost, quantity: 1 }] : []),
      ...(deliveryDate ? [{ type: 'delivery', name: 'Entrega', date: deliveryDate }] : [])
    ];

    const detail = items
      .map(i => `${quantityText(i.quantity)} ${i.name}${i.personalization ? ` (${i.personalization})` : ''}`)
      .join(', ')
      + (shipping ? ` · envío a ${shipping.place}` : ' · sin ciudad de envío')
      + (deliveryDate ? ` · entrega ${formatDate(deliveryDate)}` : profile().dates.enabled ? ' · sin fecha' : '')
      + ` · Total $${totalAmount.toFixed(2)}`;

    const owner = { conversationId: ctx.conversationId, customerPhone: ctx.phoneNumber, customerName: ctx.customerName };
    const signature = (value: any) => {
      try {
        return JSON.stringify(typeof value === 'string' ? JSON.parse(value || '[]') : (value || []));
      } catch {
        return '';
      }
    };

    if (kind === 'quotation') {
      // El cliente vuelve a pedir el total con otra cantidad: se actualiza la misma cotización.
      if (pendingQuotation) {
        const changed = signature(pendingQuotation.products) !== signature(products)
          || Number(pendingQuotation.total_amount) !== totalAmount;
        await updateQuotationItems(pendingQuotation.id, products, totalAmount);
        console.log(`📋 Cotización ${pendingQuotation.id.substring(0, 8)} actualizada: $${totalAmount.toFixed(2)}`);
        // Sin cambios no se avisa dos veces por lo mismo.
        if (!changed) return;
      } else {
        await createQuotation(ctx.conversationId, ctx.phoneNumber, products, totalAmount);
        console.log(`📋 Cotización registrada: $${totalAmount.toFixed(2)}`);
      }
      // La dueña revisa todas las cotizaciones; el bot nunca se pausa por esto.
      await notifyOwner({ ...owner, event: 'new_quotation', detail });
      return;
    }

    // El cliente confirmó: la cotización en curso queda como aceptada.
    if (pendingQuotation) {
      await updateQuotationItems(pendingQuotation.id, products, totalAmount);
      await updateQuotationStatus(pendingQuotation.id, 'accepted');
    }

    // Un cliente suele confirmar varias veces o ajustar detalles después de confirmar:
    // se actualiza el pedido pendiente reciente en lugar de duplicarlo o de dejarlo desactualizado.
    if (existingOrder) {
      const changed = signature(existingOrder.products) !== signature(products)
        || Number(existingOrder.total_amount) !== totalAmount;
      await updateOrderItems(existingOrder.id, products, totalAmount, deliveryDate, shipping?.place);
      console.log(`🛍️ Pedido ${existingOrder.id.substring(0, 8)} actualizado: $${totalAmount.toFixed(2)}`);
      // La personalización y los cambios de cantidad suelen llegar después de confirmar.
      if (changed) await notifyOwner({ ...owner, event: 'order_updated', detail });
      return;
    }

    await createOrder(ctx.conversationId, ctx.phoneNumber, ctx.customerName, products, totalAmount, deliveryDate, shipping?.place);
    console.log(`🛍️ Pedido registrado: $${totalAmount.toFixed(2)}`);
    await notifyOwner({ ...owner, event: 'new_order', detail });
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
