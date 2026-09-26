import { getAllConversations, getOrderRefs, deleteConversationCompletely, getActiveTenants, parseDbTimestamp } from './supabase';
import { removeFilesByPublicUrls } from './storage';
import { runWithTenant } from './tenant';
import { profile } from '../config/businessProfile';
import { audit } from './audit';

/**
 * Plazo de conservación (principio de conservación de la Ley Orgánica de Protección de Datos Personales): si la empresa
 * lo elige en Configuración → Privacidad, los chats sin pedidos que llevan ese tiempo sin mensajes se borran solos, con
 * sus fotos y audios. Los chats con pedidos no se tocan (hacen falta para la facturación). Apagado por defecto.
 */

const MAX_PER_RUN = 200;
const CHECK_EVERY_MS = 6 * 60 * 60 * 1000;

/** Los chats que ya cumplieron el plazo y no tienen pedidos. Sin efectos, para probarla. */
export function expiredConversations(
  conversations: { id: string; last_message_time?: string | null; created_at?: string | null }[],
  withOrders: Set<string>, months: number, now = new Date()
): string[] {
  if (!(months > 0)) return [];
  const limit = new Date(now);
  limit.setUTCMonth(limit.getUTCMonth() - months);
  return conversations
    .filter(c => !withOrders.has(c.id))
    .filter(c => { const last = c.last_message_time || c.created_at; return !!last && parseDbTimestamp(last) < limit; })
    .map(c => c.id);
}

async function purgeCurrent(now: Date): Promise<number> {
  const months = profile().privacy.retentionMonths;
  if (!(months > 0)) return 0;
  const [conversations, orders] = await Promise.all([getAllConversations(), getOrderRefs()]);
  const ids = expiredConversations(conversations, new Set(orders.map(o => o.conversation_id)), months, now).slice(0, MAX_PER_RUN);
  let deleted = 0;
  for (const id of ids) {
    try {
      const { mediaUrls } = await deleteConversationCompletely(id);
      await removeFilesByPublicUrls(mediaUrls).catch(() => 0);
      deleted++;
    } catch (error: any) {
      console.error('❌ Borrado por plazo de conservación:', error.message);
    }
  }
  if (deleted) {
    console.log(`🗑️ Plazo de conservación: ${deleted} chat(s) sin pedidos y sin mensajes hace más de ${months} meses se borraron`);
    await audit('borrado_por_plazo', `${deleted} chat(s) sin pedidos, sin mensajes hace más de ${months} meses`);
  }
  return deleted;
}

let running = false;

export async function runRetention(now = new Date()) {
  if (running) return;
  running = true;
  try {
    await runWithTenant(undefined, () => purgeCurrent(now)).catch(error => console.error('❌ Conservación de VELAMIA:', error.message));
    for (const tenant of await getActiveTenants().catch(() => [])) {
      await runWithTenant(tenant, () => purgeCurrent(now)).catch(error => console.error(`❌ Conservación de ${tenant.name}:`, error.message));
    }
  } finally {
    running = false;
  }
}

export function startRetention() {
  setTimeout(() => { void runRetention(); }, 10 * 60 * 1000);
  setInterval(() => { void runRetention(); }, CHECK_EVERY_MS);
}
