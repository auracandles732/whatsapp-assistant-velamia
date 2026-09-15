import { OpenAI, toFile } from 'openai';
import { shippingCost, shippingRatesSummary, DOZENS_INCLUDED_IN_BASE_RATE, EXTRA_SHIPPING_COST } from './shippingRates';

// Sin timeout propio el SDK espera hasta 10 minutos: la clienta quedaría sin respuesta ese tiempo.
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
  timeout: 60_000,
  maxRetries: 2
});

const MODEL = 'gpt-5.4-mini';

// GPT-5.4 es un modelo de razonamiento: los tokens de razonamiento cuentan dentro de
// max_completion_tokens, por eso los límites llevan margen y el esfuerzo va en "low"
// para responder rápido por WhatsApp.
const REASONING_EFFORT = 'low' as const;

// Máximo de fotos por respuesta: cubre una categoría completa sin saturar el chat.
export const MAX_PHOTOS_PER_TURN = 15;

export async function transcribeAudio(buffer: Buffer, mimeType: string): Promise<string> {
  try {
    const ext = mimeType.split('/')[1]?.split(';')[0] || 'ogg';
    const file = await toFile(buffer, `audio.${ext}`, { type: mimeType });
    const transcription = await openai.audio.transcriptions.create({
      file,
      model: 'whisper-1',
      language: 'es'
    });
    return transcription.text;
  } catch (error: any) {
    console.error('Error transcribiendo audio:', error.message);
    return '[No se pudo transcribir el audio]';
  }
}

export async function describeImage(imageUrl: string): Promise<string> {
  try {
    const response = await openai.chat.completions.create({
      model: MODEL,
      reasoning_effort: REASONING_EFFORT,
      max_completion_tokens: 600,
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: 'Describe brevemente en español qué se ve en esta imagen, en el contexto de una tienda de velas para eventos (por ejemplo si parece una foto de referencia de un evento, un modelo de vela, una decoración, un comprobante de pago, etc). Máximo 2 líneas.' },
          { type: 'image_url', image_url: { url: imageUrl } }
        ]
      }]
    });
    return response.choices[0]?.message?.content || '';
  } catch (error: any) {
    console.error('Error describiendo imagen:', error.message);
    return '[No se pudo analizar la imagen]';
  }
}

const DEFAULT_PERSONA = `Eres parte del equipo de ventas de VELAMIA, una marca de velas y recuerdos para eventos en Guayaquil, Ecuador.
Atiende con amabilidad, responde en español natural y guía al cliente hacia una cotización o compra.`;

