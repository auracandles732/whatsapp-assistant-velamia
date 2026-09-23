/**
 * Cuándo conviene responder con nota de voz: la clienta contesta después de ver fotos (está interesada), no se le mandó
 * otra nota de voz en las últimas 24 horas y la respuesta es conversación. Precios, totales y listas van por escrito.
 */
const VOICE_MAX_CHARS = 350;
const ONE_DAY_MS = 24 * 60 * 60 * 1000;

type StoredMessage = { sender: string; type: string; content?: string | null; timestamp?: string | null };

const whenSent = (m: StoredMessage) => {
  const raw = String(m.timestamp || '');
  return Date.parse(/[zZ]|[+-]\d{2}:?\d{2}$/.test(raw) ? raw : `${raw}Z`);
};

export function voiceNoteFits(input: { history: StoredMessage[]; reply: string; now?: number }): boolean {
  const { history, reply, now = Date.now() } = input;
  const text = reply.trim();
  if (!text || text.length > VOICE_MAX_CHARS) return false;
  // Montos, listas con viñetas y resúmenes con etiquetas en negrita ("*Total:*") se entienden mejor leídos.
  if (/\$\s?\d/.test(text) || /^\s*[-•·]\s/m.test(text) || /\*[^*\n]+:\*/.test(text)) return false;

  const lastCustomer = history.map(m => m.sender).lastIndexOf('customer');
  const sinceThen = history.slice(lastCustomer + 1);
  if (!sinceThen.some(m => m.sender === 'bot' && m.type === 'image')) return false;

  return !history.some(m => m.sender === 'bot' && m.type === 'audio' && now - whenSent(m) < ONE_DAY_MS);
}

/** Lo que se lee en voz alta: sin emojis, asteriscos ni enlaces. */
export function speakableText(text: string): string {
  return text
    .replace(/https?:\/\/\S+/g, '')
    .replace(/[*_~`]/g, '')
    .replace(/\p{Extended_Pictographic}️?/gu, '')
    .replace(/[ \t]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{2,}/g, '\n')
    .trim();
}
