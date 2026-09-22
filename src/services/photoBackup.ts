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
