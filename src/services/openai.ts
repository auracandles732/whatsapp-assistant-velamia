import { OpenAI, toFile } from 'openai';

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

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
      model: 'gpt-4o-mini',
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: 'Describe brevemente en español qué se ve en esta imagen, en el contexto de una tienda de velas artesanales (por ejemplo si parece una foto de referencia de un evento, un modelo de vela, un espacio a decorar, etc). Máximo 2 líneas.' },
          { type: 'image_url', image_url: { url: imageUrl } }
        ] as any
      }],
      max_tokens: 150
    });
    return response.choices[0]?.message?.content || '';
  } catch (error: any) {
    console.error('Error describiendo imagen:', error.message);
    return '[No se pudo analizar la imagen]';
  }
}

const BASE_SYSTEM_PROMPT = `Eres un asistente de ventas para VELAMIA, una tienda de velas artesanales premium en Guayaquil, Ecuador.

Tu rol es:
1. Responder preguntas sobre productos y disponibilidad
2. Crear cotizaciones personalizadas
3. Procesar pedidos
4. Dar seguimiento a entregas
5. Cerrar ventas de forma amable y profesional

Siempre:
- Responde en español natural y amable
- Sugiere productos del catálogo real cuando sea apropiado (nunca inventes productos que no estén en el catálogo)
- IMPORTANTE: todos los precios del catálogo son POR DOCENA (12 unidades), acláralo si el cliente pregunta por precio
- Proporciona alternativas si algo no está disponible
- Confirma direcciones de entrega antes de finalizar
- Usa emojis ocasionalmente para ser más cercano

Evita:
- Promesas irrealistas de entrega
- Descuentos sin autorización
- Inventar productos o precios que no estén en el catálogo
- Respuestas muy largas (máximo 3 párrafos)`;

interface Message {
  role: 'user' | 'assistant' | 'system';
  content: string;
}

interface CatalogProduct {
  name: string;
  price: number;
  category: string;
}

function buildSystemPrompt(catalog?: CatalogProduct[]) {
  if (!catalog || catalog.length === 0) {
    return BASE_SYSTEM_PROMPT + `\n\nNota: el catálogo de productos aún no ha sido cargado. Si el cliente pregunta por productos específicos, indícale amablemente que un asesor le enviará el catálogo en breve.`;
  }

  const byCategory: { [key: string]: CatalogProduct[] } = {};
  for (const p of catalog) {
    if (!byCategory[p.category]) byCategory[p.category] = [];
    byCategory[p.category].push(p);
  }

  const catalogText = Object.entries(byCategory)
    .map(([cat, items]) => `${cat}:\n` + items.map(i => `  - ${i.name}: $${i.price} por docena`).join('\n'))
    .join('\n\n');

  return BASE_SYSTEM_PROMPT + `\n\nCATÁLOGO ACTUAL DE VELAMIA (precios por docena):\n\n${catalogText}`;
}

export async function generateResponse(conversationHistory: Message[], userMessage: string, catalog?: CatalogProduct[]) {
  try {
    const messages: Message[] = [
      ...conversationHistory,
      { role: 'user', content: userMessage }
    ];

    const response = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: buildSystemPrompt(catalog) },
        ...messages
      ],
      temperature: 0.7,
      max_tokens: 500
    });

    const aiResponse = response.choices[0]?.message?.content || '';
    return {
      response: aiResponse,
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
    const analysisPrompt = `Analiza este mensaje y responde en JSON:
    {
      "intent": "greeting|product_inquiry|quotation|order|payment|delivery_status|complaint|other",
      "entities": ["nombre_producto", "cantidad", "precio", etc],
      "confidence": 0.0-1.0
    }

    Mensaje: "${userMessage}"`;

    const response = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: analysisPrompt }],
      temperature: 0.3,
      max_tokens: 200
    });

    const content = response.choices[0]?.message?.content || '{}';
    return JSON.parse(content);
  } catch (error: any) {
    console.error('Error analizando intención:', error.message);
    return { intent: 'other', entities: [], confidence: 0 };
  }
}

export async function generateQuotation(products: any[], customerName: string) {
  try {
    const productsList = products.map(p => `- ${p.name}: $${p.price} x ${p.quantity}`).join('\n');
    const totalAmount = products.reduce((sum, p) => sum + (p.price * p.quantity), 0);

    const prompt = `Crea una cotización formal en formato JSON para:
    Cliente: ${customerName}
    Productos:
    ${productsList}

    Total: $${totalAmount.toFixed(2)}

    Incluye: id, fecha_expiracion (3 días), condiciones_pago, instrucciones_entrega`;

    const response = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.3,
      max_tokens: 300
    });

    const content = response.choices[0]?.message?.content || '{}';
    return JSON.parse(content);
  } catch (error: any) {
    console.error('Error generando cotización:', error.message);
    throw error;
  }
}

export async function generateFollowUp(orderStatus: string, customerName: string) {
  try {
    const prompt = `Crea un mensaje de seguimiento amable y profesional para:
    Cliente: ${customerName}
    Estado del pedido: ${orderStatus}

    El mensaje debe:
    - Ser breve (máximo 2 párrafos)
    - Incluir estado actual
    - Próximos pasos si aplica
    - Invitar a contactar con dudas`;

    const response = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.7,
      max_tokens: 200
    });

    return response.choices[0]?.message?.content || '';
  } catch (error: any) {
    console.error('Error generando seguimiento:', error.message);
    throw error;
  }
}
