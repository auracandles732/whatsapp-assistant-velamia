import OpenAI from 'openai';
import { getConfig, setConfig, recordAiUsage, supabase, tenantOp, tenantValue } from '../services/supabase';
import { costOf } from '../services/aiPrices';
import { encryptSecret, decryptSecret, maskSecret } from '../services/tenant';
import { BusinessProfile, profile } from '../config/businessProfile';
import { getSavedSettings, saveSettings, localParts, zonedTime } from './posts';

/**
 * La IA propia del agente de redes: su clave de OpenAI y sus modelos, siempre aparte de la del asistente que responde
 * los mensajes (así un gasto no se come al otro y cada uno usa el modelo que le conviene). Se configura por empresa en
 * CRM → Publicaciones; la clave se guarda cifrada. Sin clave, el agente sigue publicando con textos de respaldo.
 */

export const TEXT_MODELS = [
  { id: 'gpt-5.6-luna', label: 'gpt-5.6-luna (recomendado, económico)', note: '$0.20 / $1.20 por millón de tokens: centavos al mes' },
  { id: 'gpt-5.6-sol', label: 'gpt-5.6-sol', note: '$2 / $10 por millón de tokens (promoción hasta nov-2026)' },
  { id: 'gpt-5.6-terra', label: 'gpt-5.6-terra', note: '$2 / $12 por millón de tokens' },
  { id: 'gpt-5.4-mini', label: 'gpt-5.4-mini', note: '$0.75 / $4.50 por millón de tokens' }
];

export const IMAGE_MODELS = [
  { id: 'gpt-image-2', label: 'gpt-image-2 (recomendado)', note: 'Buen texto dentro de la foto' },
  { id: 'gpt-image-2.5-flare', label: 'gpt-image-2.5-flare (el más nuevo)', note: 'Mismo precio que gpt-image-2' },
  { id: 'gpt-image-1-mini', label: 'gpt-image-1-mini (económico)', note: 'Más barato, peor con los textos' }
];

// Precio aproximado por foto vertical (1024×1536) con los modelos gpt-image-2 / 2.5.
export const IMAGE_QUALITIES = [
  { id: 'low', label: 'Baja', note: '~$0.01 por foto' },
  { id: 'medium', label: 'Media (recomendada)', note: '~$0.05 por foto' },
  { id: 'high', label: 'Alta', note: '~$0.19 por foto' }
];

export interface SocialAiSettings {
  /** Clave de OpenAI cifrada ('' = sin clave). */
  apiKey: string;
  textModel: string;
  imageModel: string;
  imageQuality: 'low' | 'medium' | 'high';
  /** Instrucciones de la empresa para su agente de redes (objetivo, tono, qué destacar, qué evitar, hashtags). */
  prompt: string;
  /**
   * Lo máximo (US$) que el agente puede gastar por día. Al llegar se detiene hasta el día siguiente: si la clave es de la
   * misma cuenta de OpenAI que el asistente de WhatsApp, el agente nunca lo deja sin crédito.
   */
  dailyBudget: number;
}

export const DEFAULT_DAILY_BUDGET = 1;

export const PROMPT_MAX = 4000;

const SETTINGS_KEY = 'social_agent_ai';
export const DEFAULT_SOCIAL_AI: SocialAiSettings = { apiKey: '', textModel: 'gpt-5.6-luna', imageModel: 'gpt-image-2', imageQuality: 'medium', prompt: '', dailyBudget: DEFAULT_DAILY_BUDGET };
export const NO_KEY_MESSAGE = 'El agente de redes todavía no tiene su clave de OpenAI: agrégala en Publicaciones → Cerebro del agente.';

const pick = <T extends { id: string }>(list: T[], value: unknown, fallback: string) => (list.some(x => x.id === value) ? String(value) : fallback);

