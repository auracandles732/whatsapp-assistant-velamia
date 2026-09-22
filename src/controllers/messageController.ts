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
  logNotification,
  getTenantByPhoneNumberId,
  getRecentMessages,
  getActiveTenants,
  getConversationById,
  hasOptedOut,
  parseDbTimestamp
} from '../db';
import { TenantContext, currentTenant, runWithTenant } from '../services/tenant';
import { maskPhone } from '../services/privacy';
import { isFollowUpMessage, followUpText } from '../services/followups';
import {
  sendTextMessage,
  sendImageMessage,
  getMediaUrl,
  downloadMedia,
  getSentMessageId,
  showTyping
} from '../services/whatsapp';
import {
  planTurn,
  transcribeAudio,
  describeImage,
  extractOrderItems,
  writePhotoNudge,
  TEAM_MARK,
  OrderItem,
  TurnPlan
} from '../services/openai';
import { profile, todayLocal, formatDate, quantityText, usesProductUnits, usesGenderTagging } from '../config/businessProfile';
import { uploadBufferToStorage } from '../services/storage';
import { shippingCost } from '../services/shippingRates';
import { notifyOwner } from '../services/notifications';
import { customDesignAlerts, looksLikeCustomDesign } from '../services/customDesign';
import { productsNamedWithPrice, withOppositeGender, afterPhotosQuestion, needsPhotoNudge } from '../services/photoBackup';

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

// Una respuesta inmediata delata al bot: para todos los negocios, se espera un tiempo humano
// (distinto en cada turno) antes de contestar. Se cuenta desde el primer mensaje de la tanda,
// así que si armar la respuesta ya tardó, se completa solo lo que falte.
export const MIN_HUMAN_REPLY_MS = 30_000;
export const MAX_HUMAN_REPLY_MS = 60_000;

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

// "Escribiendo…" aparece este rato antes de contestar. Meta lo muestra unos 25 s, así que queda
// tiempo para que la IA redacte y el mensaje llegue mientras el indicador sigue vivo.
export const TYPING_LEAD_MS = 15_000;

/** A qué hora toca contestar esta tanda: un rato humano (distinto cada vez) desde el primer mensaje. */
export function humanReadyAt(firstAt: number): number {
  return firstAt + MIN_HUMAN_REPLY_MS + Math.random() * (MAX_HUMAN_REPLY_MS - MIN_HUMAN_REPLY_MS);
}

/**
 * Cuánto falta para contestar: lo que sea mayor entre esperar a que el cliente deje de escribir
 * y la espera humana. Así, lo que escriba mientras tanto entra en la misma respuesta.
 */
export function replyDelayMs(batch: { firstAt: number; readyAt: number }, now = Date.now()): number {
  const silence = Math.max(0, Math.min(RESPONSE_DELAY_MS, batch.firstAt + MAX_RESPONSE_WAIT_MS - now));
  return Math.max(silence, batch.readyAt - now);
}

/** Cuánto falta para mostrar "escribiendo…"; negativo = ya es tarde para mostrarlo. */
export function typingDelayMs(batch: { readyAt: number }, now = Date.now()): number {
  return batch.readyAt - TYPING_LEAD_MS - now;
}

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

// Tras varias fotos, si aún no dijo cuánto necesita: la cantidad acerca a la cotización más que elegir entre fotos.
export const quantityAfterPhotosQuestions = () => {
  const { sales: s, dates } = profile();
  if (dates.enabled && s.piecesPerUnit > 1) {
    return withEmojis(['¿Para cuántos invitados sería? Así te calculo la cantidad de ' + s.unitPlural, '¿Cuántos invitados tendrás? Con eso te digo cuántas ' + s.unitPlural + ' necesitas', '¿Para cuántas personas sería? Así te armo la cantidad exacta']);
  }
  return withEmojis(['¿Qué cantidad de ' + s.unitPlural + ' necesitas?', '¿Qué cantidad tienes en mente?', '¿Para qué cantidad sería?']);
};
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
  /** Hora en que toca contestar (espera humana); no cambia aunque el cliente siga escribiendo. */
  readyAt: number;
  timer?: NodeJS.Timeout;
  typingTimer?: NodeJS.Timeout;
  /** Negocio que recibió los mensajes; sin negocio = VELAMIA. */
  tenant?: TenantContext;
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

