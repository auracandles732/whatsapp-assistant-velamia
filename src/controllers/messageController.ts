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
  hasRecentNotification,
  getRecentNotificationMessages,
  getBusinessByPhoneNumber
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

// Obtiene el perfil del negocio si es multi-tenant, sino usa el perfil global (VELAMIA).
function getProfileForBatch(batch: PendingBatch) {
  if (batch.businessProfile) {
    const { normalizeProfile } = require('../config/businessProfile');
    return normalizeProfile(batch.businessProfile);
  }
  return profile();
}

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

// Palabras que no dicen de qué trata una pregunta (se comparan por sus 4 primeras letras).
const QUESTION_FILLER = new Set(['para', 'como', 'cual', 'este', 'esta', 'esto', 'esos', 'esas', 'dond', 'cuan', 'conf', 'veri', 'sobr', 'preg', 'clie', 'mode', 'prod', 'dese', 'quie', 'sabe', 'tien', 'pued', 'vien', 'hay', 'disp']);

const questionStems = (text: string, exclude: Set<string>) => new Set(
  text.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase().split(/[^a-zñ]+/)
    .filter(word => word.length >= 4)
    .map(word => word.slice(0, 4))
    .filter(stem => !QUESTION_FILLER.has(stem) && !exclude.has(stem))
);

/** Compara por tema: se ignoran los nombres de productos, que harían parecer iguales dos preguntas distintas sobre el mismo modelo. */
export function isRepeatedQuestion(question: string, previous: string[], catalog: { name: string }[] = [], threshold = 0.75): boolean {
  const productWords = questionStems(catalog.map(c => c.name).join(' '), new Set());
  const current = questionStems(question, productWords);
  if (current.size === 0) return previous.length > 0;
  return previous.some(prev => {
    const before = questionStems(prev, productWords);
    if (before.size === 0) return false;
    const shared = [...current].filter(stem => before.has(stem)).length;
    // Casi todo lo que pregunta ahora ya estaba en una pregunta anterior; un tema nuevo ("presentación") sí se avisa.
    return shared / current.size >= threshold;
  });
}

const pick = (options: string[]) => options[Math.floor(Math.random() * options.length)];

/** Lista de productos guardada en un pedido o cotización (columna JSONB, a veces leída como texto). */
function savedProducts(value: any): any[] {
  try {
    const list = typeof value === 'string' ? JSON.parse(value || '[]') : (value || []);
    return Array.isArray(list) ? list.filter(Boolean) : [];
  } catch {
    return [];
  }
}

/** Productos (sin envío ni fecha) guardados en un pedido o cotización anterior. */
function savedItems(value: any): OrderItem[] {
  return savedProducts(value).filter((i: any) => !i.type);
}

