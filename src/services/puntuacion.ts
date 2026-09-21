/**
 * Puntuación en español: toda pregunta abre con "¿". La IA a veces lo omite ("Cuéntame cómo te gustaría?"),
 * así que se completa por código. Función pura, para poder probarla.
 */

const INTERJECTION = /^(hola|claro|perfecto|listo|oye|entonces|bueno|dime|mira|ok|okey|genial|gracias)$/i;

/** Agrega "¿" al inicio de cada pregunta que cierra con "?" y no lo tiene. */
export function addOpeningQuestionMarks(text: string): string {
  return text.split('\n').map(fixLine).join('\n');
}

function fixLine(line: string): string {
  if (!line.includes('?') || /https?:\/\//.test(line)) return line;
  // Oraciones: se cortan después de . ! ? … seguidos de espacio; los puntos de los precios ($28.00) no cortan.
  const parts = line.split(/(?<=[.!?…\p{Extended_Pictographic}️])\s+/u);
  return parts.map(fixSentence).join(' ');
}

function fixSentence(sentence: string): string {
  const end = sentence.search(/\?+\s*[\p{Extended_Pictographic}️\s*_~]*$/u);
  if (end < 0) return sentence;
  const question = sentence.slice(0, end);
  if (question.includes('¿')) return sentence;
  // Inicio: después de emojis, viñetas y marcas de formato.
  const lead = sentence.match(/^[^\p{L}\p{N}¡]*/u)![0].length;
  let start = lead;
  // "Hola, cómo estás?" → la pregunta empieza después de la interjección.
  const comma = sentence.indexOf(',', lead);
  if (comma > lead && comma < end && INTERJECTION.test(sentence.slice(lead, comma).replace(/[*_~]/g, '').trim())) {
    start = comma + 1;
    while (sentence[start] === ' ') start++;
  }
  return sentence.slice(0, start) + '¿' + sentence.slice(start);
}