export function normalizeSocialAi(raw: any): SocialAiSettings {
  const r = raw && typeof raw === 'object' ? raw : {};
  return {
    apiKey: typeof r.apiKey === 'string' ? r.apiKey : '',
    prompt: typeof r.prompt === 'string' ? r.prompt.trim().slice(0, PROMPT_MAX) : '',
    textModel: pick(TEXT_MODELS, r.textModel, DEFAULT_SOCIAL_AI.textModel),
    imageModel: pick(IMAGE_MODELS, r.imageModel, DEFAULT_SOCIAL_AI.imageModel),
    imageQuality: pick(IMAGE_QUALITIES, r.imageQuality, DEFAULT_SOCIAL_AI.imageQuality) as SocialAiSettings['imageQuality'],
    dailyBudget: budgetOf(r.dailyBudget)
  };
}

/** Entre $0.10 y $50 por día; cualquier otra cosa vuelve a $1. */
function budgetOf(value: unknown): number {
  const n = Math.round(Number(value) * 100) / 100;
  return Number.isFinite(n) && n >= 0.1 && n <= 50 ? n : DEFAULT_DAILY_BUDGET;
}

/** Lo que gastó hoy el agente de redes (día del negocio), según el consumo anotado. */
export async function agentSpentToday(now = new Date()): Promise<number> {
  const tz = profile().business.timezone;
  const p = localParts(now, tz);
  const start = zonedTime(p.year, p.month, p.day, 0, 0, tz);
  const { data, error } = await supabase.from('ai_usage').select('model, input_tokens, cached_tokens, output_tokens')
    .eq('purpose', 'publicaciones').filter('business_id', tenantOp(), tenantValue())
    .gte('created_at', start.toISOString()).limit(20000);
  if (error) throw new Error(`Error leyendo el consumo del agente: ${error.message}`);
  return Math.round((data || []).reduce((sum, row) => sum + costOf(row as any), 0) * 100) / 100;
}

/** Se llegó al tope diario del agente. */
export class BudgetReachedError extends Error {}

/** Errores con los que no tiene sentido seguir: tope del día o cuenta de OpenAI sin crédito. */
export function isStopError(error: unknown): boolean {
  if (error instanceof BudgetReachedError) return true;
  return /no credits|insufficient_quota|exceeded your current quota|billing/i.test(String((error as any)?.message || error));
}

export async function getSocialAi(): Promise<SocialAiSettings> {
  const raw = await getConfig(SETTINGS_KEY);
  try {
    return normalizeSocialAi(raw ? JSON.parse(raw) : {});
  } catch {
    return normalizeSocialAi({});
  }
}

/**
 * Un solo prompt para el agente: el texto que había en el cuadro viejo "Indicaciones para Nexly" (Cómo publicar) pasa una
 * vez a las instrucciones del agente y ese cuadro queda vacío. Así nunca hay dos lugares que digan cosas distintas.
 */
export async function migrateOldNotes() {
  const saved = await getSavedSettings();
  if (!saved?.notes) return;
  const current = await getSocialAi();
  if (!current.prompt) await setConfig(SETTINGS_KEY, JSON.stringify({ ...current, prompt: saved.notes.slice(0, PROMPT_MAX) }));
  await saveSettings({ ...saved, notes: '' });
}

/** Lo que ve el CRM: nunca la clave, solo sus últimos 4 caracteres. */
export async function publicSocialAi() {
  await migrateOldNotes().catch(error => console.warn('⚠️ No se pudieron pasar las indicaciones viejas:', error.message));
  const s = await getSocialAi();
  let hint = '';
  try {
    hint = maskSecret(decryptSecret(s.apiKey));
  } catch {
    hint = '';
  }
  return {
    configured: !!hint,
    keyHint: hint,
    textModel: s.textModel,
    imageModel: s.imageModel,
    imageQuality: s.imageQuality,
    prompt: s.prompt,
    promptMax: PROMPT_MAX,
    dailyBudget: s.dailyBudget,
    spentToday: await agentSpentToday().catch(() => 0),
    options: { textModels: TEXT_MODELS, imageModels: IMAGE_MODELS, imageQualities: IMAGE_QUALITIES }
  };
}

