import { sendTextMessage, sendTemplateMessage } from './whatsapp';
import { getOwnerPhone, logNotification } from './supabase';
import { profile } from '../config/businessProfile';
import { contactLabel } from './metaChannels';

export type OwnerEvent = 'card_payment' | 'payment_proof' | 'complaint' | 'new_order' | 'new_quotation' | 'order_updated' | 'bot_error' | 'bank_details_missing' | 'owner_question' | 'urgent_date' | 'custom_design_request' | 'custom_design_new';

const EVENT_LABELS: Record<OwnerEvent, string> = {
  urgent_date: '📅 Entrega muy cerca o fecha ya pasada, revísalo',
  new_quotation: '🧾 Cotización enviada a una clienta, revísala',
  order_updated: '✏️ Un pedido cambió, revísalo',
  owner_question: '❓ El bot no supo responder una pregunta',
  card_payment: '💳 Quiere pagar con tarjeta, envíale el link de pago',
  bank_details_missing: '🏦 Eligió transferencia, pero faltan tus datos bancarios en el CRM',
  payment_proof: '📸 Envió comprobante de pago',
  complaint: '⚠️ Reclamo o problema con un pedido',
  new_order: '🎉 Nuevo pedido registrado',
  bot_error: '🤖 El bot no pudo responder, responde tú desde el CRM',
  custom_design_request: '🎨 Diseño personalizado listo para cotizar, responde tú con el precio',
  custom_design_new: '🎨 Nueva idea de diseño personalizado, échale un vistazo (el asistente sigue atendiendo)'
};

// Plantilla aprobada por Meta (nombre en el perfil del negocio): llega aunque la dueña no haya escrito al bot en 24 horas.
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

    const { alerts, business } = profile();
    try {
      if (!alerts.template) throw new Error('sin plantilla de aviso en el perfil');
      await sendTemplateMessage(ownerPhone, alerts.template, ALERT_TEMPLATE_LANGUAGE,
        [EVENT_LABELS[event], customerName, contactLabel(customerPhone), detail].map(toTemplateParam));
    } catch (templateError: any) {
      console.warn('⚠️ Plantilla de aviso no disponible, se envía texto libre:', templateError.response?.data?.error?.message || templateError.message);
      const crmUrl = process.env.RENDER_EXTERNAL_URL ? `\n\nResponder en el CRM: ${process.env.RENDER_EXTERNAL_URL}/crm` : '';
      await sendTextMessage(ownerPhone, `🔔 *${business.name} · Atención requerida*\n\n${EVENT_LABELS[event]}\n\n👤 ${customerName}\n📱 ${contactLabel(customerPhone)}\n💬 "${detail.slice(0, 300)}"${crmUrl}`);
    }

    await logNotification(conversationId, event, detail.slice(0, 500));
    console.log(`📬 Aviso enviado a la dueña: ${event}`);
  } catch (error: any) {
    console.error('❌ No se pudo avisar a la dueña:', error.response?.data || error.message);
  }
}
