import { OpenAI, toFile } from 'openai';

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

const MODEL = 'gpt-5.4-mini';

// GPT-5.4 es un modelo de razonamiento: los tokens de razonamiento cuentan dentro de
// max_completion_tokens, por eso los límites llevan margen y el esfuerzo va en "low"
// para responder rápido por WhatsApp.
const REASONING_EFFORT = 'low' as const;

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
          { type: 'text', text: 'Describe brevemente en español qué se ve en esta imagen, en el contexto de una tienda de velas para eventos (por ejemplo si parece una foto de referencia de un evento, un modelo de vela, una decoración, etc). Máximo 2 líneas.' },
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
// sin ellas el bot podría inventar productos o dar precios como si fueran por unidad.
const CORE_RULES = `REGLAS DEL SISTEMA (obligatorias):
- Todos los precios del catálogo son POR DOCENA (12 unidades). Acláralo siempre que menciones un precio.
- Solo ofrece productos que estén en el catálogo de abajo, con su nombre y precio exactos. Nunca inventes productos, precios, colores ni modelos.
- Si el cliente pide algo que no está en el catálogo (otro evento, otro modelo), dilo con amabilidad y ofrece las opciones más parecidas que sí existen, o indica que lo verificarás.
- Estás escribiendo por WhatsApp: mensajes cortos, sin tablas ni formato markdown. Para resaltar usa *asteriscos*.
- Cuando el cliente pregunta por productos, el sistema le envía automáticamente fotos del catálogo después de tu respuesta; no digas que no puedes enviar fotos.`;

interface Message {
  role: 'user' | 'assistant' | 'system';
  content: string;
}

interface CatalogProduct {
  name: string;
  price: number;
  category: string;
}

function buildSystemPrompt(catalog?: CatalogProduct[], customPrompt?: string) {
  const persona = customPrompt && customPrompt.trim() ? customPrompt.trim() : DEFAULT_PERSONA;

  if (!catalog || catalog.length === 0) {
    return `${persona}\n\n${CORE_RULES}\n\nCATÁLOGO: todavía no hay productos cargados. Si el cliente pregunta por productos, indícale que en breve le compartes las opciones.`;
  }

  const byCategory: { [key: string]: CatalogProduct[] } = {};
  for (const p of catalog) {
    if (!byCategory[p.category]) byCategory[p.category] = [];
    byCategory[p.category].push(p);
  }

  const catalogText = Object.entries(byCategory)
    .map(([cat, items]) => `${cat}:\n` + items.map(i => `  - ${i.name}: $${i.price} por docena`).join('\n'))
    .join('\n\n');

  return `${persona}\n\n${CORE_RULES}\n\nCATÁLOGO ACTUAL DE VELAMIA (precios por docena):\n\n${catalogText}`;
}

export async function generateResponse(conversationHistory: Message[], userMessage: string, catalog?: CatalogProduct[], customPrompt?: string) {
  try {
    const response = await openai.chat.completions.create({
      model: MODEL,
      reasoning_effort: REASONING_EFFORT,
      max_completion_tokens: 1500,
      messages: [
        { role: 'system', content: buildSystemPrompt(catalog, customPrompt) },
        ...conversationHistory,
        { role: 'user', content: userMessage }
      ]
    });

    return {
      response: response.choices[0]?.message?.content || '',
      usage: {
        prompt_tokens: response.usage?.prompt_tokens,
        completion_tokens: response.usage?.completion_tokens
      }
    };
  } catch (error: any) {
    console.error('Error con OpenAI:', error.message);
    throw error;
  }
}

export async function analyzeUserIntent(userMessage: string) {
  try {
    const analysisPrompt = `Clasifica el mensaje de un cliente de una tienda de velas para eventos.

Responde solo JSON con esta forma:
{"intent": "...", "entities": ["..."], "confidence": 0.0}

Valores de intent:
- greeting: saludo sin pedido concreto
- product_inquiry: pregunta qué productos hay, pide ver modelos/fotos o pregunta por un evento o categoría
- quotation: pide precio total o cotización de productos y cantidades concretas
- order: confirma que quiere comprar productos concretos
- payment: pregunta cómo pagar
- delivery_status: pregunta por un pedido ya hecho
- complaint: queja
- other: cualquier otra cosa

En entities pon el evento o categoría mencionada (por ejemplo "bautizo", "baby shower") y nombres de productos; sin cantidades ni precios.

Mensaje: "${userMessage}"`;

    const response = await openai.chat.completions.create({
      model: MODEL,
      reasoning_effort: REASONING_EFFORT,
      max_completion_tokens: 500,
      response_format: { type: 'json_object' },
      messages: [{ role: 'user', content: analysisPrompt }]
    });

    return JSON.parse(response.choices[0]?.message?.content || '{}');
  } catch (error: any) {
    console.error('Error analizando intención:', error.message);
    return { intent: 'other', entities: [], confidence: 0 };
  }
}

/**
 * Extrae qué productos del catálogo quiere el cliente y cuántas docenas.
 * Devuelve solo coincidencias reales del catálogo: nunca inventa productos ni precios.
 */
export async function extractOrderItems(
  userMessage: string,
  catalog: { name: string; price: number; category: string }[]
): Promise<{ name: string; price: number; quantity: number }[]> {
  if (!catalog || catalog.length === 0) return [];

  try {
    const catalogNames = catalog.map(p => p.name).join('\n');
    const prompt = `Catálogo disponible (un producto por línea):
${catalogNames}

Mensaje del cliente: "${userMessage}"

Identifica qué productos del catálogo pide el cliente y cuántas DOCENAS de cada uno.
Reglas:
- Usa EXACTAMENTE los nombres del catálogo.
- Si el cliente no menciona ningún producto del catálogo con claridad, devuelve una lista vacía.
- Si da la cantidad en unidades, conviértela a docenas (redondea hacia arriba).
- Si no especifica cantidad, asume 1 docena.

Responde solo JSON: {"items":[{"name":"...","quantity":1}]}`;

    const response = await openai.chat.completions.create({
      model: MODEL,
      reasoning_effort: REASONING_EFFORT,
      max_completion_tokens: 800,
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