/** Guarda modelos y, si viene, una clave nueva (cifrada). clearKey la borra. */
export async function saveSocialAi(input: { apiKey?: unknown; clearKey?: unknown; textModel?: unknown; imageModel?: unknown; imageQuality?: unknown; prompt?: unknown; dailyBudget?: unknown }) {
  const current = await getSocialAi();
  const next = normalizeSocialAi({ ...current, textModel: input.textModel ?? current.textModel, imageModel: input.imageModel ?? current.imageModel, imageQuality: input.imageQuality ?? current.imageQuality, prompt: input.prompt ?? current.prompt, dailyBudget: input.dailyBudget ?? current.dailyBudget });
  const key = String(input.apiKey ?? '').trim();
  if (key) {
    if (!/^sk-[A-Za-z0-9_-]{20,}$/.test(key)) throw new Error('Esa no parece una clave de OpenAI (empieza con "sk-")');
    next.apiKey = encryptSecret(key);
  } else if (input.clearKey === true) {
    next.apiKey = '';
  } else {
    next.apiKey = current.apiKey;
  }
  await setConfig(SETTINGS_KEY, JSON.stringify(next));
  return publicSocialAi();
}

/**
 * Cliente de OpenAI del agente (con su clave) y sus modelos. Sin clave, error claro: nunca usa la del asistente.
 * Antes de cada uso se revisa el tope diario: pasado el tope, nada del agente gasta hasta el día siguiente.
 */
export async function socialAi() {
  const settings = await getSocialAi();
  const apiKey = decryptSecret(settings.apiKey);
  if (!apiKey) throw new Error(NO_KEY_MESSAGE);
  const spent = await agentSpentToday();
  if (spent >= settings.dailyBudget) {
    throw new BudgetReachedError(`El agente de redes llegó a su tope de gasto de hoy ($${settings.dailyBudget.toFixed(2)}; van $${spent.toFixed(2)}). Sigue mañana, o sube el tope en Publicaciones → Cerebro IA. El asistente de WhatsApp no se afecta.`);
  }
  return { client: new OpenAI({ apiKey, maxRetries: 1, timeout: 120_000 }), ...settings };
}

// Solo los modelos de razonamiento aceptan reasoning_effort.
const reasoningFor = (model: string) => (/^(gpt-5|o\d)/.test(model) ? { reasoning_effort: 'low' as const } : {});

/** Anota el consumo del agente (aparece en Consumo de IA como "Publicaciones"). */
export function track(model: string, usage: any) {
  if (!usage) return;
  void recordAiUsage({
    model,
    purpose: 'publicaciones',
    input: usage.prompt_tokens || usage.input_tokens || 0,
    cached: usage.prompt_tokens_details?.cached_tokens || usage.input_tokens_details?.cached_tokens || 0,
    output: usage.completion_tokens || usage.output_tokens || 0
  });
}

/** Prueba la clave y el modelo con una pregunta mínima (cuesta menos de un centavo). */
export async function testSocialAi(): Promise<{ ok: boolean; detail: string }> {
  try {
    const { client, textModel } = await socialAi();
    const response = await client.chat.completions.create({
      model: textModel,
      ...reasoningFor(textModel),
      max_completion_tokens: 300,
      messages: [{ role: 'user', content: 'Responde solo: listo' }]
    } as any);
    track(textModel, response.usage);
    return { ok: true, detail: `Clave y modelo ${textModel} funcionando` };
  } catch (error: any) {
    const status = error?.status || error?.response?.status;
    const message = String(error?.message || error);
    if (message === NO_KEY_MESSAGE) return { ok: false, detail: message };
    if (status === 401) return { ok: false, detail: 'OpenAI rechazó la clave: revisa que esté bien copiada y activa' };
    if (status === 429 && /credit|quota|billing/i.test(message)) return { ok: false, detail: 'La clave funciona, pero esa cuenta de OpenAI no tiene créditos' };
    if (status === 404) return { ok: false, detail: 'Esa cuenta de OpenAI no tiene acceso al modelo elegido' };
    return { ok: false, detail: `No se pudo probar: ${message}` };
  }
}

