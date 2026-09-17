/**
 * Precios de OpenAI por millón de tokens (platform.openai.com/docs/pricing, consultados 17-sep-2026).
 * Sirven para estimar lo que consume cada empresa: la factura real siempre manda.
 * Si OpenAI cambia sus precios, se actualizan aquí.
 */
export interface ModelPrice {
  input: number;
  cached: number;
  output: number;
}

const PRICES: Record<string, ModelPrice> = {
  'gpt-5.6-sol': { input: 4, cached: 0.4, output: 20 },
  'gpt-5.6-terra': { input: 2, cached: 0.2, output: 12 },
  'gpt-5.6-luna': { input: 0.2, cached: 0.02, output: 1.2 },
  'gpt-5.5': { input: 5, cached: 0.5, output: 30 },
  'gpt-5.4': { input: 2.5, cached: 0.25, output: 15 },
  'gpt-5.4-mini': { input: 0.75, cached: 0.075, output: 4.5 },
  'gpt-5.4-nano': { input: 0.2, cached: 0.02, output: 1.25 },
  'gpt-5.2': { input: 1.75, cached: 0.175, output: 14 },
  'gpt-5.1': { input: 1.25, cached: 0.125, output: 10 },
  'gpt-5': { input: 1.25, cached: 0.125, output: 10 },
  'gpt-5-mini': { input: 0.25, cached: 0.025, output: 2 },
  'gpt-5-nano': { input: 0.05, cached: 0.005, output: 0.4 }
};

const DEFAULT_PRICE = PRICES['gpt-5.4-mini'];

export function priceOf(model: string | null | undefined): ModelPrice {
  return PRICES[String(model || '').trim()] || DEFAULT_PRICE;
}

/**
 * Costo estimado de una llamada. Los tokens en caché vienen incluidos en los de entrada
 * y cuestan diez veces menos, así que se cobran aparte.
 */
export function costOf(row: { model?: string | null; input_tokens?: number; cached_tokens?: number; output_tokens?: number }): number {
  const price = priceOf(row.model);
  const input = row.input_tokens || 0;
  const cached = Math.min(row.cached_tokens || 0, input);
  const output = row.output_tokens || 0;
  return ((input - cached) * price.input + cached * price.cached + output * price.output) / 1_000_000;
}