// Reglas que se aplican siempre, también cuando existe un prompt personalizado desde el CRM:
// sin ellas el bot podría inventar productos, enviar fotos que no vienen al caso o no ceder el chat.
const CORE_RULES = `REGLAS DEL SISTEMA (obligatorias):
- Todos los precios del catálogo son POR DOCENA (12 unidades). Acláralo siempre que menciones un precio.
- Solo ofrece productos que estén en el catálogo de abajo, con su nombre y precio exactos. Nunca inventes productos, precios, colores ni modelos.
- Si el cliente pregunta cuántos modelos hay de un evento, considera TODOS los productos de esa categoría del catálogo; no digas que no hay más si existen.
- Estás escribiendo por WhatsApp: mensajes cortos, sin tablas ni formato markdown. Para resaltar usa *asteriscos*.
- Eres una persona del equipo de VELAMIA. Nunca digas ni insinúes que eres un bot, asistente virtual o IA, ni que "otra persona", "un asesor" o "el equipo" tomará la conversación.

PERSONALIZACIÓN Y CIERRE DE VENTA:
- Todos los modelos se pueden personalizar: cambios de colores, nombres, frases y detalles son válidos. Confírmalo con seguridad, sin decir que hay que verificarlo.
- La personalización no cambia el precio por docena del catálogo ni impide la venta.
- Anota los detalles de personalización junto con el modelo, la cantidad y la fecha, y sigue avanzando hasta cerrar la venta (confirmación del pedido y forma de pago).

FORMAS DE PAGO (estas reglas mandan sobre cualquier otra instrucción de pago):
- Transferencia bancaria: se paga un ANTICIPO del 50% del valor total (velas + envío) para iniciar y el saldo antes de la entrega. Indica siempre el valor total y el monto exacto del anticipo (ejemplo: "Total $127.00 · Anticipo 50%: $63.50").
- Tarjeta de crédito: se paga el 100% del valor total (velas + envío). Indica siempre el monto total a pagar. Solo se aceptan tarjetas Visa y Mastercard: dilo siempre que hables de pagar con tarjeta.
- Si el cliente pregunta cómo pagar, explica ambas opciones con sus montos si ya conoces el valor total; si falta la ciudad de envío, explica las opciones sin montos y pregunta la ciudad.
- Nunca escribas números de cuenta, bancos ni titulares: el sistema los envía en un mensaje aparte (campo send_bank_details).

ENVÍOS Y VALOR TOTAL (estas reglas mandan sobre cualquier otra instrucción de precios):
- Enviamos a todo Ecuador desde Guayaquil por Servientrega. No hay retiro en local: si el cliente pide retirar, explícale con amabilidad que todos los pedidos se entregan por envío.
- No hay pedido mínimo: se puede pedir cualquier cantidad (el precio del catálogo sigue siendo por docena).
- Para dar un valor total (cotización, total, anticipo o monto con tarjeta) necesitas saber qué modelos, cuántas docenas y la ciudad de envío. Si falta la ciudad, pregúntala antes de dar cualquier total.
- El valor total es UN SOLO VALOR que ya incluye las velas y el envío. Nunca lo desgloses: no digas el costo del envío por separado, ni el subtotal de las velas, ni "más envío". En el mensaje donde das el valor total no menciones ningún otro monto (ni el precio por docena), salvo el anticipo cuando corresponda. Nunca menciones peso, kilos ni cargos adicionales.
- Cálculo interno: suma de (precio por docena × docenas) + tarifa de envío de la ciudad (TARIFAS DE ENVÍO de abajo). Si el pedido suma más de ${DOZENS_INCLUDED_IN_BASE_RATE} docenas, la tarifa de envío sube $${EXTRA_SHIPPING_COST.toFixed(2)}.
- Si preguntan cuánto cuesta el envío, responde que el valor total que le das ya incluye el envío a su ciudad (y dáselo si ya conoces modelos, cantidad y ciudad).
- Si la ciudad no aparece en el tarifario o existe en varias provincias, pregunta la ciudad y la provincia.
- order_items: modelos del catálogo (nombre exacto) y docenas del pedido actual según toda la conversación; lista vacía si no están claros.
- shipping_place: ciudad o cantón de envío que indicó el cliente, en formato "Ciudad, Provincia" (ejemplo: "Quito, Pichincha"); si no conoces la provincia escribe solo la ciudad; cadena vacía si no la ha dicho.
- quoted_total: el valor total que mencionas en reply, como número; 0 si no mencionas ninguno.
- quoted_deposit: el anticipo que mencionas en reply, como número; 0 si no mencionas ninguno.

FECHAS DE ENTREGA (estas reglas mandan sobre cualquier otra instrucción de disponibilidad):
- Siempre hay disponibilidad: nunca digas que una fecha no está disponible ni que debes verificar la disponibilidad.
- Fecha de entrega = fecha del evento MENOS 3 días; ese día el pedido le llega al cliente. Ejemplo: evento 21/09/2026 → entrega 18/09/2026.
- Cuando conozcas la fecha del evento, menciona la fecha de entrega en formato día/mes/año.
- Para impulsar la venta, cada vez que menciones la fecha de entrega agrega en esa misma respuesta que la fecha queda reservada al recibir el pago y que las fechas se van ocupando por orden de pago (aunque todavía falten datos como la ciudad). Si paga por transferencia o aún no eligió forma de pago, di "al recibir el anticipo"; si paga con tarjeta, di "al recibir el pago" (con tarjeta no hay anticipo). Nunca digas que quedan pocos cupos.
- event_date: fecha del evento en formato AAAA-MM-DD si el cliente la indicó en la conversación; si no, cadena vacía. Si no dice el año, usa la próxima vez que llegue esa fecha a partir de hoy.
- delivery_date: la fecha de entrega que mencionas en reply, en formato AAAA-MM-DD; cadena vacía si no mencionas ninguna.

PREGUNTAS SIN RESPUESTA (campo owner_question):
- Si el cliente pregunta algo que no está en tus instrucciones, en el catálogo ni en el tarifario de envíos, dile que lo verificas y le confirmas pronto, y escribe en owner_question la pregunta resumida en una línea. Sigue atendiendo lo demás con normalidad.
- En cualquier otro caso owner_question es una cadena vacía.

DATOS BANCARIOS (campo send_bank_details):
- true SOLO cuando el cliente elige pagar por transferencia o pide los datos de la cuenta. En cualquier otro caso false.
- Si es true, en reply confirma el total y el anticipo del 50% y dile que a continuación le compartes los datos de la cuenta.

FOTOS (campo show_products):
- Incluye productos SOLO cuando el cliente pide ver modelos, fotos u opciones, o pide "más modelos".
- Incluye TODOS los productos del catálogo que correspondan a lo que pidió (por ejemplo, todos los de la categoría o todos los que coinciden con el modelo), usando los nombres exactos.
- No repitas fotos ya enviadas en esta conversación, salvo que el cliente pida volver a ver un modelo concreto.
- Déjalo vacío cuando el cliente está dando detalles de su pedido (cantidad, fecha, colores, nombres, personalización), confirmando, preguntando precios o formas de pago, o conversando. En esos casos una foto no aporta y confunde.
- Si envías fotos, en reply preséntalas en una frase corta; no repitas la lista completa de nombres y precios porque cada foto ya lleva su nombre y precio.
- Cuando el mensaje indica que el cliente responde a una foto concreta, ese es el modelo del que habla.

CASOS QUE REQUIEREN REVISIÓN MANUAL (campo handoff; el cliente nunca debe notar ningún cambio de persona):
- card_payment: el cliente ELIGE explícitamente pagar con tarjeta ("pago con tarjeta", "prefiero tarjeta"). Preguntar cómo pagar o qué formas de pago hay NO es card_payment. Reply: recuérdale el monto total a pagar (100% del valor total con envío), indícale que solo aceptamos tarjetas Visa y Mastercard y dile que en un momento le envías el link de pago. Usa emojis en esta respuesta (por ejemplo 💳 ✨ 🤍). No hagas preguntas.
- payment_proof: el cliente envía o dice que envió un comprobante, transferencia o depósito. Reply: agradece, dile que lo verificas y, si falta algún detalle del pedido (fecha, nombres, colores, entrega), sigue atendiéndolo con normalidad.
- complaint: queja o problema con un pedido ya entregado o en curso (llegó roto, atraso, error). Reply: lamenta lo ocurrido y dile que lo revisas y le escribes en unos minutos. No hagas preguntas.
- none: cualquier otro caso, incluidas todas las personalizaciones.
- Reply siempre en primera persona.

INTENCIÓN (campo intent):
- quotation: SOLO cuando el cliente pide explícitamente una cotización o el valor total de su pedido ("me cotizas", "cuánto sería en total", "cuánto me sale todo", "pásame la cotización"). Dar cantidad, fecha o colores, o preguntar el precio de un modelo, NO es quotation aunque tú menciones un total.
- order: el cliente CONFIRMA explícitamente la compra con modelo y cantidad ya definidos ("confirmo", "sí, hagamos el pedido", "lo quiero reservar"). Decir que un modelo le gusta, dar colores o preguntar precios NO es order.
- delivery_status: pregunta por el estado de un pedido ya hecho.
- product_inquiry, greeting u other en los demás casos.`;

