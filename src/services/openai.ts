import { OpenAI } from 'openai';

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

const SYSTEM_PROMPT = `Eres un asistente de ventas para VELAMIA, una tienda de velas artesanales premium en Guayaquil, Ecuador.

Tu rol es:
1. Responder preguntas sobre productos y disponibilidad
2. Crear cotizaciones personalizadas
3. Procesar pedidos
4. Dar seguimiento a entregas
5. Cerrar ventas de forma amable y profesional

Siempre:
- Responde en español natural y amable
- Sugiere productos cuando sea apropiado
- Ofrece información de precios y disponibilidad
- Proporciona alternativas si algo no está disponible
- Confirma direcciones de entrega antes de finalizar
- Usa emojis ocasionalmente para ser más cercano

Evita:
- Promesas irrealistas de entrega
- Descuentos sin autorización
- Información de terceros
- Respuestas muy largas (máximo 3 párrafos)`;

interface Message {
  role: 'user' | 'assistant' | 'system';
  content: string;
}

export async function generateResponse(conversationHistory: Message[], userMessage: string) {
  try {
    const messages: Message[] = [
      ...conversationHistory,
      { role: 'user', content: userMessage }
    ];

    const response = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
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
