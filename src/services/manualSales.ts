import { computeOrderTotal, productKey } from './openai';
import { BusinessProfile, profile, quantityText, formatDate } from '../config/businessProfile';

/**
 * Cotizaciones y pedidos armados a mano desde el CRM: los mismos precios, cambios de empaque y tarifario de envíos
 * que usa el asistente, guardados con el mismo formato (productos + línea de envío + fecha de entrega).
 */

export interface SaleInput { items?: unknown; place?: unknown; deliveryDate?: unknown }

const round2 = (n: number) => Math.round(n * 100) / 100;

export function buildSale(input: SaleInput, catalog: any[], p: BusinessProfile = profile()) {
  const raw = (Array.isArray(input.items) ? input.items : []).slice(0, 30).map((i: any) => ({
    name: String(i?.name ?? ''),
    quantity: Number(i?.quantity),
    quantity_in_pieces: false,
    personalization: String(i?.personalization ?? '').trim().slice(0, 300),
    packaging: String(i?.packaging ?? '')
  }));
  const place = p.shipping.mode === 'none' ? '' : String(input.place ?? '').trim().slice(0, 120);
  const r = computeOrderTotal(raw, place, catalog, p);
  if (r.items.length === 0) throw new Error('Elige al menos un producto del catálogo con su cantidad');
  if (place && !r.shipping) throw new Error(`"${place}" no está en el tarifario: escribe la ciudad y la provincia (ej. "Quito, Pichincha")`);

  const s: any = r.shipping;
  const shipping = s ? { place: [s.place, s.province].filter((v: string, i: number, all: string[]) => v && all.indexOf(v) === i).join(', '), cost: Number(s.cost) } : null;
  const delivery = /^\d{4}-\d{2}-\d{2}$/.test(String(input.deliveryDate ?? '')) ? String(input.deliveryDate) : '';
  const total = round2(r.subtotal + (shipping?.cost || 0));
  const products: any[] = [
    ...r.items,
    ...(shipping ? [{ type: 'shipping', name: `Envío a ${shipping.place}`, price: shipping.cost, quantity: 1 }] : []),
    ...(delivery ? [{ type: 'delivery', name: 'Entrega', date: delivery }] : [])
  ];
  return { products, total, place: shipping?.place || '', delivery, packagingPending: r.packagingUndefined };
}

/** Lo que recibe la clienta al enviarle la cotización: un solo valor, sin precio por producto (como lo hace el asistente). */
export function quotationMessage(products: any[], total: number, p: BusinessProfile = profile()): string {
  const items = products.filter(i => i && !i.type);
  const shipping = products.find(i => i?.type === 'shipping');
  const delivery = products.find(i => i?.type === 'delivery');
  const lines = [`🧾 *Cotización ${p.business.name}*`, ''];
  for (const i of items) {
    lines.push(`${p.business.productEmoji} *${i.name}* · ${quantityText(Number(i.quantity), p)}${i.personalization ? ` (${i.personalization})` : ''}${i.packagingChanged && i.packaging ? ` · empaque ${i.packaging}` : ''}`);
  }
  if (shipping) {
    const place = String(shipping.name || '').replace(/^Envío a\s*/i, '');
    lines.push(p.shipping.showSeparately ? `🚚 Envío a ${place}: $${Number(shipping.price).toFixed(2)}` : `🚚 Envío a ${place} incluido`);
  }
  if (delivery?.date) lines.push(`📅 *Entrega:* ${formatDate(delivery.date)}`);
  lines.push(`💰 *Total: $${Number(total).toFixed(2)}*`);
  const pay = p.payments;
  if (pay.transferEnabled && pay.depositPercent < 100) {
    lines.push(`🏦 Anticipo por transferencia (${pay.depositPercent}%): $${round2(total * pay.depositPercent / 100).toFixed(2)}`);
  }
  lines.push('', pay.transferEnabled && pay.cardEnabled ? '¿Prefieres pagar por transferencia o con tarjeta?' : '¿Confirmamos tu pedido?');
  return lines.join('\n');
}

/** WhatsApp permite hasta 1024 caracteres debajo de una foto. */
export const PHOTO_CAPTION_LIMIT = 1024;

export interface QuotationDelivery {
  photos: { url: string; caption: string }[];
  /** Texto que va después de las fotos (null si la cotización completa ya va debajo de la única foto). */
  text: string | null;
  /** La cotización completa, por si las fotos no se pueden enviar. */
  fullText: string;
}

/**
 * La cotización va con las fotos de los productos: con un solo producto, su foto con toda la cotización debajo (un solo
 * mensaje); con varios, cada foto con su nombre y cantidad y al final el texto con el total y la forma de pago.
 */
export function quotationDelivery(products: any[], total: number, catalog: any[], p: BusinessProfile = profile()): QuotationDelivery {
  const fullText = quotationMessage(products, total, p);
  const items = products.filter(i => i && !i.type);
  const photos = items
    .map(item => ({ item, url: String(catalog.find(c => productKey(c.name) === productKey(item.name))?.image_url || '') }))
    .filter(x => x.url)
    .slice(0, 6);
  if (photos.length === 1 && items.length === 1 && fullText.length <= PHOTO_CAPTION_LIMIT) {
    return { photos: [{ url: photos[0].url, caption: fullText }], text: null, fullText };
  }
  return {
    photos: photos.map(x => ({ url: x.url, caption: `${p.business.productEmoji} *${x.item.name}* · ${quantityText(Number(x.item.quantity), p)}` })),
    text: fullText,
    fullText
  };
}
