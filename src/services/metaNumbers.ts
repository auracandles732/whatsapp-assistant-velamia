/**
 * Alta de números de WhatsApp de las empresas en la cuenta de Meta de Nexly: la empresa solo escribe su número y el
 * código que le llega; el resto (agregar el número, verificarlo y registrarlo en la API) lo hace la plataforma.
 */

const GRAPH = 'https://graph.facebook.com/v25.0';

/** Separa un número escrito a mano en código de país y número nacional. Sin código de país se asume Ecuador (593). */
export function splitPhone(input: string): { cc: string; national: string } | null {
  const raw = String(input || '').trim();
  const digits = raw.replace(/\D/g, '');
  if (digits.length < 8) return null;
  if (raw.startsWith('+') || raw.startsWith('00')) {
    const full = raw.startsWith('00') ? digits.slice(2) : digits;
    if (full.startsWith('593')) return full.length >= 11 ? { cc: '593', national: full.slice(3) } : null;
    // Otros países: 1 dígito (1, 7), 3 dígitos en Centroamérica y el Cono Sur (50x, 59x) y 2 en el resto (51-58, 34, 44...).
    const ccLength = /^[17]/.test(full) ? 1 : /^5[09]/.test(full) ? 3 : 2;
    return { cc: full.slice(0, ccLength), national: full.slice(ccLength) };
  }
  if (digits.startsWith('593') && digits.length >= 11) return { cc: '593', national: digits.slice(3) };
  if (digits.startsWith('0') && digits.length === 10) return { cc: '593', national: digits.slice(1) };
  if (digits.length === 9) return { cc: '593', national: digits };
  return null;
}

export function platformMeta(): { wabaId: string; token: string } | null {
  const wabaId = (process.env.NEXLY_WABA_ID || '').trim();
  const token = (process.env.NEXLY_META_TOKEN || '').replace(/\s+/g, '');
  return wabaId && token ? { wabaId, token } : null;
}

async function graph(path: string, token: string, body?: Record<string, unknown>): Promise<any> {
  const response = await fetch(`${GRAPH}/${path}`, {
    method: body ? 'POST' : 'GET',
    headers: { Authorization: `Bearer ${token}`, ...(body && { 'Content-Type': 'application/json' }) },
    ...(body && { body: JSON.stringify(body) })
  });
  const data: any = await response.json().catch(() => ({}));
  if (!response.ok || data?.error) {
    const detail = data?.error?.error_user_msg || data?.error?.message || `Meta respondió ${response.status}`;
    throw new Error(detail);
  }
  return data;
}

/** Agrega el número a la cuenta de Nexly y pide a Meta que envíe el código por SMS o llamada. */
export async function addNumberAndRequestCode(meta: { wabaId: string; token: string }, phone: { cc: string; national: string }, displayName: string, method: 'SMS' | 'VOICE') {
  const created = await graph(`${meta.wabaId}/phone_numbers`, meta.token, { cc: phone.cc, phone_number: phone.national, verified_name: displayName });
  const phoneNumberId = String(created.id);
  await graph(`${phoneNumberId}/request_code`, meta.token, { code_method: method, language: 'es' });
  return { phoneNumberId };
}

/** Verifica el código y deja el número registrado en la API de WhatsApp. */
export async function verifyAndRegister(meta: { token: string }, phoneNumberId: string, code: string) {
  await graph(`${phoneNumberId}/verify_code`, meta.token, { code: code.replace(/\D/g, '') });
  // El PIN de dos pasos no lo usa la empresa: se define uno de 6 dígitos solo para registrar el número.
  const pin = String(Math.floor(100000 + Math.random() * 900000));
  await graph(`${phoneNumberId}/register`, meta.token, { messaging_product: 'whatsapp', pin });
}
