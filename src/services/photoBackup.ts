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

const plain = (t: string) => String(t || '').normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase().replace(/[^a-zñ ]+/g, ' ').replace(/\s+/g, ' ').trim();
const GENERIC_FIRST = /^(hola|buenas|buenas tardes|buenas noches|buenos dias|buen dia|saludos)?( ?(quiero|quisiera|me gustaria|deseo|necesito))?( ?(conseguir|obtener|tener|recibir|saber|mas))*( ?(informacion|info))?( ?(sobre esto|por favor))*$/;

/** Primer mensaje que no dice qué busca: el texto automático del anuncio ("Quiero más información") o solo un saludo. */
export function isGenericFirstContact(text: string): boolean {
  const lines = String(text || '').split('\n').map(plain).filter(Boolean);
  return lines.length > 0 && lines.every(l => GENERIC_FIRST.test(l));
}

/**
 * Fotos para presentar el negocio en el primer mensaje: un modelo de cada categoría (primero las categorías con más
 * modelos), prefiriendo los que sirven para niño y niña, y repartiendo hasta completar `max`.
 */
export function introSelection(catalog: GenderedProduct[], max = 4): string[] {
  const groups = new Map<string, GenderedProduct[]>();
  for (const p of catalog) if (p.image_url) {
    const key = p.category || '';
    groups.set(key, [...(groups.get(key) || []), p]);
  }
  const ordered = [...groups.values()]
    .sort((a, b) => b.length - a.length)
    .map(list => [...list].sort((a, b) => Number(!!a.gender) - Number(!!b.gender)));
  const picked: string[] = [];
  for (let round = 0; picked.length < max && ordered.some(list => list.length > round); round++) {
    for (const list of ordered) if (list[round] && picked.length < max) picked.push(list[round].name);
  }
  return picked;
}

/** Qué preguntar después de las fotos: la ocasión (primer mensaje), la cantidad si aún no la dio, o cuál le gustó. */
export function afterPhotosQuestion(input: { intro: boolean; quantityKnown: boolean; photos: number }): 'event' | 'quantity' | 'liked' {
  if (input.intro) return 'event';
  if (!input.quantityKnown && input.photos > 1) return 'quantity';
  return 'liked';
}
