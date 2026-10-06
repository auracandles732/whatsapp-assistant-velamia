import axios from 'axios';
import { currentTenant } from './tenant';
import { maskPhone } from './privacy';
import { isSocialAddress, sendSocialText, sendSocialImage, showSocialTyping } from './metaChannels';

// Meta retira cada versión de la Graph API a los ~2 años; al pedir una vencida la sustituye
// sin avisar. Revisar la cabecera "facebook-api-version" de las respuestas al actualizar.
const GRAPH_API = 'https://graph.facebook.com/v25.0';

const graph = axios.create({ timeout: 30_000 });

/**
 * Credenciales del número que atiende: las del negocio en curso o, fuera de un negocio, las de VELAMIA.
 * Un negocio nunca usa el número ni el token de VELAMIA como respaldo.
 */
function credentials() {
  const tenant = currentTenant();
  if (!tenant) {
    return { token: process.env.WHATSAPP_TOKEN || '', phoneId: process.env.WHATSAPP_PHONE_ID || '', wabaId: process.env.WHATSAPP_BUSINESS_ACCOUNT_ID || '' };
  }
  if (!tenant.whatsappToken || !tenant.whatsappPhoneId) {
    throw new Error(`El negocio ${tenant.name} no tiene configurado su número de WhatsApp (token o Phone Number ID)`);
  }
  return { token: tenant.whatsappToken, phoneId: tenant.whatsappPhoneId, wabaId: tenant.wabaId };
}

function authHeaders() {
  return { Authorization: `Bearer ${credentials().token}` };
}

/**
 * WhatsApp exige el número en formato internacional sin "+" ni ceros iniciales.
 * Los números de Ecuador escritos localmente (0986673197) se convierten a 593986673197.
 */
export function normalizePhone(phoneNumber: string): string {
  const digits = String(phoneNumber).replace(/\D/g, '');
  if (digits.startsWith('0') && digits.length === 10) return `593${digits.slice(1)}`;
  return digits;
}

/** Id que Meta asigna al mensaje enviado; permite reconocer cuando el cliente lo responde. */
export function getSentMessageId(responseData: any): string | undefined {
  return responseData?.messages?.[0]?.id;
}

async function postMessage(payload: Record<string, any>, label: string) {
  try {
    const response = await graph.post(
      `${GRAPH_API}/${credentials().phoneId}/messages`,
      { messaging_product: 'whatsapp', ...payload },
      { headers: authHeaders() }
    );
    console.log(`✅ ${label} enviado a ${maskPhone(payload.to)}`);
    return response.data;
  } catch (error: any) {
    console.error(`Error enviando ${label}:`, error.response?.data || error.message);
    throw error;
  }
}

/**
 * Marca como leído el último mensaje de la clienta y muestra "escribiendo…" (dura unos 25 s o hasta
 * que se envía la respuesta). Es solo un detalle de naturalidad: nunca lanza error.
 */
export async function showTyping(messageId: string, to?: string) {
  if (to && isSocialAddress(to)) return showSocialTyping(to);
  if (!messageId) return;
  try {
    await graph.post(
      `${GRAPH_API}/${credentials().phoneId}/messages`,
      { messaging_product: 'whatsapp', status: 'read', message_id: messageId, typing_indicator: { type: 'text' } },
      { headers: authHeaders() }
    );
  } catch (error: any) {
    console.warn('No se pudo mostrar "escribiendo…":', error.response?.data?.error?.message || error.message);
  }
}

export function sendTextMessage(phoneNumber: string, text: string) {
  if (isSocialAddress(phoneNumber)) return sendSocialText(phoneNumber, text);
  return postMessage({ to: normalizePhone(phoneNumber), type: 'text', text: { body: text } }, 'Mensaje');
}

/** Nota de voz: el audio debe ser OGG con códec Opus (ver toWhatsAppVoice). */
export function sendAudioMessage(phoneNumber: string, audioUrl: string) {
  if (isSocialAddress(phoneNumber)) return Promise.reject(new Error('Las notas de voz por ahora solo se envían por WhatsApp'));
  return postMessage({ to: normalizePhone(phoneNumber), type: 'audio', audio: { link: audioUrl } }, 'Nota de voz');
}

export function sendImageMessage(phoneNumber: string, imageUrl: string, caption?: string) {
  if (isSocialAddress(phoneNumber)) return sendSocialImage(phoneNumber, imageUrl, caption);
  return postMessage({
    to: normalizePhone(phoneNumber),
    type: 'image',
    image: { link: imageUrl, ...(caption && { caption }) }
  }, 'Imagen');
}