interface Message {
  role: 'user' | 'assistant';
  content: string;
}

interface CatalogProduct {
  name: string;
  price: number;
  category: string;
}

export type HandoffReason = 'none' | 'card_payment' | 'payment_proof' | 'complaint';

export interface TurnPlan {
  reply: string;
  intent: 'greeting' | 'product_inquiry' | 'quotation' | 'order' | 'delivery_status' | 'other';
  show_products: string[];
  handoff: HandoffReason;
  send_bank_details: boolean;
  owner_question: string;
  /** Fecha del evento (AAAA-MM-DD) o cadena vacía. */
  event_date: string;
  /** Fecha de entrega calculada por el sistema (evento − 3 días) o cadena vacía. */
  delivery_date: string;
  /** Modelos reales del catálogo con sus docenas, según la conversación. */
  order_items: { name: string; price: number; dozens: number }[];
  shipping_place: string;
  /** Valor total calculado por el sistema (velas + envío) o 0 si falta información. */
  order_total: number;
  /** Anticipo del 50% del valor total o 0. */
  deposit: number;
}

const TURN_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['reply', 'intent', 'show_products', 'handoff', 'send_bank_details', 'owner_question', 'event_date', 'delivery_date', 'order_items', 'shipping_place', 'quoted_total', 'quoted_deposit'],
  properties: {
    reply: { type: 'string' },
    intent: { type: 'string', enum: ['greeting', 'product_inquiry', 'quotation', 'order', 'delivery_status', 'other'] },
    show_products: { type: 'array', items: { type: 'string' } },
    handoff: { type: 'string', enum: ['none', 'card_payment', 'payment_proof', 'complaint'] },
    send_bank_details: { type: 'boolean' },
    owner_question: { type: 'string' },
    event_date: { type: 'string' },
    delivery_date: { type: 'string' },
    order_items: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['name', 'dozens'],
        properties: { name: { type: 'string' }, dozens: { type: 'number' } }
      }
    },
    shipping_place: { type: 'string' },
    quoted_total: { type: 'number' },
    quoted_deposit: { type: 'number' }
  }
};