/** Destino y costo del envío guardados ("Envío a Quito, Pichincha"). */
function savedShipping(value: any): { place: string; cost: number } | null {
  const line = savedProducts(value).find((i: any) => i.type === 'shipping');
  if (!line) return null;
  return { place: String(line.name || '').replace(/^Envío a\s*/i, '').trim(), cost: Number(line.price) || 0 };
}

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
  businessId?: string;
  businessProfile?: Record<string, any>;
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

    // Multi-tenant: buscar negocio por teléfono (NULL si es VELAMIA)
    let businessId: string | undefined;
    let businessProfile: Record<string, any> | undefined;
    try {
      const business = await getBusinessByPhoneNumber(phoneNumber);
      if (business) {
        businessId = business.id;
        businessProfile = business.business_profile;
        console.log(`🏢 Negocio encontrado: ${business.name}`);
      }
    } catch (err) {
      console.warn('⚠️  Error buscando negocio (usando VELAMIA):', (err as Error).message);
    }

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
      batch = { conversationId, phoneNumber, customerName, items: [], firstAt: Date.now(), businessId, businessProfile };
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

    const [catalog, customPrompt, sentProducts, bankDetails, pendingOwnerQuestions, cardChosen, pendingCustomDesigns, orders] = await Promise.all([
      getAllProducts(),
      getConfig('system_prompt'),
      getSentProductNames(conversationId),
      getConfig('payment_transfer_info'),
      getRecentNotificationMessages(conversationId, 'owner_question', 72),
      // Solo la elección reciente: un pago con tarjeta de hace semanas no aplica a un pedido nuevo.
      hasRecentNotification(conversationId, 'card_payment', 72),
      getRecentNotificationMessages(conversationId, 'custom_design_request', 24 * 30),
      getOrdersByConversation(conversationId)
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
        recentEmojis: recentBotEmojis(history), pendingOwnerQuestions, cardChosen, pendingCustomDesigns,
        lastOrder: describeOrder(orders[0])
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

    // Ya eligió tarjeta y se avisó: un "gracias" posterior no debe volver a pausar el bot ni repetir el aviso.
    if (plan.handoff === 'card_payment' && cardChosen && !/tarjeta|link|enlace|visa|mastercard/i.test(aiContent)) {
      console.log('💳 Pago con tarjeta ya avisado en este chat: no se repite el aviso ni la pausa');
      plan = { ...plan, handoff: 'none' };
    }

    // Respuesta vacía y nada más que enviar: la clienta quedaría sin contestar.
    if (!plan.reply && plan.handoff === 'none' && plan.show_products.length === 0) {
      console.error('❌ La IA devolvió una respuesta vacía');
      if (!(await hasRecentNotification(conversationId, 'bot_error', 1))) {
        await notifyOwner({ conversationId, customerPhone: phoneNumber, customerName, event: 'bot_error', detail: customerDetail });
      }
      return;
    }

    if (plan.reply) {
      await sendAndSaveText(conversationId, phoneNumber, plan.reply);
    }

    // Siempre se confirma la fecha, pero una entrega muy justa la revisa la dueña (una vez al día por chat).
    const batchProfile = getProfileForBatch(batch);
    if (plan.delivery_date && daysUntil(plan.delivery_date) <= batchProfile.dates.urgentDays
      && !(await hasRecentNotification(conversationId, 'urgent_date'))) {
      const days = daysUntil(plan.delivery_date);
      const cuando = days < 0 ? 'ya pasó' : days === 0 ? 'es hoy' : days === 1 ? 'es mañana' : `faltan ${days} días`;
      await notifyOwner({
        conversationId, customerPhone: phoneNumber, customerName, event: 'urgent_date',
        detail: `${batchProfile.dates.eventLabel.replace(/^./, (c: string) => c.toUpperCase())} ${formatDate(plan.event_date)} · entrega ${formatDate(plan.delivery_date)} (${cuando})`
      });
    }

    // Pregunta que el bot no pudo contestar: la dueña recibe el aviso y el bot sigue atendiendo.
    // La misma pregunta ("¿tienen aroma?") no se avisa dos veces aunque la IA la vuelva a marcar.
    if (plan.owner_question && !isRepeatedQuestion(plan.owner_question, pendingOwnerQuestions, catalog)) {
      await notifyOwner({ conversationId, customerPhone: phoneNumber, customerName, event: 'owner_question', detail: plan.owner_question });
    } else if (plan.owner_question) {
      console.log(`❓ Pregunta ya avisada a la dueña, no se repite: ${plan.owner_question}`);
    }

    // "¿Cómo va mi pedido?" sin un pedido pagado registrado: la dueña se entera aunque la IA no lo marque.
    const lastOrderStatus = orders[0]?.status;
    if (plan.intent === 'delivery_status' && !plan.owner_question && (!lastOrderStatus || lastOrderStatus === 'pending')) {
      const question = 'La clienta pregunta por el estado de su pedido';
      if (!isRepeatedQuestion(question, pendingOwnerQuestions, catalog)) {
        await notifyOwner({ conversationId, customerPhone: phoneNumber, customerName, event: 'owner_question', detail: question });
      }
    }

    // Diseño fuera del catálogo: se avisa cuando el resumen ya trae la cantidad (el último dato que se pide).
    // Al avisar, el bot se pausa para que la dueña conteste con el precio; el cliente nunca se entera.
    // El mismo diseño no se vuelve a avisar, pero uno distinto en otra ocasión sí.
    if (plan.custom_design_summary) {
      // Umbral más bajo: la IA vuelve a redactar el mismo diseño con otras palabras en cada mensaje.
      const alreadyNotified = isRepeatedQuestion(plan.custom_design_summary, pendingCustomDesigns, catalog, 0.6);
      const hasQuantity = quantityPattern().test(plan.custom_design_summary);
      // Si la clienta envió una foto en el chat, se anota en el aviso para que la dueña abra el chat y la vea.
      const clientSentPhoto = history.some((m: any) => m.sender === 'customer' && m.type === 'image')
        || items.some(i => i.messageType === 'image');
      const summaryConFoto = clientSentPhoto && !/foto|imagen|referencia/i.test(plan.custom_design_summary)
        ? `${plan.custom_design_summary} · con foto de referencia`
        : plan.custom_design_summary;
      if (!alreadyNotified && hasQuantity) {
        await notifyOwner({ conversationId, customerPhone: phoneNumber, customerName, event: 'custom_design_request', detail: summaryConFoto });
        await pauseBot(conversationId);
        console.log(`🎨 Diseño fuera del catálogo: aviso enviado y bot pausado — ${summaryConFoto}`);
        return;
      }
      console.log(alreadyNotified
        ? `🎨 Diseño fuera del catálogo ya avisado, no se repite: ${plan.custom_design_summary}`
        : `🎨 Diseño fuera del catálogo detectado, aún falta la cantidad: ${plan.custom_design_summary}`);
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
    // Elegir la forma de pago con un total ya calculado es confirmar la compra, aunque la IA marque otra intención.
    if (plan.order_total > 0 && (plan.send_bank_details || plan.handoff === 'card_payment')) saleIntent = 'order';
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

    // La personalización (aroma, colores) y los ajustes de cantidad suelen llegar después del total o de confirmar:
    // mientras haya un pedido o una cotización en curso, se mantiene al día con lo último que dijo la clienta.
    // Solo con el total completo: sin ciudad se guardaría un valor sin envío.
    if (saleIntent !== 'order' && saleIntent !== 'quotation' && plan.order_items.length > 0 && plan.order_total > 0) {
      if (await getRecentPendingOrder(conversationId)) saleIntent = 'order';
      else if (await getRecentPendingQuotation(conversationId)) saleIntent = 'quotation';
    }

    // Se registra antes de la revisión manual: si confirma y elige tarjeta en el mismo mensaje,
    // el bot se pausa y el pedido igual debe quedar anotado.
    if (saleIntent === 'quotation' || saleIntent === 'order') {
      const transcript = [
        ...conversationHistory.slice(-20).map(t => `${t.role === 'user' ? 'Cliente' : batchProfile.business.name}: ${t.content}`),
        `Cliente: ${aiContent}`,
        `${batchProfile.business.name}: ${plan.reply}`
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
      await sendProductPhotos(conversationId, phoneNumber, photos, catalog, !plan.reply.includes('?'), batchProfile);
    }
  } catch (error) {
    console.error('❌ Error respondiendo mensaje:', error);
  }
}

/** Envía hasta PHOTO_BATCH_SIZE fotos; si quedan más, las guarda y pregunta si desea verlas. */
async function sendProductPhotos(conversationId: string, phoneNumber: string, names: string[], catalog: any[], askAfter = true, batchProfile?: any) {
  const products = names
    .map(name => catalog.find(p => p.name === name))
    .filter(p => p && p.image_url);

  const batch = products.slice(0, PHOTO_BATCH_SIZE);
  const rest = products.slice(PHOTO_BATCH_SIZE).map(p => p.name);
  console.log(`📸 Enviando ${batch.length} foto(s) de productos${rest.length ? ` (quedan ${rest.length})` : ''}`);
  const profToUse = batchProfile || profile();
  const { business, sales } = profToUse;

  // Una a una y en orden: si una falla, las demás igual se envían.
  for (const product of batch) {
    try {
      const packaging = profToUse.packaging.enabled && product.description ? `\n🎁 Empaque: ${product.description}` : '';
      const caption = `${business.productEmoji} *${product.name}*\n💰 $${Number(product.price).toFixed(2)} ${sales.priceSuffix}${packaging}`;
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
    const pendingQuotation = await getRecentPendingQuotation(ctx.conversationId);
    const existingOrder = await getRecentPendingOrder(ctx.conversationId);
    // Con un pedido en curso, lo que venga después (personalización, cambio de cantidad) actualiza ese pedido
    // en lugar de abrir otra cotización: si no, la dueña vería el pedido sin los detalles finales.
    if (kind === 'quotation' && existingOrder) kind = 'order';
    const previous = existingOrder?.products ?? pendingQuotation?.products;

    // Los mismos modelos y docenas con que se calculó el valor que recibió la clienta, para que el CRM cuadre.
    // Si en este turno la IA no los repitió, se usan los ya guardados ("confirmo" confirma lo cotizado);
    // solo sin nada guardado se leen de nuevo de la conversación.
    const items: OrderItem[] = ctx.planItems.length > 0
      ? ctx.planItems.map(i => ({
        name: i.name, price: i.price, quantity: i.quantity, personalization: i.personalization,
        packaging: i.packaging, packagingChanged: i.packagingChanged
      }))
      : savedItems(previous).length > 0
        ? savedItems(previous)
        : await extractOrderItems(ctx.transcript, ctx.catalog);
    if (items.length === 0) {
      console.log(`📋 ${kind} sin productos claros del catálogo; no se registra`);
      return;
    }

    // La clienta ve un solo valor; en el CRM el envío queda como línea aparte para la dueña.
    // Si en este turno no se repitió la ciudad, se conserva el envío ya guardado: el total nunca pierde el envío.
    const units = items.reduce((sum, i) => sum + i.quantity, 0);
    const previousShipping = savedShipping(previous);
    const shippingPlace = ctx.shippingPlace || previousShipping?.place || '';
    const recalculated = shippingPlace ? shippingCost(shippingPlace, units) : null;
    const shipping = recalculated
      ? { place: [recalculated.place, recalculated.province].filter((v, i, all) => v && all.indexOf(v) === i).join(', '), cost: recalculated.cost }
      : previousShipping && !ctx.shippingPlace ? previousShipping : null;
    const totalAmount = Math.round((items.reduce((sum, i) => sum + i.price * i.quantity, 0) + (shipping?.cost || 0)) * 100) / 100;
    // Si en este turno no se mencionó la fecha, se conserva la que ya tenía el pedido o la cotización.
    const deliveryDate = ctx.deliveryDate
      || deliveryDateFromProducts(existingOrder?.products)
      || deliveryDateFromProducts(pendingQuotation?.products);

    // La IA no repite en cada mensaje lo que la clienta pidió ("bicolor"): si esta vez no lo dice, se conserva lo guardado.
    const saved = savedItems(existingOrder?.products ?? pendingQuotation?.products);
    for (const item of items) {
      if (item.personalization) continue;
      const previous = saved.find(s => s.name === item.name && s.personalization);
      if (previous) item.personalization = previous.personalization || '';
    }

    const products: any[] = [
      ...items,
      ...(shipping ? [{ type: 'shipping', name: `Envío a ${shipping.place}`, price: shipping.cost, quantity: 1 }] : []),
      ...(deliveryDate ? [{ type: 'delivery', name: 'Entrega', date: deliveryDate }] : [])
    ];

    const detail = items
      .map(i => `${quantityText(i.quantity)} ${i.name}${i.personalization ? ` (${i.personalization})` : ''}`
        + (i.packaging ? ` · empaque ${i.packaging}${i.packagingChanged ? ' (cambió de empaque)' : ''}` : ''))
      .join(', ')
      + (shipping ? ` · envío a ${shipping.place}` : ' · sin ciudad de envío')
      + (deliveryDate ? ` · entrega ${formatDate(deliveryDate)}` : profile().dates.enabled ? ' · sin fecha' : '')
      + ` · Total $${totalAmount.toFixed(2)}`;

    const owner = { conversationId: ctx.conversationId, customerPhone: ctx.phoneNumber, customerName: ctx.customerName };
    const parse = (value: any): any[] => {
      try {
        const list = typeof value === 'string' ? JSON.parse(value || '[]') : (value || []);
        return Array.isArray(list) ? list : [];
      } catch {
        return [];
      }
    };
    // Qué cambió respecto de lo guardado: modelos, cantidades, envío, fecha y total pesan más que la redacción
    // de la personalización, que la IA reescribe con otras palabras en casi cada mensaje.
    const worthNotifying = async (previousProducts: any, previousTotal: any, event: 'new_quotation' | 'order_updated') => {
      const core = (list: any[]) => JSON.stringify(list.map(i => [i.type || '', i.name, i.quantity, i.price, i.date || '']));
      const details = (list: any[]) => JSON.stringify(list.map(i => i.personalization || ''));
      const before = parse(previousProducts);
      if (core(before) !== core(products) || Number(previousTotal) !== totalAmount) return true;
      if (details(before) === details(products)) return false;
      // Solo cambió la personalización: como mucho un aviso cada 30 minutos por chat.
      return !(await hasRecentNotification(ctx.conversationId, event, 0.5));
    };

    if (kind === 'quotation') {
      // El cliente vuelve a pedir el total con otra cantidad: se actualiza la misma cotización.
      if (pendingQuotation) {
        const notify = await worthNotifying(pendingQuotation.products, pendingQuotation.total_amount, 'new_quotation');
        await updateQuotationItems(pendingQuotation.id, products, totalAmount);
        console.log(`📋 Cotización ${pendingQuotation.id.substring(0, 8)} actualizada: $${totalAmount.toFixed(2)}`);
        if (!notify) return;
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
      const notify = await worthNotifying(existingOrder.products, existingOrder.total_amount, 'order_updated');
      await updateOrderItems(existingOrder.id, products, totalAmount, deliveryDate, shipping?.place);
      console.log(`🛍️ Pedido ${existingOrder.id.substring(0, 8)} actualizado: $${totalAmount.toFixed(2)}`);
      // La personalización y los cambios de cantidad suelen llegar después de confirmar.
      if (notify) await notifyOwner({ ...owner, event: 'order_updated', detail });
      return;
    }

    await createOrder(ctx.conversationId, ctx.phoneNumber, ctx.customerName, products, totalAmount, deliveryDate, shipping?.place);
    console.log(`🛍️ Pedido registrado: $${totalAmount.toFixed(2)}`);
    await notifyOwner({ ...owner, event: 'new_order', detail });
  } catch (error) {
    console.error(`❌ Error registrando ${kind}:`, error);
  }
}

export const ORDER_STATUS_LABELS: Record<string, string> = {
  pending: 'pendiente de pago',
  confirmed: 'pago recibido, en preparación',
  shipped: 'enviado, en camino',
  delivered: 'entregado',
  cancelled: 'cancelado'
};

/** Resumen del pedido para la IA: código, estado (lo marca la dueña en el CRM), total, entrega y destino. */
export function describeOrder(order: any): string {
  if (!order) return '';
  const delivery = order.delivery_date ? ` · entrega ${formatDate(String(order.delivery_date).slice(0, 10))}` : '';
  const place = order.customer_address ? ` · envío a ${order.customer_address}` : '';
  return `código ${String(order.id).substring(0, 8).toUpperCase()} · estado: ${ORDER_STATUS_LABELS[order.status] || order.status}`
    + ` · total $${Number(order.total_amount || 0).toFixed(2)}${delivery}${place}`;
}

/** "3 docenas", "36 velas", "2 doc.": la clienta ya dijo cuántas quiere. */
function quantityPattern(): RegExp {
  const s = profile().sales;
  const words = [s.unitSingular, s.unitPlural, s.goodsWord, s.unitSingular.slice(0, 3), 'unidad', 'unidades']
    .filter(Boolean)
    .map(w => w.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  return new RegExp(`\\d+\\s*(${[...new Set(words)].join('|')})`, 'i');
}
