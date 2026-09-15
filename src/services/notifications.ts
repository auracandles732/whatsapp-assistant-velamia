import { sendTextMessage, sendTemplateMessage } from './whatsapp';
import { getOwnerPhone, logNotification } from './supabase';

export type OwnerEvent = 'card_payment' | 'payment_proof' | 'complaint' | 'new_order' | 'bot_error' | 'bank_details_missing' | 'owner_question' | 'urgent_date';

const EVENT_LABELS: Record<OwnerEvent, string> = {
  urgent_date: '📅 Pedido con entrega para hoy o una fecha ya pasada',
  owner_question: '❓ El bot no supo responder una pregunta',
  card_payment: '💳 Quiere pagar con tarjeta, envíale el link de pago',
  bank_details_missing: '🏦 Eligió transferencia, pero faltan tus datos bancarios en el CRM',
  payment_proof: '📸 Envió comprobante de pago',
  complaint: '⚠️ Reclamo o problema con un pedido',
  new_order: '🎉 Nuevo pedido registrado',
  bot_error: '🤖 El bot no pudo responder, responde tú desde el CRM'
};

// Plantilla aprobada por Meta: llega aunque la dueña no haya escrito al bot en 24 horas.
const ALERT_TEMPLATE = 'velamia_aviso_equipo';
const ALERT_TEMPLATE_LANGUAGE = 'es';

/** WhatsApp rechaza variables de plantilla con saltos de línea, tabulaciones o muchos espacios. */
function toTemplateParam(value: string): string {
  return value.replace(/[\n\t\r]+/g, ' ').replace(/ {4,}/g, '   ').trim().slice(0, 200) || '-';
}

/**
 * Avisa a la dueña por WhatsApp. Nunca lanza error: un aviso fallido no debe
 * interrumpir la atención al cliente. Si la plantilla no está disponible (en revisión
 * o rechazada) se intenta con texto libre, que solo llega dentro de las 24 horas.
 */
export async function notifyOwner(params: {
  conversationId: string;
  customerPhone: string;
  customerName: string;
  event: OwnerEvent;
  detail: string;
}) {
  const { conversationId, customerPhone, customerName, event, detail } = params;

  try {
    const ownerPhone = await getOwnerPhone();
    if (!ownerPhone) {
      console.log('⚠️ Número de la dueña no configurado, no se envió aviso');
      return;
    }

    try {
      await sendTemplateMessage(ownerPhone, ALERT_TEMPLATE, ALERT_TEMPLATE_LANGUAGE,
        [EVENT_LABELS[event], customerName, `+${customerPhone}`, detail].map(toTemplateParam));
    } catch (templateError: any) {
      console.warn('⚠️ Plantilla de aviso no disponible, se envía texto libre:', templateError.response?.data?.error?.message || templateError.message);
      const crmUrl = process.env.RENDER_EXTERNAL_URL ? `\n\nResponder en el CRM: ${process.env.RENDER_EXTERNAL_URL}/crm` : '';
      await sendTextMessage(ownerPhone, `🔔 *VELAMIA · Atención requerida*\n\n${EVENT_LABELS[event]}\n\n👤 ${customerName}\n📱 +${customerPhone}\n💬 "${detail.slice(0, 300)}"${crmUrl}`);
    }

    await logNotification(conversationId, event, detail.slice(0, 500));
    console.log(`📬 Aviso enviado a la dueña: ${event}`);
  } catch (error: any) {
    console.error('❌ No se pudo avisar a la dueña:', error.response?.data || error.message);
  }
}