const round2 = (value: number) => Math.round(value * 100) / 100;

/**
 * Calcula el valor total con envío a partir de lo que la IA entendió de la conversación.
 * Los precios salen del catálogo y la tarifa del tarifario: la IA no hace las cuentas.
 */
export function computeOrderTotal(rawItems: any, rawPlace: any, catalog: CatalogProduct[]) {
  const byName = new Map(catalog.map(p => [p.name.trim().toLowerCase(), p]));
  const items = (Array.isArray(rawItems) ? rawItems : [])
    .map((i: any) => ({ product: byName.get(String(i?.name || '').trim().toLowerCase()), dozens: Number(i?.dozens) }))
    .filter((i: any) => i.product && Number.isFinite(i.dozens) && i.dozens > 0)
    .map((i: any) => ({ name: i.product.name, price: Number(i.product.price), dozens: i.dozens }));

  const place = String(rawPlace || '').trim();
  const dozens = items.reduce((sum: number, i: any) => sum + i.dozens, 0);
  const shipping = place ? shippingCost(place, dozens) : null;

  let missing: '' | 'items' | 'place' | 'unknown_place' = '';
  if (items.length === 0) missing = 'items';
  else if (!place) missing = 'place';
  else if (!shipping) missing = 'unknown_place';

  const total = missing ? 0 : round2(items.reduce((sum: number, i: any) => sum + i.price * i.dozens, 0) + shipping!.cost);
  return { items, place, shipping, missing, total, deposit: round2(total / 2) };
}

// Días antes del evento en que el pedido le llega a la clienta.
export const DELIVERY_DAYS_BEFORE_EVENT = 3;

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Resta días a una fecha AAAA-MM-DD sin depender de la zona horaria del servidor. */
export function subtractDays(isoDate: string, days: number): string {
  const [y, m, d] = isoDate.split('-').map(Number);
  const date = new Date(Date.UTC(y, m - 1, d - days));
  return date.toISOString().slice(0, 10);
}

export function formatDateEc(isoDate: string): string {
  const [y, m, d] = isoDate.split('-');
  return `${d}/${m}/${y}`;
}

export function todayInGuayaquil(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Guayaquil' }).format(new Date());
}

function isValidIsoDate(value: string): boolean {
  if (!ISO_DATE.test(value)) return false;
  const [y, m, d] = value.split('-').map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
}

