import axios from 'axios';
import { currentTenant } from './tenant';
import { maskPhone } from './privacy';

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
export async function showTyping(messageId: string) {
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
  return postMessage({ to: normalizePhone(phoneNumber), type: 'text', text: { body: text } }, 'Mensaje');
}

/** Nota de voz: el audio debe ser OGG con códec Opus (ver toWhatsAppVoice). */
export function sendAudioMessage(phoneNumber: string, audioUrl: string) {
  return postMessage({ to: normalizePhone(phoneNumber), type: 'audio', audio: { link: audioUrl } }, 'Nota de voz');
}

export function sendImageMessage(phoneNumber: string, imageUrl: string, caption?: string) {
  return postMessage({
    to: normalizePhone(phoneNumber),
    type: 'image',
    image: { link: imageUrl, ...(caption && { caption }) }
  }, 'Imagen');
}

/**
 * Plantilla aprobada por Meta: única forma de escribirle a alguien que no escribió
 * en las últimas 24 horas. bodyParams llena las variables {{1}}, {{2}}... del cuerpo.
 */
export function sendTemplateMessage(phoneNumber: string, templateName: string, languageCode: string, bodyParams: string[] = []) {
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
    params: { fields: 'name,status,language,components', limit: 200 }
  });
  return response.data.data || [];
}

/** Explica en español los rechazos de WhatsApp más comunes al escribir desde el CRM. */
export function describeWhatsAppError(error: any): string {
  const code = error.response?.data?.error?.code;
  if (code === 131047) {
    return 'Pasaron más de 24 horas desde el último mensaje de la clienta y WhatsApp no permite escribirle libremente. El seguimiento automático la contactará con una plantilla aprobada.';
  }
  if (code === 131026) return 'WhatsApp no pudo entregar el mensaje: el número no está disponible en WhatsApp.';
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