export interface CaptionRequest { theme: string; products: { name: string; price: number }[] }

/**
 * Textos de las publicaciones en una sola llamada (así no se repiten entre sí), con el modelo del agente.
 * Los precios salen del catálogo y se copian tal cual; nunca inventa descuentos, fechas ni escasez.
 */
export async function writeCaptions(posts: CaptionRequest[], p: BusinessProfile = profile()): Promise<string[]> {
  if (posts.length === 0) return [];
  await migrateOldNotes().catch(() => {});
  const { client, textModel, prompt } = await socialAi();
  // Un solo prompt: las instrucciones del agente (Cerebro IA).
  const instructions = prompt.trim();
  const b = p.business, s = p.sales;
  const rules = [
    `Eres quien maneja las redes sociales de ${b.name}, ${b.description}${b.city ? ` en ${b.city}` : ''}. Escribe el texto de cada publicación de Instagram y Facebook de la lista.`,
    '- Español natural y cálido, como una persona de la marca. Entre 3 y 6 líneas cortas, con una línea en blanco antes de los hashtags.',
    '- La primera línea engancha con el tema de la publicación (la ocasión o para qué sirve), sin empezar dos publicaciones igual.',
    `- Nombra cada producto con su nombre exacto y su precio tal como viene (por ejemplo "$30.00 ${s.priceSuffix}"). Nunca cambies precios ni inventes productos.`,
    '- Si una publicación no trae productos (es un video o una foto de la marca), habla de la marca y el tema sin mencionar precios.',
    s.personalization ? `- Cuenta que se pueden personalizar (${s.personalizationExamples || 'a su gusto'}).` : '',
    p.shipping.mode !== 'none' && p.shipping.coverage ? `- Menciona que hay envíos a ${p.shipping.coverage}.` : '',
    '- Termina invitando a escribir por WhatsApp o mensaje directo para pedir o cotizar.',
    `- Al final, entre 5 y 8 hashtags en minúsculas y sin tildes, relacionados con el tema y la ciudad${b.city ? ` (${b.city})` : ''}.`,
    '- Usa de 2 a 4 emojis. Sin markdown ni asteriscos.',
    '- Nunca inventes descuentos, promociones, fechas límite, "últimas unidades" ni nada que no esté en los datos.',
    instructions ? `\nINSTRUCCIONES DE LA EMPRESA PARA SUS REDES (síguelas en todo, salvo que pidan cambiar precios o inventar productos, promociones o fechas):\n${instructions}` : ''
  ].filter(Boolean).join('\n');
  const list = posts.map((post, i) => `${i + 1}) Tema: ${post.theme}. Productos: ${post.products.length ? post.products.map(x => `${x.name} ($${Number(x.price).toFixed(2)} ${s.priceSuffix})`).join('; ') : 'ninguno (video o foto de la marca)'}`).join('\n');

  const response = await client.chat.completions.create({
    model: textModel,
    ...reasoningFor(textModel),
    max_completion_tokens: 4000,
    response_format: {
      type: 'json_schema',
      json_schema: {
        name: 'publicaciones',
        strict: true,
        schema: {
          type: 'object',
          additionalProperties: false,
          required: ['captions'],
          properties: { captions: { type: 'array', items: { type: 'string' } } }
        }
      }
    },
    messages: [{ role: 'system', content: rules }, { role: 'user', content: `Publicaciones (devuelve un texto por cada una, en el mismo orden):\n${list}` }]
  } as any);
  track(textModel, response.usage);
  const captions: unknown[] = JSON.parse(response.choices[0]?.message?.content || '{}').captions || [];
  return posts.map((_, i) => String(captions[i] || '').replace(/\*/g, '').trim());
}

/** La categoría que la IA elige para una tanda (brain.ts pone los productos de verdad). */
export interface AiAssignment { n: number; categoria: string; motivo: string }