/** Clave de la fila de un cliente: el mismo número puede escribirle a VELAMIA y a otro negocio. */
function customerKey(phoneNumber: string, tenant: TenantContext | undefined = currentTenant()) {
  return `${tenant?.businessId || 'velamia'}:${phoneNumber}`;
}

/**
 * A qué negocio le escribieron: Meta envía en cada mensaje el Phone Number ID del número que lo recibió.
 * undefined = VELAMIA; null = número que no pertenece a ningún negocio activo (no se responde).
 */
async function resolveTenant(value: any): Promise<TenantContext | undefined | null> {
  const phoneNumberId = String(value?.metadata?.phone_number_id || '');
  if (!phoneNumberId || phoneNumberId === process.env.WHATSAPP_PHONE_ID) return undefined;

  const tenant = await getTenantByPhoneNumberId(phoneNumberId);
  if (tenant) return tenant;
  if (!process.env.WHATSAPP_PHONE_ID) return undefined;
  console.warn(`⚠️ Mensaje recibido en el número ${phoneNumberId}, que no pertenece a ningún negocio activo: se ignora`);
  return null;
}

export function handleWebhookMessage(message: any, value: any): Promise<void> {
  const from = String(message?.from || 'desconocido');
  // Se ubica el negocio en fila por cliente: así dos mensajes seguidos nunca cambian de orden.
  const routeKey = `route:${value?.metadata?.phone_number_id || ''}:${from}`;
  return enqueue(routeKey, async () => {
    const tenant = await resolveTenant(value);
    if (tenant === null) return;
    if (tenant) console.log(`🏢 Negocio: ${tenant.name}`);
    runWithTenant(tenant, () => {
      enqueue(customerKey(from, tenant), () => ingestMessage(message, value));
    });
  });
}

/**
 * Mensaje que alguien del equipo escribió desde la app de WhatsApp Business del celular (Meta lo avisa como "eco").
 * Se guarda como del equipo y el bot se pausa en ese chat, igual que cuando se escribe desde el CRM.
 */
export function handleEchoMessage(echo: any, value: any): Promise<void> {
  const to = String(echo?.to || '');
  if (!to || !echo?.id) return Promise.resolve();
  // Se espera un momento: si el mensaje lo envió el propio bot, ya quedará guardado con este id y no es del equipo.
  return new Promise(resolve => setTimeout(resolve, 4000)).then(() => enqueue(`route:${value?.metadata?.phone_number_id || ''}:${to}`, async () => {
    const tenant = await resolveTenant(value);
    if (tenant === null) return;
    await new Promise<void>(done => runWithTenant(tenant, () => {
      enqueue(customerKey(to, tenant), async () => {
        if (await isMessageAlreadyProcessed(String(echo.id))) return;
        const conversation = await getConversation(to);
        if (!conversation) return;
        const type = String(echo.type || 'text');
        const text = type === 'text' ? String(echo.text?.body || '') : `[${type} enviado desde el celular] ${echo[type]?.caption || ''}`.trim();
        if (!text) return;
        await saveMessage(conversation.id, 'human', 'text', text, String(echo.id));
        await touchConversation(conversation.id);
        await pauseBot(conversation.id);
        console.log(`📱 El equipo escribió desde el celular a ${maskPhone(to)}: el bot se pausa en ese chat`);
      }).then(() => done(), () => done());
    }));
  })).catch(error => console.error('Error procesando eco del celular:', error.message));
}

/** Programa (o reprograma) la respuesta: se envía tras RESPONSE_DELAY_MS sin mensajes nuevos. */
function scheduleResponse(key: string, batch: PendingBatch) {
  if (batch.timer) clearTimeout(batch.timer);
  const delay = shuttingDown ? 0 : replyDelayMs(batch);

  // Como una persona: lee el mensaje, y poco antes de contestar aparece "escribiendo…".
  if (!batch.typingTimer && !shuttingDown) {
    const lead = typingDelayMs(batch);
    if (lead > -TYPING_LEAD_MS) {
      batch.typingTimer = setTimeout(() => {
        const lastWaId = batch.items[batch.items.length - 1]?.waMessageId;
        if (lastWaId) runWithTenant(batch.tenant, () => showTyping(lastWaId));
      }, Math.max(0, lead));
    }
  }

  // La tanda se cierra recién cuando le toca su turno en la fila: un mensaje que se estaba guardando
  // (una foto o un audio tardan) entra en esta misma respuesta en vez de quedar desordenado.
  batch.timer = setTimeout(() => {
    enqueue(key, async () => {
      if (pendingBatches.get(key) !== batch) return;
      pendingBatches.delete(key);
      clearBatchTimers(batch);
      await respondToBatch(batch);
    });
  }, delay);
}

