import { OpenAI, toFile } from 'openai';

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
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

FOTOS (campo show_products):
- Incluye productos SOLO cuando el cliente pide ver modelos, fotos u opciones, o pide "más modelos".
- Incluye TODOS los productos del catálogo que correspondan a lo que pidió (por ejemplo, todos los de la categoría o todos los que coinciden con el modelo), usando los nombres exactos.
- No repitas fotos ya enviadas en esta conversación, salvo que el cliente pida volver a ver un modelo concreto.
- Déjalo vacío cuando el cliente está dando detalles de su pedido (cantidad, fecha, colores, nombres, personalización), confirmando, preguntando precios o formas de pago, o conversando. En esos casos una foto no aporta y confunde.
- Si envías fotos, en reply preséntalas en una frase corta; no repitas la lista completa de nombres y precios porque cada foto ya lleva su nombre y precio.
- Cuando el mensaje indica que el cliente responde a una foto concreta, ese es el modelo del que habla.

PASAR EL CHAT A UNA PERSONA DEL EQUIPO (campo handoff):
- card_payment: el cliente decide pagar o pide pagar con tarjeta.
- payment_proof: el cliente envía o dice que envió un comprobante, transferencia o depósito.
- complaint: queja o problema con un pedido (llegó roto, atraso, error).
- custom_design: pide un diseño, color o personalización que no está tal cual en el catálogo.
- none: cualquier otro caso.
- Si handoff no es none, reply es un mensaje breve y cálido diciendo que una persona del equipo lo atiende personalmente en unos minutos. No hagas preguntas ni prometas nada más.

INTENCIÓN (campo intent):
- quotation: el cliente ya indicó productos y cantidades y quiere saber el total.
- order: el cliente confirma que quiere comprar/reservar.
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

export type HandoffReason = 'none' | 'card_payment' | 'payment_proof' | 'complaint' | 'custom_design';

export interface TurnPlan {
  reply: string;
  intent: 'greeting' | 'product_inquiry' | 'quotation' | 'order' | 'delivery_status' | 'other';
  show_products: string[];
  handoff: HandoffReason;
}

const TURN_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['reply', 'intent', 'show_products', 'handoff'],
  properties: {
    reply: { type: 'string' },
    intent: { type: 'string', enum: ['greeting', 'product_inquiry', 'quotation', 'order', 'delivery_status', 'other'] },
    show_products: { type: 'array', items: { type: 'string' } },
    handoff: { type: 'string', enum: ['none', 'card_payment', 'payment_proof', 'complaint', 'custom_design'] }
  }
};

function buildSystemPrompt(catalog: CatalogProduct[], customPrompt: string | undefined, sentProducts: string[]) {
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

  return `${persona}\n\n${CORE_RULES}\n\n${catalogText}\n\n${sentText}`;
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
}): Promise<TurnPlan> {
  const { history, userMessage, catalog, customPrompt, sentProducts } = params;

  const response = await openai.chat.completions.create({
    model: MODEL,
    reasoning_effort: REASONING_EFFORT,
    max_completion_tokens: 3000,
    response_format: {
      type: 'json_schema',
      json_schema: { name: 'turno_whatsapp', strict: true, schema: TURN_SCHEMA }
    },
    messages: [
      { role: 'system', content: buildSystemPrompt(catalog, customPrompt, sentProducts) },
      ...history,
      { role: 'user', content: userMessage }
    ]
  });

  const parsed = JSON.parse(response.choices[0]?.message?.content || '{}');

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
    handoff: parsed.handoff || 'none'
  };
}

/**
 * Extrae qué productos del catálogo quiere el cliente y cuántas docenas, leyendo la conversación
 * reciente (el cliente suele decir "de ese modelo" sin repetir el nombre).
 * Devuelve solo coincidencias reales del catálogo: nunca inventa productos ni precios.
 */
export async function extractOrderItems(
  conversationText: string,
  catalog: { name: string; price: number; category: string }[]
): Promise<{ name: string; price: number; quantity: number }[]> {
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

Responde solo JSON: {"items":[{"name":"...","quantity":1}]}`;

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
          quantity: Number.isFinite(quantity) && quantity > 0 ? Math.ceil(quantity) : 1
        };
      })
      .filter(Boolean) as { name: string; price: number; quantity: number }[];
  } catch (error: any) {
    console.error('Error extrayendo productos del pedido:', error.message);
    return [];
  }
}