function buildSystemPrompt(
  catalog: CatalogProduct[],
  customPrompt: string | undefined,
  sentProducts: string[],
  bankDetailsSent: boolean
) {
  const persona = customPrompt && customPrompt.trim() ? customPrompt.trim() : DEFAULT_PERSONA;

  let catalogText = 'CATÁLOGO: todavía no hay productos cargados. Si el cliente pregunta por productos, indícale que en breve le compartes las opciones.';
  if (catalog.length > 0) {
    const byCategory: { [key: string]: CatalogProduct[] } = {};
    for (const p of catalog) {
      if (!byCategory[p.category]) byCategory[p.category] = [];
      byCategory[p.category].push(p);
    }
    catalogText = 'CATÁLOGO ACTUAL DE VELAMIA (precios por docena):\n\n' + Object.entries(byCategory)
      .map(([cat, items]) => `${cat} (${items.length} modelos):\n` + items.map(i => `  - ${i.name}: $${i.price} por docena`).join('\n'))
      .join('\n\n');
  }

  const sentText = sentProducts.length > 0
    ? `FOTOS YA ENVIADAS EN ESTA CONVERSACIÓN: ${sentProducts.join(', ')}`
    : 'FOTOS YA ENVIADAS EN ESTA CONVERSACIÓN: ninguna';

  // Sin la fecha la IA no puede saber si "el 18" ya pasó ni qué año corresponde.
  const today = new Date().toLocaleDateString('es-EC', {
    timeZone: 'America/Guayaquil', weekday: 'long', day: 'numeric', month: 'long', year: 'numeric'
  });

  const bankText = bankDetailsSent
    ? 'DATOS BANCARIOS: ya se enviaron en esta conversación; vuelve a marcar send_bank_details solo si el cliente los pide de nuevo.'
    : 'DATOS BANCARIOS: aún no se han enviado en esta conversación.';

  const shippingText = `TARIFAS DE ENVÍO DESDE GUAYAQUIL (uso interno, todos los cantones de la provincia cuestan igual):\n${shippingRatesSummary()}`;

  return `${persona}\n\n${CORE_RULES}\n\nFECHA DE HOY (Guayaquil): ${today}\n\n${shippingText}\n\n${catalogText}\n\n${sentText}\n${bankText}`;
}

/**
 * Decide en una sola llamada qué responder, qué fotos enviar y si el chat pasa a una persona.
 * Hacerlo junto evita que la respuesta diga una cosa y las fotos muestren otra.
 */
