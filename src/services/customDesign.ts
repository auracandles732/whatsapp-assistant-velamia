/**
 * Avisos a la dueña por un diseño fuera del catálogo. Son dos y ninguno pausa al asistente:
 *  - temprano: apenas se detecta la idea, sin esperar la cantidad, para que alguien la revise a tiempo;
 *  - final: cuando el resumen ya trae la cantidad, "listo para cotizar".
 * Sin efectos, para poder probarla.
 */
export function customDesignAlerts(input: {
  /** La IA marcó que el cliente quiere algo fuera del catálogo. */
  requested: boolean;
  /** Resumen del diseño con lo que se sabe hasta ahora. */
  summary: string;
  /** El resumen ya trae la cantidad. */
  hasQuantity: boolean;
  /** Ya se avisó la idea en las últimas horas. */
  earlyRecentlySent: boolean;
  /** Este mismo diseño ya se avisó como listo para cotizar. */
  finalAlreadySent: boolean;
}): { early: boolean; final: boolean } {
  const known = input.requested || input.summary.trim().length > 0;
  return {
    early: known && !input.earlyRecentlySent,
    final: input.summary.trim().length > 0 && input.hasQuantity && !input.finalAlreadySent
  };
}

const DESIGN_REPLY = /fuera del cat[aá]logo|dise[ñn]o (personalizado|a tu gusto|especial)|foto de referencia|(preparo|preparamos|preparar) (la|una|tu) propuesta/i;
const REFERENCE_PHOTO = /referencia|similar|parecid|inspiraci/i;
const NOT_A_DESIGN = /comprobante|transferencia|dep[oó]sito|gu[ií]a|documento|factura|recibo|captura de pantalla/i;

/**
 * Respaldo por si la IA no marca custom_design_requested (pasó con chats que ella misma llamó "fuera del catálogo"):
 * cuenta como diseño si el asistente habla de diseño personalizado o pide foto de referencia, o si la clienta
 * mandó una foto de referencia que no terminó en un producto del catálogo.
 */
export function looksLikeCustomDesign(input: { reply: string; photoDescriptions: string[]; orderItems: number }): boolean {
  if (DESIGN_REPLY.test(input.reply)) return true;
  return input.orderItems === 0 && input.photoDescriptions.some(d => REFERENCE_PHOTO.test(d) && !NOT_A_DESIGN.test(d));
}
