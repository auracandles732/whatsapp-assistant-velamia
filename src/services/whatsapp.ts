import axios from 'axios';

const WHATSAPP_API_URL = 'https://graph.facebook.com/v18.0';
const PHONE_ID = process.env.WHATSAPP_PHONE_ID;
const TOKEN = process.env.WHATSAPP_TOKEN;

interface WhatsAppMessage {
  messaging_product: string;
  to: string;
  type: string;
  [key: string]: any;
}

export async function sendTextMessage(phoneNumber: string, text: string) {
  try {
    const message: WhatsAppMessage = {
      messaging_product: 'whatsapp',
      to: phoneNumber,
      type: 'text',
      text: { body: text }
    };

    const response = await axios.post(
      `${WHATSAPP_API_URL}/${PHONE_ID}/messages`,
      message,
      { headers: { Authorization: `Bearer ${TOKEN}` } }
    );

    console.log(`✅ Mensaje enviado a ${phoneNumber}`);
    return response.data;
  } catch (error: any) {
    console.error('Error enviando mensaje:', error.response?.data || error.message);
    throw error;
  }
}

export async function sendImageMessage(phoneNumber: string, imageUrl: string, caption?: string) {
  try {
    const message: WhatsAppMessage = {
      messaging_product: 'whatsapp',
      to: phoneNumber,
      type: 'image',
      image: {
        link: imageUrl,
        ...(caption && { caption })
      }
    };

    const response = await axios.post(
      `${WHATSAPP_API_URL}/${PHONE_ID}/messages`,
      message,
      { headers: { Authorization: `Bearer ${TOKEN}` } }
    );

    console.log(`✅ Imagen enviada a ${phoneNumber}`);
    return response.data;
  } catch (error: any) {
    console.error('Error enviando imagen:', error.response?.data || error.message);
    throw error;
  }
}

export async function sendTemplateMessage(phoneNumber: string, templateName: string, parameters: any[]) {
  try {
    const message: WhatsAppMessage = {
      messaging_product: 'whatsapp',
      to: phoneNumber,
      type: 'template',
      template: {
        name: templateName,
        language: { code: 'es_ES' },
        parameters: { body: { parameters } }
      }
    };

    const response = await axios.post(
      `${WHATSAPP_API_URL}/${PHONE_ID}/messages`,
      message,
      { headers: { Authorization: `Bearer ${TOKEN}` } }
    );

    console.log(`✅ Plantilla "${templateName}" enviada a ${phoneNumber}`);
    return response.data;
  } catch (error: any) {
    console.error('Error enviando plantilla:', error.response?.data || error.message);
    throw error;
  }
}

export async function getMediaUrl(mediaId: string): Promise<{ url: string; mimeType: string }> {
  const response = await axios.get(`${WHATSAPP_API_URL}/${mediaId}`, {
    headers: { Authorization: `Bearer ${TOKEN}` }
  });
  return { url: response.data.url, mimeType: response.data.mime_type };
}

export async function downloadMedia(mediaUrl: string): Promise<Buffer> {
  const response = await axios.get(mediaUrl, {
    headers: { Authorization: `Bearer ${TOKEN}` },
    responseType: 'arraybuffer'
  });
  return Buffer.from(response.data);
}

export async function sendButtonMessage(phoneNumber: string, text: string, buttons: any[]) {
  try {
    const message: WhatsAppMessage = {
      messaging_product: 'whatsapp',
      to: phoneNumber,
      type: 'interactive',
      interactive: {
        type: 'button',
        body: { text },
        action: { buttons }
      }
    };

    const response = await axios.post(
      `${WHATSAPP_API_URL}/${PHONE_ID}/messages`,
      message,
      { headers: { Authorization: `Bearer ${TOKEN}` } }
    );

    console.log(`✅ Mensaje interactivo enviado a ${phoneNumber}`);
    return response.data;
  } catch (error: any) {
    console.error('Error enviando mensaje interactivo:', error.response?.data || error.message);
    throw error;
  }
}