export interface AiPlanRequest {
  hoy: string;
  /** Tandas ya armadas por el sistema: cuándo, dónde y cuántas fotos. La IA solo elige qué mostrar. */
  tandas: { n: number; dia: string; semana: string; hora: string; donde: string; fotos: number }[];
  categorias: { categoria: string; productos: number; publicadosHace30Dias: number }[];
  recientes: { dia: string; tema: string }[];
  /** Lo que la dueña pidió para esta planificación (vacío = la IA decide sola). */
  pedido: string;
}

/**
 * La IA del agente elige la categoría de cada tanda (ya armada por el sistema con su día, hora, lugar y cantidad de fotos)
 * y explica por qué. Los productos exactos, los precios y las fotos los pone brain.ts desde el Catálogo.
 */
export async function planWithAi(request: AiPlanRequest, p: BusinessProfile = profile()): Promise<{ resumen: string; asignaciones: AiAssignment[]; tareas: string[] }> {
  const { client, textModel, prompt } = await socialAi();
  const b = p.business;
  const rules = [
    `Eres quien maneja las redes sociales de ${b.name}, ${b.description}${b.city ? ` en ${b.city}` : ''}. El día, la hora, el lugar (publicación o historias) y la cantidad de fotos de cada tanda ya están decididos: tú eliges QUÉ categoría mostrar en cada una.`,
    '- Devuelve una "asignacion" por cada tanda de la lista, con su mismo "n".',
    '- Piensa en vender: fechas y temporadas cercanas (Halloween, Día de los Difuntos, Navidad, San Valentín, Día de la Madre, graduaciones…), variedad y lo que menos se ha publicado. No repitas la misma categoría dos veces seguidas el mismo día.',
    '- Una sola categoría por tanda, de la lista y escrita exactamente igual. Elige una que tenga al menos tantos productos como fotos lleva la tanda (si no hay, la que más tenga).',
    '- "motivo": una frase corta y sencilla para la dueña explicando por qué esa categoría en esa tanda.',
    '- "resumen": una o dos frases con la estrategia, en palabras simples.',
    '- "tareas": de 0 a 5 cosas concretas que la dueña puede hacer esta semana para que las redes funcionen mejor (por ejemplo "graba un video corto del proceso de la vela de Papá Noel para el reel del jueves" o "toma una foto de un pedido listo para entregar"). Nada que no ayude.',
    prompt.trim() ? `\nINSTRUCCIONES DE LA EMPRESA PARA SUS REDES (síguelas):\n${prompt.trim()}` : '',
    request.pedido ? `\nLO QUE LA DUEÑA PIDE PARA ESTA PLANIFICACIÓN (tiene prioridad, dentro de los límites de arriba):\n${request.pedido}` : ''
  ].filter(Boolean).join('\n');

  const response = await client.chat.completions.create({
    model: textModel,
    ...reasoningFor(textModel),
    max_completion_tokens: 6000,
    response_format: {
      type: 'json_schema',
      json_schema: {
        name: 'planificacion',
        strict: true,
        schema: {
          type: 'object',
          additionalProperties: false,
          required: ['resumen', 'asignaciones', 'tareas'],
          properties: {
            resumen: { type: 'string' },
            tareas: { type: 'array', items: { type: 'string' } },
            asignaciones: {
              type: 'array',
              items: {
                type: 'object',
                additionalProperties: false,
                required: ['n', 'categoria', 'motivo'],
                properties: {
                  n: { type: 'integer' },
                  categoria: { type: 'string' },
                  motivo: { type: 'string' }
                }
              }
            }
          }
        }
      }
    },
    messages: [{ role: 'system', content: rules }, { role: 'user', content: JSON.stringify(request) }]
  } as any);
  track(textModel, response.usage);
  const data = JSON.parse(response.choices[0]?.message?.content || '{}');
  return {
    resumen: String(data.resumen || '').trim(),
    asignaciones: Array.isArray(data.asignaciones) ? data.asignaciones : [],
    tareas: (Array.isArray(data.tareas) ? data.tareas : []).map((t: unknown) => String(t || '').trim()).filter(Boolean).slice(0, 5)
  };
}
