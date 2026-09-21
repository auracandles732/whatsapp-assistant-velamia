/**
 * Muletillas: las exclamaciones de relleno ("Qué lindo", "Claro", "Perfecto"…) y las fórmulas repetidas dentro de un mismo
 * chat delatan a un robot. Una persona no abre 5 mensajes seguidos con "Qué lindo". Funciones puras, para poder probarlas.
 */

const normalize = (text: string) => text.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase();

// Lo que hace que un mensaje empiece con una exclamación de relleno.
const QUE_ADJETIVO = /^que (lindo|linda|lindos|lindas|bonito|bonita|bonitos|bonitas|bien|buena|bueno|buen|genial|hermoso|hermosa|precioso|preciosa|tierno|tierna|chevere|excelente|maravilloso|maravillosa|detalle|idea|elecci[oó]n|opci[oó]n|referencia|dise[nñ]o|delicia|belleza|emocion)/;

const RELLENOS: Array<[string, RegExp]> = [
  ['si claro', /^si,? (claro|por supuesto|con gusto|se puede)/],
  ['claro', /^claro/],
  ['perfecto', /^perfecto/],
  ['listo', /^listo/],
  ['entendido', /^entendido/],
  ['con gusto', /^(con (mucho )?gusto|con todo gusto)/],
  ['por supuesto', /^por supuesto/],
  ['muy bien', /^(muy bien|excelente|estupendo|genial|buenisimo)/],
  ['de acuerdo', /^(de acuerdo|dale|ok|okey|vale)\b/],
  ['gracias', /^(muchas )?gracias/]
];

/** Familia de la exclamación con que empieza el mensaje, o '' si empieza directo con la información. */
export function fillerOpening(text: string): string {
  const first = normalize(text).replace(/[*_~]/g, '').trim();
  // Solo el principio: hasta el primer signo o emoji.
  const head = first.replace(/^[¡¿\s]+/, '');
  if (QUE_ADJETIVO.test(head)) return 'que + adjetivo';
  for (const [key, pattern] of RELLENOS) if (pattern.test(head)) return key;
  return '';
}

/** Fórmulas de cortesía que se repiten sin aportar nada. Se comparan sin tildes. */
const FORMULAS: Array<[string, RegExp]> = [
  ['con gusto te ayudo', /con (mucho )?gusto te (ayudo|ayudare|apoyo)/],
  ['te comparto', /\bte comparto\b/],
  ['te muestro', /\bte muestro\b/],
  ['cuéntame', /\bcuentame\b/],
  ['un gusto / qué gusto', /\b(un|que) gusto\b/],
  ['así te ayudo', /\basi te ayudo\b|\bpara ayudarte mejor\b/],
  ['aquí estoy', /\b(aqui estoy|estoy aqui|quedo atenta|quedo pendiente|estoy para ayudarte)\b/],
  ['sin problema', /\bsin problema\b|\bno te preocupes\b/],
  ['qué lindo (dentro del texto)', /\bque (lindo|linda|bonito|bonita)\b/],
  ['va a quedar hermoso', /\b(va a|van a) quedar (hermos|precios|lind|divin|espectacul)/],
  ['me encanta', /\bme encanta\b/]
];

/** Fórmulas que aparecen en este texto. */
export function formulasIn(text: string): string[] {
  const t = normalize(text);
  return FORMULAS.filter(([, pattern]) => pattern.test(t)).map(([name]) => name);
}

export interface TicReport {
  /** Apertura de relleno repetida (vacío = bien). */
  opening: string;
  /** Por qué se considera repetida. */
  why: string;
  /** Fórmulas ya usadas hace poco que vuelven a aparecer. */
  formulas: string[];
  /** Lo que ya se usó en este chat, para decírselo a la IA. */
  used: { openings: string[]; formulas: string[] };
  violates: boolean;
}

/**
 * Compara la respuesta nueva con las últimas del asistente en el mismo chat.
 * Reglas: nunca la misma exclamación de relleno en las últimas 4, nunca dos rellenos seguidos, y como máximo
 * dos de cada cuatro respuestas pueden abrir con relleno. Las fórmulas de cortesía no se repiten en las últimas 5.
 */
export function ticsIn(reply: string, previousReplies: string[]): TicReport {
  const recent = previousReplies.filter(r => r && r.trim()).slice(-5);
  const lastFour = recent.slice(-4);
  const openings = lastFour.map(fillerOpening);
  const usedFormulas = [...new Set(recent.flatMap(formulasIn))];

  const opening = fillerOpening(reply);
  let why = '';
  if (opening) {
    if (openings.includes(opening)) why = `ya abriste con "${opening}" hace poco`;
    else if (openings[openings.length - 1]) why = 'el mensaje anterior también abrió con una exclamación de relleno';
    else if (openings.filter(Boolean).length >= 2) why = 'ya usaste varias exclamaciones de relleno en los últimos mensajes';
  }

  // "Que lindo" dentro del texto cuenta como fórmula; para no duplicar el reporte no se cuenta si ya es la apertura.
  const nowFormulas = formulasIn(reply).filter(f => !(opening && f === 'qué lindo (dentro del texto)'));
  const formulas = nowFormulas.filter(f => usedFormulas.includes(f));

  return {
    opening: why ? opening : '',
    why,
    formulas,
    used: { openings: [...new Set(openings.filter(Boolean))], formulas: usedFormulas },
    violates: Boolean(why) || formulas.length > 0
  };
}

/**
 * Última defensa: si la respuesta abre con una exclamación de relleno aislada ("Qué lindo 💕 …", "Claro, …") y sigue
 * repitiéndola, se quita y el mensaje empieza directo. Si la exclamación es parte de la frase ("Qué lindo va a quedar"), no se toca.
 */
export function stripFillerOpening(text: string): string {
  const lead = /^\s*(¡)?(qu[eé] [\p{L}]+( [\p{L}]+)?|claro( que s[ií])?|perfecto|listo|entendido|con (mucho )?gusto|por supuesto|s[ií],? (claro|por supuesto|con gusto)|muy bien|genial|excelente)\s*(!|,|\.|…|\p{Extended_Pictographic}️?|\n)+\s*/iu;
  const match = text.match(lead);
  if (!match) return text;
  const rest = text.slice(match[0].length).replace(/^[\s\p{Extended_Pictographic}️]+/u, '');
  if (rest.length < 12) return text;
  return rest.charAt(0).toUpperCase() + rest.slice(1);
}

/**
 * Quita los caracteres rotos (mitades de emoji que quedan al recortar un texto por la mitad). JavaScript los acepta,
 * pero el servidor de OpenAI rechaza el mensaje completo con "Invalid body: failed to parse JSON".
 */
export function withoutBrokenChars(text: string): string {
  return text.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '');
}