function clearBatchTimers(batch: PendingBatch) {
  if (batch.timer) clearTimeout(batch.timer);
  if (batch.typingTimer) clearTimeout(batch.typingTimer);
}

/**
 * Render detiene la instancia anterior al publicar una versión: se responde ya lo que estaba
 * en espera y se aguardan las respuestas en curso, sin pasar del tiempo indicado.
 */
export async function flushPendingResponses(timeoutMs: number) {
  shuttingDown = true;
  for (const [key, batch] of [...pendingBatches]) {
    clearBatchTimers(batch);
    pendingBatches.delete(key);
    runWithTenant(batch.tenant, () => enqueue(key, () => respondToBatch(batch)));
  }
  await Promise.race([
    Promise.allSettled([...queues.values()]),
    new Promise(resolve => setTimeout(resolve, timeoutMs))
  ]);
}

/** Olvida lo que estaba en memoria de un chat eliminado desde el CRM. */
export function forgetConversation(phoneNumber: string, conversationId: string) {
  const key = customerKey(String(phoneNumber));
  const batch = pendingBatches.get(key);
  if (batch?.conversationId === conversationId) {
    clearBatchTimers(batch);
    pendingBatches.delete(key);
  }
  pendingPhotos.delete(conversationId);
}

/** Quita la marca "[Mensaje del equipo]" (con o sin espacios, tildes o mayúsculas) de un texto escrito por un cliente. */
export function withoutTeamMark(text: string): string {
  return text.replace(/\[\s*mensaje\s+del\s+equipo\s*\]/gi, '').trim();
}

/** Convierte un mensaje guardado en lo que la IA necesita leer (sin URLs de archivos). */
function toAiText(msg: any): string {
  const raw = String(msg.content || '');
  const text = MEDIA_TYPES.has(msg.type) ? raw.replace(/^https?:\/\/\S+\n?/, '').trim() : raw.trim();
  // Lo que escribió una persona del equipo: la IA lo lee como dicho al cliente y retoma desde ahí.
  if (msg.sender === 'human') return `${TEAM_MARK}${MEDIA_TYPES.has(msg.type) ? '[Archivo] ' : ''}${text}`.trim();
  if (msg.sender === 'bot' && msg.type === 'image') {
    const name = productNameFromCaption(raw);
    return name ? `[Foto enviada del producto: ${name}]` : `[Foto enviada] ${text}`;
  }
  // Un seguimiento lleva una marca invisible solo para el sistema: la IA lo lee como un mensaje normal del equipo.
  if (msg.sender === 'bot' && isFollowUpMessage(raw)) return followUpText(raw);
  if (msg.sender === 'customer') {
    const clean = withoutTeamMark(text);
    if (msg.type === 'image') return `[El cliente envió una foto]: ${clean}`;
    if (msg.type === 'audio') return `[El cliente envió un audio]: ${clean}`;
    if (msg.type === 'document') return `[El cliente envió un documento]: ${clean}`;
    return clean;
  }
  return text;
}

/** Una persona del equipo tomó el chat mientras el bot preparaba su respuesta: no se envía nada más. */
class BotStoodDown extends Error {}

/**
 * Se revisa justo antes de cada envío, no solo al empezar a pensar la respuesta: la IA tarda segundos y en ese lapso
 * alguien pudo escribir desde el CRM o desde el celular. Si el último mensaje del chat es del equipo, el bot se calla.
 */
async function stepAsideIfHumanTookOver(conversationId: string) {
  if (await isBotPaused(conversationId)) throw new BotStoodDown('chat pausado');
  const [last] = await getConversationHistory(conversationId, 1);
  if (last?.sender === 'human') throw new BotStoodDown('el equipo acaba de escribir');
}