/**
 * Mensaje con hasta 3 botones de respuesta (el id vuelve en la respuesta). Solo llega dentro de las 24 horas desde el
 * último mensaje de esa persona.
 */
export function sendButtonsMessage(phoneNumber: string, body: string, buttons: { id: string; title: string }[]) {
  return postMessage({
    to: normalizePhone(phoneNumber),
    type: 'interactive',
    interactive: {
      type: 'button',
      body: { text: [...body].slice(0, 1024).join('') },
      action: { buttons: buttons.slice(0, 3).map(b => ({ type: 'reply', reply: { id: b.id.slice(0, 256), title: [...b.title].slice(0, 20).join('') } })) }
    }
  }, 'Mensaje con botones');
}

/** Archivo (por ejemplo un PDF) desde una dirección pública. */
export function sendDocumentMessage(phoneNumber: string, url: string, filename: string, caption?: string) {
  return postMessage({
    to: normalizePhone(phoneNumber),
    type: 'document',
    document: { link: url, filename, ...(caption && { caption: caption.slice(0, 1024) }) }
  }, 'Documento');
}

/**
 * Plantilla aprobada por Meta: única forma de escribirle a alguien que no escribió
 * en las últimas 24 horas. bodyParams llena las variables {{1}}, {{2}}... del cuerpo.
 */
export function sendTemplateMessage(phoneNumber: string, templateName: string, languageCode: string, bodyParams: string[] = []) {
  if (isSocialAddress(phoneNumber)) return Promise.reject(new Error('Las plantillas solo existen en WhatsApp'));
  return postMessage({
    to: normalizePhone(phoneNumber),
    type: 'template',
    template: {
      name: templateName,
      language: { code: languageCode },
      ...(bodyParams.length > 0 && {
        components: [{ type: 'body', parameters: bodyParams.map(text => ({ type: 'text', text })) }]
      })
    }
  }, `Plantilla ${templateName}`);
}

export async function getMessageTemplates(): Promise<any[]> {
  const waba = credentials().wabaId;
  if (!waba) throw new Error(currentTenant() ? `El negocio ${currentTenant()!.name} no tiene WhatsApp Business Account ID` : 'Falta la variable WHATSAPP_BUSINESS_ACCOUNT_ID');

  const response = await graph.get(`${GRAPH_API}/${waba}/message_templates`, {
    headers: authHeaders(),
    params: { fields: 'name,status,language,category,components,rejected_reason', limit: 200 }
  });
  return response.data.data || [];
}

export interface TemplateSummary { name: string; status: string; language: string; category: string; text: string; rejectedReason: string }

/** Lo que el CRM muestra de una plantilla: cómo está en Meta y el texto de su cuerpo. */
export function summarizeTemplate(t: any): TemplateSummary {
  const body = (t?.components || []).find((c: any) => c.type === 'BODY');
  const rejected = String(t?.rejected_reason || '');
  return {
    name: String(t?.name || ''),
    status: String(t?.status || ''),
    language: String(t?.language || ''),
    category: String(t?.category || ''),
    text: String(body?.text || ''),
    rejectedReason: rejected === 'NONE' ? '' : rejected
  };
}

export interface NewTemplate { name: string; category: string; language: string; body: string; examples: string[]; quickReplies?: string[] }

export const TEMPLATE_CATEGORIES = ['UTILITY', 'MARKETING'];

/** Cuántas variables ({{1}}, {{2}}…) lleva el texto; -1 si no van en orden desde el 1. */
export function templateVariables(body: string): number {
  const numbers = [...new Set((body.match(/\{\{\s*\d+\s*\}\}/g) || []).map(v => Number(v.replace(/\D/g, ''))))].sort((a, b) => a - b);
  return numbers.every((n, i) => n === i + 1) ? numbers.length : -1;
}

/** Revisa una plantilla antes de enviarla a Meta: devuelve qué corregir, o '' si está bien. */
export function templateProblem(t: NewTemplate): string {
  if (!/^[a-z0-9_]{1,512}$/.test(t.name)) return 'El nombre solo puede llevar letras minúsculas, números y guion bajo (_), sin espacios ni tildes.';
  if (!TEMPLATE_CATEGORIES.includes(t.category)) return 'Elige el tipo de plantilla.';
  if (!/^[a-z]{2}(_[A-Z]{2})?$/.test(t.language)) return 'El idioma no es válido.';
  if (!t.body) return 'Escribe el texto de la plantilla.';
  if ([...t.body].length > 1024) return 'El texto no puede pasar de 1024 caracteres.';
  const variables = templateVariables(t.body);
  if (variables < 0) return 'Las variables deben ir en orden y sin saltos: {{1}}, {{2}}, {{3}}…';
  if (/^\s*\{\{/.test(t.body) || /\}\}\s*$/.test(t.body)) return 'Meta no acepta que el texto empiece o termine con una variable: agrega alguna palabra antes o después.';
  if (t.examples.length !== variables || t.examples.some(e => !e)) return 'Escribe un ejemplo para cada variable: Meta lo exige para aprobar la plantilla.';
  return '';
}

