import { sendTextMessage } from './whatsapp';
import { getOwnerPhone, logNotification } from '../db';

export type OwnerEvent = 'card_payment' | 'payment_proof' | 'complaint' | 'new_order';

const EVENT_LABELS: Record<OwnerEvent, string> = {
  card_payment: '💳 Quiere pagar con tarjeta',
  payment_proof: '📸 Envió comprobante de pago',
  complaint: '⚠️ Reclamo o problema con un pedido',
  new_order: '🎉 Nuevo pedido registrado'
};

/**
 * Avisa a la dueña por WhatsApp. Nunca lanza error: un aviso fallido no debe
 * interrumpir la atención al cliente.
 *
 * Nota: WhatsApp solo entrega mensajes libres si ese número escribió al número del
 * negocio en las últimas 24 horas.
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

    const crmUrl = process.env.RENDER_EXTERNAL_URL ? `\n\nResponder en el CRM: ${process.env.RENDER_EXTERNAL_URL}/crm` : '';
    const text = `🔔 *VELAMIA · Atención requerida*\n\n${EVENT_LABELS[event]}\n\n👤 ${customerName}\n📱 +${customerPhone}\n💬 "${detail.slice(0, 300)}"${crmUrl}`;

    await sendTextMessage(ownerPhone, text);
    await logNotification(conversationId, event, detail.slice(0, 500));
    console.log(`📬 Aviso enviado a la dueña: ${event}`);
  } catch (error: any) {
    console.error('❌ No se pudo avisar a la dueña:', error.response?.data || error.message);
  }
}
