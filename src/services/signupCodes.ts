import { randomInt } from 'crypto';
import { getConfig, setConfig } from './supabase';

/**
 * Códigos de registro: una empresa solo puede crear su cuenta con un código válido, que se entrega después de pagar
 * su mensualidad. Cada código sirve una sola vez y vence. (Por ahora la administradora los crea a mano; cuando el
 * pago quede conectado, se crearán solos al aprobarse el cobro.)
 */
export interface SignupCode {
  code: string;
  expiresAt: string;
  usedAt?: string;
  usedBy?: string;
}

const CONFIG_KEY = 'signup_codes';
// Sin letras ni números que se confunden al dictarlos (0/O, 1/I).
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export function newCode(): string {
  const part = () => Array.from({ length: 4 }, () => ALPHABET[randomInt(ALPHABET.length)]).join('');
  return `NX-${part()}-${part()}`;
}

const normalize = (code: string) => String(code || '').toUpperCase().replace(/[^A-Z0-9]/g, '');

/** El código sirve si existe, no se usó y no venció. */
export function findUsable(list: SignupCode[], code: string, now = new Date()): SignupCode | null {
  const wanted = normalize(code);
  if (!wanted) return null;
  const found = list.find(c => normalize(c.code) === wanted);
  if (!found || found.usedAt || new Date(found.expiresAt) < now) return null;
  return found;
}

async function load(): Promise<SignupCode[]> {
  try {
    const parsed = JSON.parse((await getConfig(CONFIG_KEY)) || '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export async function createSignupCode(days = 30): Promise<SignupCode> {
  const list = await load();
  const entry: SignupCode = { code: newCode(), expiresAt: new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString() };
  // Se conservan solo los códigos recientes para que la lista no crezca sin fin.
  const keep = list.filter(c => new Date(c.expiresAt).getTime() > Date.now() - 90 * 24 * 60 * 60 * 1000);
  await setConfig(CONFIG_KEY, JSON.stringify([...keep, entry]));
  return entry;
}

export async function isSignupCodeUsable(code: string): Promise<boolean> {
  return !!findUsable(await load(), code);
}

/** Marca el código como usado por esa empresa. */
export async function useSignupCode(code: string, usedBy: string): Promise<void> {
  const list = await load();
  const found = findUsable(list, code);
  if (!found) return;
  found.usedAt = new Date().toISOString();
  found.usedBy = usedBy;
  await setConfig(CONFIG_KEY, JSON.stringify(list));
}