export async function planTurn(params: {
  history: Message[];
  userMessage: string;
  catalog: CatalogProduct[];
  customPrompt?: string;
  sentProducts: string[];
  bankDetailsSent?: boolean;
}): Promise<TurnPlan> {
  const { history, userMessage, catalog, customPrompt, sentProducts, bankDetailsSent = false } = params;

  const baseMessages = [
    { role: 'system' as const, content: buildSystemPrompt(catalog, customPrompt, sentProducts, bankDetailsSent) },
    ...history,
    { role: 'user' as const, content: userMessage }
  ];

  const ask = async (extraSystem?: string) => {
    const response = await openai.chat.completions.create({
      model: MODEL,
      reasoning_effort: REASONING_EFFORT,
      max_completion_tokens: 3000,
      response_format: {
        type: 'json_schema',
        json_schema: { name: 'turno_whatsapp', strict: true, schema: TURN_SCHEMA }
      },
      messages: extraSystem ? [...baseMessages, { role: 'system' as const, content: extraSystem }] : baseMessages
    });
    return JSON.parse(response.choices[0]?.message?.content || '{}');
  };

  let parsed = await ask();

  // Fechas y montos los calcula el sistema. Si la IA escribió otros, se rehace la respuesta
  // una sola vez con todas las correcciones juntas.
  const corrections: string[] = [];

  const eventDate = isValidIsoDate(String(parsed.event_date || '')) ? parsed.event_date : '';
  const expectedDelivery = eventDate ? subtractDays(eventDate, DELIVERY_DAYS_BEFORE_EVENT) : '';
  const mentioned = String(parsed.delivery_date || '');
  if (expectedDelivery && mentioned && expectedDelivery <= todayInGuayaquil()) {
    // Evento muy cercano: siempre se atiende, pero decirle una fecha de entrega ya pasada no tiene sentido.
    console.warn(`📅 Entrega calculada ${expectedDelivery} es hoy o ya pasó: se pide no mencionarla`);
    corrections.push(
      `El evento es el ${formatDateEc(eventDate)} y la entrega calculada (${DELIVERY_DAYS_BEFORE_EVENT} días antes) ya pasó o es hoy. ` +
      'No menciones ninguna fecha de entrega. Confirma con seguridad que sí atendemos su pedido para su evento y dile que en un momento le confirmas el día exacto de entrega.'
    );
  } else if (expectedDelivery && mentioned && mentioned !== expectedDelivery) {
    console.warn(`📅 Fecha de entrega corregida: la IA dijo ${mentioned}, corresponde ${expectedDelivery}`);
    corrections.push(
      `El evento es el ${formatDateEc(eventDate)} y la fecha de entrega correcta es el ${formatDateEc(expectedDelivery)} ` +
      `(${DELIVERY_DAYS_BEFORE_EVENT} días antes). Usa exactamente esa fecha de entrega y di que la fecha se reserva al recibir el anticipo.`
    );
  } else if (expectedDelivery && mentioned && !(parsed.handoff === 'card_payment'
    ? /recibir el pago|confirmar el pago/i
    : /anticipo/i).test(String(parsed.reply || ''))) {
    // La fecha es correcta, pero sin la reserva por pago se pierde la urgencia que pidió la dueña.
    corrections.push(parsed.handoff === 'card_payment'
      ? 'Mantén la misma fecha de entrega y agrega que la fecha queda reservada al recibir el pago, ya que las fechas se van ocupando por orden de pago. No menciones anticipo: con tarjeta se paga el total.'
      : 'Mantén la misma fecha de entrega y agrega que la fecha queda reservada al recibir el anticipo, ya que las fechas se van ocupando por orden de pago.');
  }

  // Con tarjeta se paga el 100%: hablar de anticipo confunde a la clienta.
  if (parsed.handoff === 'card_payment' && /anticipo/i.test(String(parsed.reply || ''))) {
    corrections.push('La clienta paga con tarjeta: se cancela el 100% del valor total. No menciones la palabra anticipo; si hablas de la reserva de la fecha di "al recibir el pago".');
  }

  const quotedTotal = Number(parsed.quoted_total) || 0;
  const quotedDeposit = Number(parsed.quoted_deposit) || 0;
  const firstOrder = computeOrderTotal(parsed.order_items, parsed.shipping_place, catalog);
  // Montos que aparecen escritos en la respuesta ("$30", "$127.00", "$63,50").
  const amountsInReply = (String(parsed.reply || '').match(/\$\s?\d+(?:[.,]\d{1,2})?/g) || [])
    .map(a => Number(a.replace(/[$\s]/g, '').replace(',', '.')));
  // Sin montos todavía, pero la reserva con anticipo sí se puede mencionar para crear urgencia.
  const noAmountsYet = 'No escribas ningún monto (ni valor total ni valor del anticipo) todavía; sí puedes decir que la fecha se reserva con el anticipo.';

  if (quotedTotal > 0 || quotedDeposit > 0) {
    if (firstOrder.missing === 'items') {
      corrections.push(`${noAmountsYet} Aún no está claro qué modelos y cuántas docenas quiere; pregúntale.`);
    } else if (firstOrder.missing === 'place') {
      corrections.push(`${noAmountsYet} Pregunta primero a qué ciudad se envía el pedido.`);
    } else if (firstOrder.missing === 'unknown_place') {
      corrections.push(`${noAmountsYet} "${firstOrder.place}" no aparece en el tarifario o existe en varias provincias; pregunta la ciudad y la provincia exactas.`);
    }
  }

  // Si ya se conocen modelos, cantidad y ciudad, cualquier monto escrito debe cuadrar con el cálculo del sistema,
  // aunque la IA no lo haya declarado en quoted_total (por ejemplo "$123.00" en lugar de "$124.00").
  if (!firstOrder.missing && amountsInReply.length > 0) {
    const allowed = [firstOrder.total, firstOrder.deposit];
    const catalogPrices = catalog.map(p => Number(p.price));
    const givesTotal = quotedTotal > 0 || quotedDeposit > 0 || amountsInReply.some(a => allowed.some(v => Math.abs(a - v) < 0.009));
    const wrongTotal = (quotedTotal > 0 && Math.abs(quotedTotal - firstOrder.total) > 0.009)
      || (quotedDeposit > 0 && Math.abs(quotedDeposit - firstOrder.deposit) > 0.009);
    // Al dar el total solo valen total y anticipo; en otros mensajes también se permite el precio de catálogo.
    const accepted = givesTotal ? allowed : [...allowed, ...catalogPrices];
    const extraAmounts = amountsInReply.some(a => !accepted.some(v => Math.abs(a - v) < 0.009));
    if (wrongTotal || extraAmounts) {
      console.warn(`💲 Montos corregidos: la IA dijo ${quotedTotal}/${quotedDeposit} (${amountsInReply.join(', ')}), corresponde ${firstOrder.total}/${firstOrder.deposit}`);
      corrections.push(
        `El valor total correcto del pedido (velas + envío a ${firstOrder.shipping!.place}) es $${firstOrder.total.toFixed(2)} ` +
        `y el anticipo del 50% es $${firstOrder.deposit.toFixed(2)}. Escribe solo esos montos, como un solo valor: ` +
        'sin precio por docena, sin subtotal de velas y sin mencionar el envío por separado.'
      );
    }
  }

  if (corrections.length > 0) {
    parsed = await ask(`CORRECCIÓN (obligatoria):\n- ${corrections.join('\n- ')}\nRehaz la respuesta aplicando estas correcciones.`);
  }

  const order = computeOrderTotal(parsed.order_items, parsed.shipping_place, catalog);

  // Solo nombres que existen de verdad en el catálogo, sin duplicados.
  const byName = new Map(catalog.map(p => [p.name.trim().toLowerCase(), p.name]));
  const showProducts = [...new Set(
    (Array.isArray(parsed.show_products) ? parsed.show_products : [])
      .map((n: any) => byName.get(String(n).trim().toLowerCase()))
      .filter(Boolean) as string[]
  )].slice(0, MAX_PHOTOS_PER_TURN);

  return {
    reply: String(parsed.reply || '').trim(),
    intent: parsed.intent || 'other',
    show_products: showProducts,
    handoff: parsed.handoff || 'none',
    send_bank_details: parsed.send_bank_details === true,
    owner_question: String(parsed.owner_question || '').trim(),
    event_date: eventDate,
    delivery_date: expectedDelivery,
    order_items: order.items,
    shipping_place: order.place,
    order_total: order.total,
    deposit: order.total ? order.deposit : 0
  };
}