/** Envía un texto y lo guarda con el id de WhatsApp, para reconocerlo si el cliente lo responde. */
async function sendAndSaveText(conversationId: string, phoneNumber: string, text: string) {
  await waitGap(phoneNumber, MESSAGE_GAP_MS);
  await stepAsideIfHumanTookOver(conversationId);
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
  const p = profile();

  try {
    switch (type) {
      case 'text':
        return { userContent: message.text.body, aiContent: message.text.body };

      case 'image': {
        const { publicUrl } = await storeIncomingMedia(message.image.id);
        const description = await describeImage(publicUrl, p);
        const caption = message.image.caption;
        return {
          userContent: `${publicUrl}\n${caption ? `${caption}\n📷 ${description}` : description}`,
          aiContent: `[El cliente envió una foto]: ${description}${caption ? ` (con el mensaje: "${caption}")` : ''}`
        };
      }

      case 'audio': {
        const { publicUrl, buffer, mimeType } = await storeIncomingMedia(message.audio.id);
        const transcript = await transcribeAudio(buffer, mimeType, p);
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

    console.log(`📱 Mensaje recibido de ${maskPhone(phoneNumber)} (${messageType})`);

    const content = await readIncomingContent(message);
    if (!content) {
      console.log(`↪️  Mensaje ${messageType} de ${maskPhone(phoneNumber)} ignorado`);
      return;
    }
    let { userContent, aiContent } = content;
    // La marca interna del equipo nunca puede venir de un cliente: la IA le creería como si lo hubiera dicho tu equipo.
    aiContent = withoutTeamMark(aiContent);

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
    const answeredFollowUp = lastMessage?.sender === 'bot' && isFollowUpMessage(lastMessage.content);
    // También cuenta si toca un botón "No" de la plantilla.
    if (answeredFollowUp && ['text', 'button', 'interactive'].includes(messageType) && /^\s*no\s*[.!¡]*\s*$/i.test(userContent)) {
      await recordFollowUp(conversationId, 'opt_out', 'La clienta respondió NO a los seguimientos');
      console.log(`🔕 ${maskPhone(phoneNumber)} no quiere más seguimientos`);
      if ((await getConfig('bot_enabled')) !== 'false' && !(await isBotPaused(conversationId))) {
        await sendAndSaveText(conversationId, phoneNumber, profile().followUps.optOutMessage);
      }
      return;
    }

    const key = customerKey(phoneNumber);
    let batch = pendingBatches.get(key);
    if (!batch) {
      const firstAt = Date.now();
      batch = { conversationId, phoneNumber, customerName, items: [], firstAt, readyAt: humanReadyAt(firstAt), tenant: currentTenant() };
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

    // Los avisos a la dueña van primero y sin espera: solo lo que ve la clienta se demora (más abajo).
    // Siempre se confirma la fecha, pero una entrega muy justa la revisa la dueña (una vez al día por chat).
    const batchProfile = profile();
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

    // Diseño fuera del catálogo: la dueña recibe DOS avisos y el asistente NUNCA se pausa por ellos, sigue conversando.
    //  1) apenas se detecta la idea (sin esperar la cantidad): para que alguien la revise a tiempo;
    //  2) cuando el resumen ya trae la cantidad: "listo para cotizar".
    // Cuando una persona escribe desde el CRM, el chat sí se pausa solo (eso no cambia).
    const photoDescriptions = items.filter(i => i.messageType === 'image').map(i => String(i.storedContent || '').replace(/^\S+\n?/, ''));
    const designBackup = !plan.custom_design_requested && !plan.custom_design_summary
      && looksLikeCustomDesign({ reply: plan.reply || '', photoDescriptions, orderItems: plan.order_items.length });
    if (designBackup) console.log('🎨 La IA no marcó el diseño personalizado, pero la conversación lo indica: se avisa igual');
    if (plan.custom_design_requested || plan.custom_design_summary || designBackup) {
      const summary = plan.custom_design_summary;
      // Umbral más bajo: la IA vuelve a redactar el mismo diseño con otras palabras en cada mensaje.
      const finalAlreadySent = summary ? isRepeatedQuestion(summary, pendingCustomDesigns, catalog, 0.6) : false;
      const alerts = customDesignAlerts({
        requested: plan.custom_design_requested || designBackup,
        summary,
        hasQuantity: summary ? quantityPattern().test(summary) : false,
        earlyRecentlySent: await hasRecentNotification(conversationId, 'custom_design_new', 24),
        finalAlreadySent
      });

      // Si la clienta envió una foto en el chat, se anota en el aviso para que la dueña abra el chat y la vea.
      const clientSentPhoto = history.some((m: any) => m.sender === 'customer' && m.type === 'image')
        || items.some(i => i.messageType === 'image');
      const conFoto = (text: string) => clientSentPhoto && !/foto|imagen|referencia/i.test(text) ? `${text} · con foto de referencia` : text;

      if (alerts.final) {
        const detail = conFoto(summary);
        await notifyOwner({ conversationId, customerPhone: phoneNumber, customerName, event: 'custom_design_request', detail });
        // Con este aviso ya no hace falta el temprano: se anota como enviado para no repetirlo en el siguiente mensaje.
        if (alerts.early) await logNotification(conversationId, 'custom_design_new', detail.slice(0, 500));
        console.log(`🎨 Diseño personalizado listo para cotizar (el asistente sigue atendiendo): ${detail}`);
      } else if (alerts.early) {
        const detail = conFoto(summary || customerDetail);
        await notifyOwner({ conversationId, customerPhone: phoneNumber, customerName, event: 'custom_design_new', detail });
        console.log(`🎨 Nueva idea de diseño personalizado avisada (el asistente sigue atendiendo): ${detail}`);
      } else if (summary) {
        console.log(finalAlreadySent
          ? `🎨 Diseño fuera del catálogo ya avisado, no se repite: ${summary}`
          : `🎨 Diseño fuera del catálogo en preparación, aún falta la cantidad: ${summary}`);
      }
    }

    let photosFromBackup = false;
    if (plan.show_products.length === 0 && plan.reply) {
      const missingPhotos = productsNamedWithPrice(plan.reply, catalog, sentProducts);
      if (missingPhotos.length) {
        console.log(`📸 La IA escribió el modelo con precio sin enviar la foto: se envía igual (${missingPhotos.join(', ')})`);
        plan.show_products = missingPhotos;
        photosFromBackup = true;
      }
    }

    if (plan.reply) {
      await sendAndSaveText(conversationId, phoneNumber, plan.reply);
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

    const quantityKnown = plan.order_items.some(i => Number(i.quantity) > 0)
      || [...history.filter((m: any) => m.sender === 'customer').map((m: any) => String(m.content || '')), aiContent]
        .some(t => quantityPattern().test(t) || /\d+\s*(invitad|persona)/i.test(t));

    if (plan.show_products.length > 0) {
      // Si la IA eligió una tanda de las pendientes, se toman todas: las que no entren quedan para la
      // siguiente pregunta en vez de perderse. Si pidió uno o dos modelos concretos, se envían solo esos.
      const continuesPending = pendingProducts.length > 0
        && plan.show_products.length >= Math.min(PHOTO_BATCH_SIZE, pendingProducts.length)
        && plan.show_products.every(n => pendingProducts.includes(n));
      const photos = continuesPending ? pendingProducts
        : usesGenderTagging(batchProfile) && !photosFromBackup ? withOppositeGender(plan.show_products, catalog, sentProducts) : plan.show_products;
      // Si la IA ya preguntó algo en su mensaje, el sistema no agrega otra pregunta.
      await sendProductPhotos(conversationId, phoneNumber, photos, catalog, !plan.reply.includes('?'), batchProfile,
        afterPhotosQuestion({ quantityKnown, photos: photos.length }));
    }
  } catch (error) {
    if (error instanceof BotStoodDown) {
      console.log(`⏸️ El bot se calla en este chat: ${error.message}`);
      return;
    }
    console.error('❌ Error respondiendo mensaje:', error);
  }
}

/** Envía hasta PHOTO_BATCH_SIZE fotos; si quedan más, las guarda y pregunta si desea verlas. */
async function sendProductPhotos(conversationId: string, phoneNumber: string, names: string[], catalog: any[], askAfter = true, batchProfile?: any, kind: 'liked' | 'quantity' = 'liked') {
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
      // Si el producto tiene su propia unidad (caja, tubo, metro), el precio se muestra con esa y no con la del negocio.
      const ownUnits = usesProductUnits(profToUse);
      const priceUnit = ownUnits && product.sale_unit ? `por ${product.sale_unit}` : sales.priceSuffix;
      const measure = ownUnits && product.measure ? `\n📏 ${product.measure}` : '';
      const caption = `${business.productEmoji} *${product.name}*${measure}\n💰 $${Number(product.price).toFixed(2)} ${priceUnit}${packaging}`;
      await waitGap(phoneNumber, product === batch[0] ? MESSAGE_GAP_MS : PHOTO_GAP_MS);
      await stepAsideIfHumanTookOver(conversationId);
      const sent = await sendImageMessage(phoneNumber, product.image_url, caption);
      await saveMessage(conversationId, 'bot', 'image', `${product.image_url}\n${caption}`, getSentMessageId(sent));
    } catch (error: any) {
      if (error instanceof BotStoodDown) throw error;
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
      const questions = kind === 'quantity' ? quantityAfterPhotosQuestions()
        : batch.length === 1 ? likedSinglePhotoQuestions() : likedPhotoQuestions();
      await sendAndSaveText(conversationId, phoneNumber, pick(questions));
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


// ---------- Seguimiento rápido tras las fotos ----------

const NUDGE_EVENT = 'photo_nudge';
const photoQuestions = () => [...likedPhotoQuestions(), ...likedSinglePhotoQuestions(), ...quantityAfterPhotosQuestions(), ...morePhotosQuestions()];
const asNudgeMessage = (m: any) => ({ sender: m.sender, type: m.type, content: m.content, at: parseDbTimestamp(m.timestamp).getTime() });

/** Revisa los chats del negocio actual y le escribe una vez al día a quien vio fotos y no respondió (también de noche). */
async function runPhotoNudgesForCurrent(now: number): Promise<number> {
  if ((await getConfig('bot_enabled')) === 'false') return 0;
  const recent = await getRecentMessages(new Date(now - 4 * 60 * 60 * 1000).toISOString());
  const byChat = new Map<string, any[]>();
  for (const m of recent) byChat.set(m.conversation_id, [...(byChat.get(m.conversation_id) || []), m]);
  let sent = 0;
  for (const [conversationId, msgs] of byChat) {
    if (!needsPhotoNudge(msgs.map(asNudgeMessage), now, photoQuestions())) continue;
    const conv = await getConversationById(conversationId);
    if (!conv || conv.status === 'closed' || pendingBatches.has(customerKey(conv.phone_number))) continue;
    if (await isBotPaused(conversationId) || await hasOptedOut(conversationId) || await hasRecentNotification(conversationId, NUDGE_EVENT, 24)) continue;
    await enqueue(customerKey(conv.phone_number), async () => {
      // Se revisa otra vez dentro de la fila: la clienta pudo escribir mientras tanto.
      const history = await getConversationHistory(conversationId, HISTORY_LIMIT);
      if (!needsPhotoNudge(history.map(asNudgeMessage), Date.now(), photoQuestions())) return;
      let text = '';
      try {
        const askQuantity = !history.some((m: any) => m.sender === 'customer' && (quantityPattern().test(String(m.content || '')) || /\d+\s*(invitad|persona)/i.test(String(m.content || ''))));
        text = await writePhotoNudge({ askQuantity, history: history.map((m: any) => ({ role: m.sender === 'customer' ? 'user' : 'assistant', content: toAiText(m) })), customPrompt: (await getConfig('system_prompt')) || undefined });
      } catch (error: any) {
        console.error('❌ La IA no redactó el seguimiento rápido:', error.message);
      }
      if (!text || text.includes('$')) text = `¿Pudiste ver los ${profile().sales.productLabelPlural.toLowerCase()}? ${pick(quantityAfterPhotosQuestions())}`;
      // Se anota antes de enviar: si el envío fallara, no se reintenta en bucle.
      await logNotification(conversationId, NUDGE_EVENT, text.slice(0, 500));
      await sendAndSaveText(conversationId, conv.phone_number, text);
      console.log(`👋 Seguimiento rápido a ${maskPhone(conv.phone_number)}: vio fotos y no respondió`);
      sent++;
    }).catch(error => console.error('❌ Seguimiento rápido:', error.message));
  }
  return sent;
}

let nudging = false;
export async function runPhotoNudges(now = Date.now()) {
  if (nudging) return;
  nudging = true;
  try {
    await runWithTenant(undefined, () => runPhotoNudgesForCurrent(now));
    for (const tenant of await getActiveTenants().catch(() => [])) {
      await runWithTenant(tenant, () => runPhotoNudgesForCurrent(now)).catch(error => console.error(`❌ Seguimiento rápido de ${tenant.name}:`, error.message));
    }
  } finally {
    nudging = false;
  }
}

export function startPhotoNudgeScheduler() {
  setInterval(() => runPhotoNudges().catch(error => console.error('❌ Seguimiento rápido:', error.message)), 5 * 60 * 1000);
  console.log('👋 Seguimiento rápido activo: 40 min después de ver fotos sin responder, una vez al día por clienta');
}
