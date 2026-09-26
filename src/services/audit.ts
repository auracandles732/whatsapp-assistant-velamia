import { getConfig, setConfig } from './supabase';

/**
 * Registro de acciones sensibles sobre datos personales (exportar o borrar los datos de una clienta, borrados
 * automáticos, pedidos de la clienta sobre sus datos). Ayuda a demostrar el cumplimiento de la Ley Orgánica de
 * Protección de Datos Personales ante la Superintendencia. Se guarda por empresa y conserva las últimas 1000 acciones.
 */

export interface AuditEntry { at: string; action: string; detail: string; by: string }

const KEY = 'audit_log';
const MAX = 1000;
let chain: Promise<unknown> = Promise.resolve();

export async function listAudit(): Promise<AuditEntry[]> {
  try {
    const list = JSON.parse((await getConfig(KEY)) || '[]');
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

/** Anota una acción. Nunca lanza error: un registro fallido no debe frenar lo que se estaba haciendo. */
export function audit(action: string, detail: string, by = 'sistema'): Promise<void> {
  const next = chain.catch(() => {}).then(async () => {
    const list = await listAudit();
    list.push({ at: new Date().toISOString(), action, detail: detail.slice(0, 300), by });
    await setConfig(KEY, JSON.stringify(list.slice(-MAX)));
  });
  chain = next;
  return next.catch(error => console.error('⚠️ No se pudo anotar en el registro de seguridad:', error.message));
}
