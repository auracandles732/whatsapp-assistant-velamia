import { sendTextMessage } from './whatsapp';
import { getOwnerPhone, logNotification } from '../db';

const EVENT_LABELS: { [key: string]: string } = {
  payment_card: '💳 Pago con tarjeta',
  payment_proof: '📸 Cliente envió comprobante de pago',
  complaint: '⚠️ Reclamo o queja',
  ask_person: '👤 Cliente pidió hablar con una persona'
};

/**
 * Detecta si un mensaje contiene indicios de que requiere intervención del dueño.
 */
export function detectNeedsIntervention(messageText: string, intent: any): {
  needed: boolean;
  eventType: string;
  reason: string;
} {
  const lower = messageText.toLowerCase();

  // Pago con tarjeta
  if (
    lower.includes('tarjeta') ||
    lower.includes('visa') ||
    lower.includes('mastercard') ||
    lower.includes('debito') ||
    lower.includes('pagar con tarjeta') ||
    lower.includes('aceptan tarjeta')
  ) {
    return {
      needed: true,
      eventType: 'payment_card',
      reason: 'Cliente quiere pagar con tarjeta'
    };
  }

  // Comprobante de pago
  if (
    lower.includes('te envio') ||
    lower.includes('te mando') ||
    lower.includes('ya pague') ||
    lower.includes('ya transferi') ||
    lower.includes('transferencia') ||
    lower.includes('comprobante') ||
    lower.includes('depósito') ||
    intent.intent === 'payment'
  ) {
    const hasFileOrImage = messageText.includes('[foto]') || messageText.includes('http');
    if (hasFileOrImage || lower.includes('mira') || lower.includes('aqui')) {
      return {
        needed: true,
        eventType: 'payment_proof',
        reason: 'Cliente envió comprobante de pago para verificar'
      };
    }
  }

  // Reclamo o diseño especial
  if (
    lower.includes('problema') ||
    lower.includes('error') ||
    lower.includes('dañ') ||
    lower.includes('roto') ||
    lower.includes('mal') ||
    lower.includes('reclaim') ||
    lower.includes('queja') ||
    lower.includes('personaliz') ||
    lower.includes('custom') ||
    lower.includes('a mi gusto') ||
    lower.includes('especial') ||
    intent.intent === 'complaint'
  ) {
    return {
      needed: true,
      eventType: 'complaint',
      reason: 'Cliente tiene un reclamo o pide personalización'
    };
  }

  // Pedir hablar con persona
  if (
    lower.includes('persona') ||
    lower.includes('hablar con') ||
    lower.includes('atender') ||
    lower.includes('gerente') ||
    lower.includes('dueño') ||
    lower.includes('eres robot') ||
    lower.includes('eres un bot')
  ) {
    return {
      needed: true,
      eventType: 'ask_person',
      reason: 'Cliente pidió hablar con una persona'
    };
  }

  return { needed: false, eventType: '', reason: '' };
}

/**
 * Envía una notificación al dueño por WhatsApp.
 * Requiere una plantilla aprobada en Meta.
 */
export async function notifyOwner(
  conversationId: string,
  customerPhone: string,
  customerName: string,
  eventType: string,
  reason: string
) {
  try {
    const ownerPhone = await getOwnerPhone();
    if (!ownerPhone) {
      console.log('⚠️ Número del dueño no configurado, no se envió notificación');
      return;
    }

    const eventLabel = EVENT_LABELS[eventType] || eventType;
    const message = `🔔 *NOTIFICACIÓN DE CLIENTE*\n\n${eventLabel}\n\n👤 Cliente: ${customerName}\n📱 Teléfono: ${customerPhone}\n💬 Motivo: ${reason}\n\nGo al CRM para responder.`;

    // Por ahora usamos texto simple; en producción sería una plantilla Meta aprobada
    await sendTextMessage(ownerPhone, message);
    await logNotification(conversationId, eventType, reason);

    console.log(`📬 Notificación enviada al dueño: ${eventLabel}`);
  } catch (error) {
    console.error('❌ Error enviando notificación:', error);
  }
}
