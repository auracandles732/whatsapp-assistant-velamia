import { getAllProducts } from '../services/supabase';
import { profile } from '../config/businessProfile';
import { currentBrain } from './brain';
import {
  SocialPost, PublishingSettings, DEFAULT_SETTINGS, getSavedSettings, publishingSlots, listPosts, localDay, localParts,
  recentProductNames, insertPosts, fallbackCaption, toPostProduct
} from './posts';

/**
 * Prepara y programa las publicaciones de los próximos días de publicación que todavía no tienen una (un día cuya
 * publicación se eliminó vuelve a quedar libre). Qué mostrar y qué decir lo decide el cerebro del agente; si la IA no
 * responde, cada publicación lleva un texto de respaldo.
 */
export async function planUpcomingPosts(now = new Date(), days = 7, settingsParam?: PublishingSettings): Promise<SocialPost[]> {
  const settings = settingsParam || (await getSavedSettings()) || DEFAULT_SETTINGS;
  const p = profile();
  const tz = p.business.timezone;
  const slots = publishingSlots(settings, now, days, tz);
  if (slots.length === 0) return [];

  const existing = await listPosts(new Date(slots[0].getTime() - 86_400_000).toISOString(), new Date(slots[slots.length - 1].getTime() + 86_400_000).toISOString());
  const taken = new Set(existing.map(post => localDay(post.scheduled_at, tz)));
  const free = slots.filter(slot => !taken.has(localDay(slot, tz)));
  if (free.length === 0) return [];

  const brain = currentBrain();
  const [catalog, recent] = await Promise.all([getAllProducts(), recentProductNames()]);
  const picks = (await brain.plan({ slots: free, catalog, recent, settings, month: localParts(now, tz).month, profile: p })).slice(0, free.length);
  if (picks.length === 0) return [];

  let captions: string[] = [];
  try {
    captions = await brain.write(picks.map(x => ({ theme: x.theme, products: x.products.map(c => ({ name: c.name, price: Number(c.price) })) })), settings.notes, p);
  } catch (error: any) {
    console.warn('⚠️ La IA no escribió los textos de las publicaciones; se usa el texto de respaldo:', error.message);
  }

  return insertPosts(picks.map((pick, i) => ({
    scheduled_at: free[i].toISOString(),
    status: 'approved',
    channels: settings.channels,
    caption: captions[i] || fallbackCaption(pick, p),
    products: pick.products.map(toPostProduct),
    theme: pick.theme,
    results: {},
    error: null
  })));
}

/** Otro texto para una publicación (botón "Otro texto" del CRM). */
export async function rewriteCaption(post: Pick<SocialPost, 'theme' | 'products'>, notes: string): Promise<string> {
  const [caption] = await currentBrain().write([{ theme: post.theme || 'Nuestros productos', products: post.products.map(x => ({ name: x.name, price: x.price })) }], notes, profile());
  if (!caption) throw new Error('La IA no devolvió un texto');
  return caption;
}