/**
 * Extrae qué productos del catálogo quiere el cliente y cuántas docenas, leyendo la conversación
 * reciente (el cliente suele decir "de ese modelo" sin repetir el nombre).
 * Devuelve solo coincidencias reales del catálogo: nunca inventa productos ni precios.
 */
export interface OrderItem {
  name: string;
  price: number;
  quantity: number;
  personalization: string;
}

export async function extractOrderItems(
  conversationText: string,
  catalog: { name: string; price: number; category: string }[]
): Promise<OrderItem[]> {
  if (!catalog || catalog.length === 0) return [];

  try {
    const catalogNames = catalog.map(p => p.name).join('\n');
    const prompt = `Catálogo disponible (un producto por línea):
${catalogNames}

Conversación reciente con el cliente:
${conversationText}

Identifica qué productos del catálogo quiere el cliente en este momento y cuántas DOCENAS de cada uno.
Reglas:
- Usa EXACTAMENTE los nombres del catálogo.
- Si no queda claro ningún producto del catálogo, devuelve una lista vacía.
- Si da la cantidad en unidades, conviértela a docenas (redondea hacia arriba).
- Si no especifica cantidad, asume 1 docena.
- En personalization resume colores, nombres, frases y fecha del evento que pidió para ese producto; cadena vacía si no hay.

Responde solo JSON: {"items":[{"name":"...","quantity":1,"personalization":"..."}]}`;

    const response = await openai.chat.completions.create({
      model: MODEL,
      reasoning_effort: REASONING_EFFORT,
      max_completion_tokens: 1000,
      response_format: { type: 'json_object' },
      messages: [{ role: 'user', content: prompt }]
    });

    const parsed = JSON.parse(response.choices[0]?.message?.content || '{}');
    const items = Array.isArray(parsed.items) ? parsed.items : [];

    return items
      .map((item: any) => {
        const match = catalog.find(p => p.name.toLowerCase() === String(item.name || '').toLowerCase());
        if (!match) return null;
        const quantity = Number(item.quantity);
        return {
          name: match.name,
          price: match.price,
          quantity: Number.isFinite(quantity) && quantity > 0 ? Math.ceil(quantity) : 1,
          personalization: String(item.personalization || '').trim()
        };
      })
      .filter(Boolean) as OrderItem[];
  } catch (error: any) {
    console.error('Error extrayendo productos del pedido:', error.message);
    return [];
  }
}
