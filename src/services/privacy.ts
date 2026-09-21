/** Número para los registros del servidor: solo los últimos 4 dígitos, para no guardar el teléfono completo de la clienta. */
export function maskPhone(phone: unknown): string {
  const digits = String(phone ?? '').replace(/\D/g, '');
  if (digits.length <= 4) return '••••';
  return '•'.repeat(digits.length - 4) + digits.slice(-4);
}
