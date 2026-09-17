import { AsyncLocalStorage } from 'async_hooks';
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'crypto';
import type { BusinessProfile } from '../config/businessProfile';

/**
 * Negocio que se está atendiendo en este momento (mensaje de WhatsApp, petición del CRM o seguimiento).
 * Sin contexto = VELAMIA, la instalación original: usa las variables de entorno y los datos sin business_id.
 * Con contexto, todo sale del negocio: sus claves de Meta y OpenAI, su perfil y solo sus datos.
 */
export interface TenantContext {
  businessId: string;
  name: string;
  profile: BusinessProfile;
  whatsappPhoneId: string;
  whatsappToken: string;
  wabaId: string;
  openaiApiKey: string;
}

const storage = new AsyncLocalStorage<TenantContext>();

export function currentTenant(): TenantContext | undefined {
  return storage.getStore();
}

export function runWithTenant<T>(tenant: TenantContext | undefined, fn: () => T): T {
  return tenant ? storage.run(tenant, fn) : storage.exit(fn);
}

// ---------- Cifrado de claves de cada negocio ----------
// Los tokens de Meta y las claves de OpenAI se guardan cifrados (AES-256-GCM): quien lea la base no las ve.

const PREFIX = 'enc:v1:';

function secretKey(): Buffer {
  const raw = process.env.BUSINESS_SECRETS_KEY || '';
  if (raw.length < 16) {
    throw new Error('Falta la variable BUSINESS_SECRETS_KEY (mínimo 16 caracteres) para guardar claves de negocios');
  }
  return createHash('sha256').update(raw).digest();
}

export function encryptSecret(plain: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', secretKey(), iv);
  const data = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return PREFIX + [iv, cipher.getAuthTag(), data].map(b => b.toString('base64url')).join('.');
}

export function decryptSecret(stored: string | null | undefined): string {
  if (!stored) return '';
  if (!stored.startsWith(PREFIX)) return stored;
  const [iv, tag, data] = stored.slice(PREFIX.length).split('.').map(p => Buffer.from(p, 'base64url'));
  const decipher = createDecipheriv('aes-256-gcm', secretKey(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
}

/** Para mostrar en el CRM sin revelar la clave: "••••a1b2". */
export function maskSecret(plain: string): string {
  return plain ? `••••${plain.slice(-4)}` : '';
}
