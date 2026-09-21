/** Fechas de la mensualidad. Funciones puras, para poder probarlas. */

export function addMonths(from: Date, months: number): Date {
  const result = new Date(from.getTime());
  const day = result.getUTCDate();
  result.setUTCDate(1);
  result.setUTCMonth(result.getUTCMonth() + months);
  // 31 de enero + 1 mes = 28 (o 29) de febrero, no 3 de marzo.
  const lastDay = new Date(Date.UTC(result.getUTCFullYear(), result.getUTCMonth() + 1, 0)).getUTCDate();
  result.setUTCDate(Math.min(day, lastDay));
  return result;
}

/** Un pago suma meses a partir de hoy, o a partir del vencimiento si todavía estaba vigente (no se pierde lo ya pagado). */
export function nextPaidUntil(currentPaidUntil: Date | null, months: number, now = new Date()): Date {
  const start = currentPaidUntil && currentPaidUntil > now ? currentPaidUntil : now;
  return addMonths(start, months);
}

export type PaymentStatus = 'sin_pagos' | 'vigente' | 'por_vencer' | 'vencida';

/** Estado para mostrar en el panel: por vencer = faltan 5 días o menos. */
export function paymentStatus(paidUntil: Date | null, now = new Date()): PaymentStatus {
  if (!paidUntil) return 'sin_pagos';
  const days = (paidUntil.getTime() - now.getTime()) / 86_400_000;
  if (days < 0) return 'vencida';
  return days <= 5 ? 'por_vencer' : 'vigente';
}
