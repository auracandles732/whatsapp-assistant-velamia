import { productKey } from './openai';

/**
 * Respaldo por si la IA escribe un modelo con su precio en vez de enviar la foto (sus reglas lo prohíben, pero pasa):
 * devuelve los productos nombrados con precio cuya foto la clienta todavía no vio. En resúmenes con total no aplica.
 */
export function productsNamedWithPrice(reply: string, catalog: { name: string; image_url?: string | null }[], alreadySent: string[]): string[] {
  if (!/\$\s?\d/.test(reply) || /total|anticipo/i.test(reply)) return [];
  const text = productKey(reply);
  const seen = new Set(alreadySent.map(productKey));
  const named = catalog.filter(p => p.image_url && text.includes(productKey(p.name)) && !seen.has(productKey(p.name)));
  // "OSITO EN NUBE" también aparece dentro de "OSITO EN NUBE CON CORAZON": se queda solo el nombre más largo.
  return named
    .filter(p => !named.some(o => o !== p && productKey(o.name).includes(productKey(p.name))))
    .slice(0, 4)
    .map(p => p.name);
}

type GenderedProduct = { name: string; category?: string | null; gender?: string | null; image_url?: string | null };

/**
 * Ordena las fotos: primero los modelos del sexo pedido y los neutros, después los del otro sexo, y agrega los del otro
 * sexo de la misma categoría que falten, porque se pueden personalizar en sus colores.
 * Con un solo modelo elegido no se agrega nada: la clienta pidió ese.
 */
export function withOppositeGender(selected: string[], catalog: GenderedProduct[], alreadySent: string[]): string[] {
  if (selected.length < 2) return selected;
  const chosen = selected.map(n => catalog.find(p => p.name === n)).filter((p): p is GenderedProduct => !!p);
  // El sexo pedido es el del primer modelo con género: la IA pone primero los de ese sexo.
  const wanted = chosen.find(p => p.gender === 'niño' || p.gender === 'niña')?.gender;
  if (!wanted) return selected;
  const other = wanted === 'niña' ? 'niño' : 'niña';
  const categories = new Set(chosen.map(p => p.category).filter(Boolean));
  const sent = new Set([...alreadySent, ...selected]);
  const extra = catalog
    .filter(p => p.gender === other && p.image_url && categories.has(p.category) && !sent.has(p.name))
    .map(p => p.name);
  const first = chosen.filter(p => p.gender !== other).map(p => p.name);
  const oppositeChosen = chosen.filter(p => p.gender === other).map(p => p.name);
  return [...first, ...oppositeChosen, ...extra];
}

/** Qué preguntar después de las fotos: la cantidad si aún no la dio (acerca a la cotización), o cuál le gustó. */
export function afterPhotosQuestion(input: { quantityKnown: boolean; photos: number }): 'quantity' | 'liked' {
  if (!input.quantityKnown && input.photos > 1) return 'quantity';
  return 'liked';
}

export const PHOTO_NUDGE_AFTER_MS = 40 * 60 * 1000;
// Pasado este rato ya no se escribe: evita mandarles a todos los chats viejos de golpe y lo de más tarde lo cubren los seguimientos diarios.
const PHOTO_NUDGE_UNTIL_MS = 3 * 60 * 60 * 1000;
// Fuera de las 24 h desde el último mensaje de la clienta, WhatsApp exige plantilla.
const WHATSAPP_WINDOW_MS = 23 * 60 * 60 * 1000;

/**
 * La clienta vio fotos y no respondió: después de su último mensaje el asistente mandó fotos, lo último del chat son
 * esas fotos (o la pregunta que el sistema hace tras ellas) y pasaron entre 40 minutos y 3 horas.
 */
export function needsPhotoNudge(messages: { sender: string; type: string; content: string | null; at: number }[], now: number, systemQuestions: string[]): boolean {
  const sorted = [...messages].sort((a, b) => a.at - b.at);
  const lastCustomer = sorted.map(m => m.sender).lastIndexOf('customer');
  if (lastCustomer < 0 || now - sorted[lastCustomer].at > WHATSAPP_WINDOW_MS) return false;
  const after = sorted.slice(lastCustomer + 1);
  if (!after.some(m => m.sender === 'bot' && m.type === 'image') || after.some(m => m.sender === 'human')) return false;
  const last = after[after.length - 1];
  const endsWithPhotos = last.sender === 'bot' && (last.type === 'image' || systemQuestions.includes(String(last.content || '')));
  const quiet = now - last.at;
  return endsWithPhotos && quiet >= PHOTO_NUDGE_AFTER_MS && quiet <= PHOTO_NUDGE_UNTIL_MS;
}

/**
 * Si la IA mete en la tanda un modelo de otra categoría que la clienta no pidió (una virgencita de bautizo entre los de
 * baby shower), se quita. Solo cuando casi todos son de una misma categoría: si pidió varias, se respetan.
 */
export function sameCategoryAsMost(selected: string[], catalog: GenderedProduct[], customerText: string): string[] {
  const chosen = selected.map(n => catalog.find(p => p.name === n)).filter((p): p is GenderedProduct => !!p);
  if (chosen.length < 3) return selected;
  const counts = new Map<string, number>();
  for (const p of chosen) if (p.category) counts.set(p.category, (counts.get(p.category) || 0) + 1);
  const [main, count] = [...counts.entries()].sort((a, b) => b[1] - a[1])[0] || ['', 0];
  if (!main || count * 2 <= chosen.length) return selected;
  const said = productKey(customerText);
  return selected.filter(name => {
    const p = catalog.find(x => x.name === name);
    return !p || !p.category || p.category === main || said.includes(productKey(p.category)) || said.includes(productKey(p.name));
  });
}
