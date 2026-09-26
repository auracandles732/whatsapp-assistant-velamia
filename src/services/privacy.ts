/** Número para los registros del servidor: solo los últimos 4 dígitos, para no guardar el teléfono completo de la clienta. */
export function maskPhone(phone: unknown): string {
  const digits = String(phone ?? '').replace(/\D/g, '');
  if (digits.length <= 4) return '••••';
  return '•'.repeat(digits.length - 4) + digits.slice(-4);
}

const plain = (text: string) => String(text || '').normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase().replace(/\s+/g, ' ');

export type PrivacyRequest = 'datos' | 'no_contactar' | null;

/**
 * ¿La clienta pide ejercer sus derechos sobre sus datos (Ley Orgánica de Protección de Datos Personales)? "datos": ver,
 * copiar o borrar sus datos (hay que responderle en máximo 15 días); "no_contactar": que no le escriban más. Solo frases
 * claras: "borra mi pedido" o "mis datos para la factura son…" no cuentan. Sin efectos, para probarla.
 */
export function privacyRequest(text: string): PrivacyRequest {
  const t = plain(text);
  const erase = /\b(borr|elimin|suprim|destru|quit)\w*\b[^.?!]{0,25}\b(mis|mi)\s+(datos|informacion|numero|registros?|conversacion(es)?|chats?|historial)\b/;
  const see = /\b(que|cuales)\s+datos\s+(mios\s+)?(tienen|guardan|tiene|guarda|tienes|guardas)\b|\b(acceso|copia)\s+(a|de)\s+(todos\s+)?mis\s+datos\b|\b(ver|conocer|saber)\s+(que\s+)?(todos\s+)?mis\s+datos\s+(personales\s+)?(tienen|guardan|registrados)\b/;
  if (erase.test(t) || see.test(t)) return 'datos';
  const stop = /\b(no\s+(me\s+)?(vuelvan\s+a\s+|sigan\s+)?(escriban|escribas|contacten|contactes|manden|mandes|envien|envies)\s*(mas|mensajes|nada)?\b|dejen\s+de\s+(escribirme|enviarme|mandarme|contactarme)|no\s+quiero\s+(recibir|que\s+me\s+(escriban|contacten|manden))\s*(mas\s+)?(mensajes|publicidad|promociones|nada)?)/;
  if (stop.test(t)) return 'no_contactar';
  return null;
}
