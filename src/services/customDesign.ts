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
