import axios from 'axios';

// Meta retira cada versión de la Graph API a los ~2 años; al pedir una vencida la sustituye
// sin avisar. Revisar la cabecera "facebook-api-version" de las respuestas al actualizar.
const GRAPH_API = 'https://graph.facebook.com/v25.0';

const graph = axios.create({ timeout: 30_000 });

function authHeaders() {
  return { Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}` };
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
      `${GRAPH_API}/${process.env.WHATSAPP_PHONE_ID}/messages`,
      { messaging_product: 'whatsapp', ...payload },
      { headers: authHeaders() }
    );
    console.log(`✅ ${label} enviado a ${payload.to}`);
    return response.data;
  } catch (error: any) {
    console.error(`Error enviando ${label}:`, error.response?.data || error.message);
    throw error;
  }
}

export function sendTextMessage(phoneNumber: string, text: string) {
  return postMessage({ to: normalizePhone(phoneNumber), type: 'text', text: { body: text } }, 'Mensaje');
}

export function sendImageMessage(phoneNumber: string, imageUrl: string, caption?: string) {
  return postMessage({
    to: normalizePhone(phoneNumber),
    type: 'image',
    image: { link: imageUrl, ...(caption && { caption }) }
  }, 'Imagen');
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