/** Crea la plantilla en la cuenta de WhatsApp del negocio: Meta la revisa antes de dejar usarla. */
export async function createMessageTemplate(t: NewTemplate): Promise<{ id: string; status: string }> {
  const waba = credentials().wabaId;
  if (!waba) throw new Error(currentTenant() ? `El negocio ${currentTenant()!.name} no tiene WhatsApp Business Account ID` : 'Falta la variable WHATSAPP_BUSINESS_ACCOUNT_ID');
  const response = await graph.post(`${GRAPH_API}/${waba}/message_templates`, {
    name: t.name,
    category: t.category,
    language: t.language,
    components: [
      { type: 'BODY', text: t.body, ...(t.examples.length > 0 && { example: { body_text: [t.examples] } }) },
      ...(t.quickReplies?.length ? [{ type: 'BUTTONS', buttons: t.quickReplies.slice(0, 3).map(text => ({ type: 'QUICK_REPLY', text: [...text].slice(0, 25).join('') })) }] : [])
    ]
  }, { headers: authHeaders() });
  return { id: String(response.data?.id || ''), status: String(response.data?.status || 'PENDING') };
}

/**
 * Meta rechazó el envío porque pasaron más de 24 horas desde el último mensaje de la clienta (WhatsApp, Instagram o
 * Messenger). El código 10 también es "la App no tiene permiso": solo cuenta como plazo cuando Meta lo dice.
 */
export function isOutsideWindowError(error: any): boolean {
  const data = error?.response?.data?.error || {};
  if (data.code === 131047 || data.code === 551) return true;
  // 2018278 es el subcódigo de Messenger y 2534022 el de Instagram; el texto llega traducido, por eso no basta con leerlo.
  return [2018278, 2534022].includes(data.error_subcode) || /outside (of )?(the )?allowed window/i.test(String(data.message || ''));
}

const numberCache = new Map<string, { at: number; value: string }>();

/** El número de WhatsApp de la empresa en curso (solo dígitos), preguntado a Meta y guardado un día. '' si no se sabe. */
export async function businessWhatsAppNumber(): Promise<string> {
  const key = currentTenant()?.businessId || 'velamia';
  const cached = numberCache.get(key);
  if (cached && Date.now() - cached.at < 86_400_000) return cached.value;
  const { phoneId } = credentials();
  const { data } = await graph.get(`${GRAPH_API}/${phoneId}`, { headers: authHeaders(), params: { fields: 'display_phone_number' } });
  const value = String(data?.display_phone_number || '').replace(/\D/g, '');
  numberCache.set(key, { at: Date.now(), value });
  return value;
}

/** Explica en español los rechazos de WhatsApp más comunes al escribir desde el CRM. */
export function describeWhatsAppError(error: any): string {
  const code = error.response?.data?.error?.code;
  if (code === 131047) {
    return 'Pasaron más de 24 horas desde el último mensaje de la clienta y WhatsApp no permite escribirle libremente hasta que ella responda.';
  }
  if (code === 131026) return 'WhatsApp no pudo entregar el mensaje: el número no está disponible en WhatsApp.';
  const metaMessage = String(error.response?.data?.error?.message || '');
  if (isOutsideWindowError(error)) {
    return 'Pasaron más de 24 horas desde el último mensaje de la clienta y Meta no permite escribirle por Instagram o Messenger hasta que ella vuelva a escribir.';
  }
  if (code === 10) return `Meta no permitió enviar el mensaje: ${metaMessage}`;
  if (error.message?.startsWith('Las notas de voz por ahora')) return error.message;
  return error.response?.data?.error?.message || error.message;
}

export async function getMediaUrl(mediaId: string): Promise<{ url: string; mimeType: string }> {
  const response = await graph.get(`${GRAPH_API}/${mediaId}`, { headers: authHeaders() });
  return { url: response.data.url, mimeType: response.data.mime_type };
}

export async function downloadMedia(mediaUrl: string): Promise<Buffer> {
  const response = await graph.get(mediaUrl, {
    headers: authHeaders(),
    responseType: 'arraybuffer',
    timeout: 60_000,
    maxContentLength: 25 * 1024 * 1024
  });
  return Buffer.from(response.data);
}
