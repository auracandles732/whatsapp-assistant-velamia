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
