import axios from 'axios';
import { getAllProducts, getConfig, setConfig, updateProduct, supabase, tenantOp, tenantValue } from '../services/supabase';
import { uploadBufferToStorage } from '../services/storage';
import { profile } from '../config/businessProfile';
import { socialAi, track, isStopError } from './ai';
import { renderPoster } from './template';
import { productKey } from '../services/openai';
import { toJpeg, toJpegMax, isOwnStorageUrl } from './images';
import { getSupplierSettings, getSupplierProduct, SupplierProduct, SupplierSettings, addSupplierProductsToCatalog, discardAsDuplicate } from './suppliers';

/**
 * Lo que pasa con cada modelo de un PDF de proveedor, en segundo plano:
 *   0. ¿Ya lo tiene la empresa? La IA compara la foto del modelo con las del Catálogo (la empresa sube sus propios
 *      diseños a mano y el nombre casi nunca coincide). Si ya lo tiene, no entra al Catálogo ni se le hace foto: queda
 *      "ya lo tienes" (la empresa puede decir "no es el mismo"). Si es nuevo, entra al Catálogo con su precio.
 * Y, si la empresa lo pide, la foto con su diseño. El PDF trae fotos simples (fondo blanco); la empresa vende con
 * afiches: título grande, precio, frases, franja de "pedidos bajo reserva"…
 *   1. La IA de imágenes del agente (su clave, gpt-image-2) arma el afiche copiando el estilo de dos fotos del Catálogo
 *      de la empresa, con la vela del PDF tal cual, el nombre y el precio según su tamaño.
 *   2. La IA de texto lee el afiche y revisa que el nombre y el precio estén bien escritos y que no haya textos
 *      inventados (otros precios, palabras raras). Si algo salió mal, se hace otra vez; si vuelve a fallar queda
 *      "para revisar" y no se usa sola.
 *   3. El afiche pasa a ser la foto del producto en el Catálogo (la foto original del PDF se conserva en el modelo).
 * Se trabaja en segundo plano (un afiche tarda cerca de un minuto); el avance se guarda por catálogo.
 */

/**
 * cola: esperando · revisando: comparando con el Catálogo · repetido: ya lo tenía · nuevo: revisado, sin foto propia ·
 * creando / lista / revisar / error: la foto con el diseño.
 */
export type PosterStatus = 'cola' | 'revisando' | 'repetido' | 'nuevo' | 'creando' | 'lista' | 'revisar' | 'error';
export interface PosterState {
  status: PosterStatus;
  url?: string;
  detail?: string;
  at: string;
  /** Ya se comparó con el Catálogo. */
  checked?: boolean;
  /** Se le hace la foto con el diseño. */
  poster?: boolean;
  /** El producto del Catálogo que ya era este modelo. */
  match?: { id: string; name: string; image_url: string };
  /** La empresa dijo "no es el mismo": no se vuelve a comparar. */
  keep?: boolean;
}

/** Lo que cuesta cada afiche con gpt-image-2 en calidad media (medido: ~4.000 tokens de entrada y ~1.750 de salida). */
export const POSTER_COST = 0.08;
const WORKERS = 3;
// Hasta 3 intentos: el diseño tiene que quedar igual al de la empresa, y a veces la IA de imágenes se desvía.
// Cada intento es una foto nueva (lo más caro): dos como mucho; si ninguna pasa, queda "para revisar".
const TRIES = 2;
const stateKey = (catalogId: string) => `supplier_posters_${catalogId}`;

// ---------- Avance por catálogo (se guarda en la configuración: no hace falta otra tabla) ----------

const memory = new Map<string, Record<string, PosterState>>();
const writes = new Map<string, Promise<void>>();
const running = new Set<string>();
const scope = (catalogId: string) => `${tenantValue() ?? 'velamia'}:${catalogId}`;

export async function posterStates(catalogId: string): Promise<Record<string, PosterState>> {
  const cached = memory.get(scope(catalogId));
  if (cached) return cached;
  try {
    const raw = await getConfig(stateKey(catalogId));
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

export const postersRunning = (catalogId: string) => running.has(scope(catalogId));

/** Cambia el estado de un modelo (lo demás se conserva); las escrituras van en fila para que dos a la vez no se pisen. */
async function setState(catalogId: string, productId: string, state: Partial<Omit<PosterState, 'at'>>) {
  const key = scope(catalogId);
  const states = memory.get(key) || await posterStates(catalogId);
  states[productId] = { ...states[productId], ...state, at: new Date().toISOString() } as PosterState;
  memory.set(key, states);
  const previous = writes.get(key) || Promise.resolve();
  const next = previous.then(() => setConfig(stateKey(catalogId), JSON.stringify(states))).catch(error => console.warn('⚠️ No se guardó el avance de los afiches:', error.message));
  writes.set(key, next);
  await next;
}

export async function clearPosterStates(catalogId: string) {
  memory.delete(scope(catalogId));
  await setConfig(stateKey(catalogId), '{}').catch(() => {});
}

// ---------- Textos del afiche ----------

// Palabras que no son la ocasión ("MOLDES NAVIDAD" → "NAVIDAD").
const NOT_OCCASION = /\b(MOLDES?|VELAS?|CAT[AÁ]LOGOS?|MODELOS?|PROVEEDOR(ES)?|COLECCI[OÓ]N|NUEVOS?|\d{2,4})\b/g;

/** La ocasión del catálogo para la cinta del afiche: "UN DETALLE ESPECIAL PARA NAVIDAD". */
export function occasionOf(category: string): string {
  const clean = String(category || '').toUpperCase().replace(NOT_OCCASION, ' ').replace(/\s+/g, ' ').trim();
  return clean || 'TI';
}

/** Lo que dicen los afiches de la empresa: se lee de su foto de referencia para copiarlos igual. */
export interface ReferenceTexts {
  cinta: string;
  iconos: string[];
  franja: string;
  franjaPequena: string;
  etiquetaPrecio: string;
  /** El diseño del afiche descrito con precisión (posiciones, letras, colores, íconos) para copiarlo igual. */
  diseno?: string;
}

export const DEFAULT_REFERENCE_TEXTS: ReferenceTexts = {
  cinta: '',
  iconos: ['DISEÑO DECORATIVO', 'IDEAL PARA REGALAR', 'ELABORADAS BAJO PEDIDO'],
  franja: 'PEDIDOS BAJO RESERVA',
  franjaPequena: 'Asegura tu pedido con anticipación',
  etiquetaPrecio: '',
  diseno: ''
};

/** El diseño de los afiches de VELAMIA, por si no se pudo leer el de la referencia. */
const DEFAULT_DESIGN = 'Square poster. Left column: title in huge heavy bold sans-serif capital letters with a gold-to-brown metallic gradient, a small gold Christmas-tree ornament with two lines above it; a gold ribbon banner with pointed ends and white capital text under the title, with a small gold sparkle on each side; a white rounded price box with a thin gold border containing a huge bold dark-brown/gold "$" price and, under it, a gold-brown rounded label with white bold capital text; optionally a white rounded pill with thin gold border for the unit price; three rows, each with a round gold-brown circle containing a white line icon (gift, heart, calendar) and dark-brown bold capital text at its right, separated by thin gold lines. Bottom: a full-width brown-gold band with a white padlock-with-heart icon, a thin vertical white line, white bold capital text and a smaller white line under it, and white snowflakes at both ends. Right half: the product large and centered, on a soft light surface, over a warm golden bokeh background with pine branches, gold ornaments and gift boxes.';

export interface PosterTexts { title: string; price: number; unit: string; unitPrice: number; ribbon: string; features: string[]; band: string; bandSmall: string }

/** La cinta: la de la referencia si es de la misma ocasión; si no, la misma frase con la ocasión nueva. */
export function ribbonFor(refRibbon: string, refOccasion: string, occasion: string): string {
  const ribbon = String(refRibbon || '').replace(/\s+/g, ' ').trim().toUpperCase();
  if (!ribbon) return `UN DETALLE ESPECIAL PARA ${occasion}`;
  if (!refOccasion || refOccasion === occasion) return ribbon;
  if (ribbon.includes(refOccasion)) return ribbon.replace(refOccasion, occasion);
  return `UN DETALLE ESPECIAL PARA ${occasion}`;
}

const cleanText = (text: unknown, max = 60) => String(text || '').replace(/\s+/g, ' ').trim().slice(0, max);

/**
 * Los textos del afiche nuevo: el nombre y el precio del modelo y, lo demás (cinta, íconos, franja, cómo se escribe la
 * unidad), igual que en el afiche de referencia de la empresa.
 */
export function posterTexts(name: string, price: number, category: string, unit = profile().sales.unitSingular,
  reference: Partial<ReferenceTexts> & { occasion?: string } = {}, unitPrice = 0): PosterTexts {
  const occasion = occasionOf(category);
  // Con la referencia leída se copia tal cual: si el afiche de la empresa no tiene franja abajo, el nuevo tampoco.
  const read = !!(reference.cinta || reference.iconos?.length || reference.franja || reference.franjaPequena);
  const band = read ? cleanText(reference.franja, 40).toUpperCase() : DEFAULT_REFERENCE_TEXTS.franja;
  const icons = (Array.isArray(reference.iconos) ? reference.iconos : []).map(x => cleanText(x, 40).toUpperCase())
    .filter(x => x && !(band && sameText(x, band)));
  return {
    title: cleanText(name, 80).toUpperCase(),
    price,
    unit: (cleanText(reference.etiquetaPrecio, 30) || String(unit || 'unidad')).toUpperCase(),
    unitPrice: unitPrice > 0 ? unitPrice : 0,
    ribbon: ribbonFor(cleanText(reference.cinta, 80), reference.occasion || '', occasion),
    features: icons.length >= 2 ? icons.slice(0, 4) : DEFAULT_REFERENCE_TEXTS.iconos,
    band,
    bandSmall: read ? cleanText(reference.franjaPequena, 60) : DEFAULT_REFERENCE_TEXTS.franjaPequena
  };
}

const money = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(2));

export function posterPrompt(t: PosterTexts, occasion: string, design = '', instructions = ''): string {
  const owner = instructions.trim();
  return `Create a square 1:1 advertising poster for a handmade candle shop.
The FIRST image is the candle to sell. Every image after it is a REAL poster of this shop: the new poster must look like one more poster of the same series. Replicate that design exactly — the same layout and positions, the same fonts, the same text colors and gradients, the same ribbon, the same price box, the same round icons with their texts, the same bottom band, the same lighting and the same kind of decorated bokeh background. Do not change the font, the colors of the title or the order of the elements, and do not add or remove elements. Change only the candle, the texts listed below and, if needed, the background theme so it fits the occasion "${occasion}".
The shop's design, described: ${design || DEFAULT_DESIGN}`
    + `
Place the candle from the FIRST image where the shop's posters place their product, large and well lit. Reproduce that candle faithfully: same shape, colors, face, details and proportions; do not redesign it. Show it with a short white unlit cotton wick.
Write exactly these Spanish texts and nothing else:
- Title: "${t.title}"
- Ribbon: "${t.ribbon}"
- Price box: "$${money(t.price)}" and under it "${t.unit}"
${t.unitPrice > 0 ? `- Under the price box, a small rounded pill: "UNIDAD $${money(t.unitPrice)}"\n` : ''}- Icons: "${t.features.join('", "')}"
${t.band ? `- Bottom band: "${t.band}"${t.bandSmall ? ` and smaller "${t.bandSmall}"` : ''}` : t.bandSmall ? `- Closing line where the shop's posters put it: "${t.bandSmall}"` : ''}
No other text${t.unitPrice > 0 ? '' : ', no unit price pill'}, no second price, no logos, no watermarks. Spelling must be exact, including accents and Ñ.`
    + (owner ? `

THE SHOP OWNER'S OWN INSTRUCTIONS FOR THIS PHOTO (written in Spanish). They have the HIGHEST PRIORITY: follow every one of them exactly, even where they differ from the design description or the reference posters above (if they ask for a change, a different element or an extra text, do it; keep the price and title exact):
"""
${owner}
"""` : '');
}

/** Para comparar textos: mayúsculas, sin espacios repetidos ni tildes, pero la Ñ cuenta. */
export function sameText(a: string, b: string): boolean {
  const norm = (s: string) => String(s || '').toUpperCase().replace(/Ñ/g, '\u0001').normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/\u0001/g, 'Ñ').replace(/[^A-Z0-9Ñ#$.]+/g, ' ').trim();
  return norm(a) === norm(b);
}

export interface PosterReading {
  /** ¿Cumple las instrucciones que escribió la empresa? (sin instrucciones, true) */
  instruccionesCumplidas?: boolean;
  faltaInstrucciones?: string;
  titulo: string;
  precio: string;
  etiquetaPrecio: string;
  precioUnidad?: string;
  otrosPrecios: string[];
  errores: string[];
  /** ¿Sigue el diseño del afiche de referencia de la empresa? */
  disenoIgual?: boolean;
  diferenciasDiseno?: string;
  /** ¿La vela es la misma de la foto del PDF? */
  velaIgual?: boolean;
  diferenciasVela?: string;
}

const amount = (text: unknown) => Number(String(text || '').replace(/[^\d.,]/g, '').replace(',', '.'));

/** Qué salió mal en un afiche revisado por la IA ('' = todo bien). */
export function posterProblem(reading: PosterReading, t: PosterTexts): string {
  if (reading.velaIgual === false) return `La vela no quedó igual a la del PDF${reading.diferenciasVela ? `: ${reading.diferenciasVela}` : ''}`;
  if (reading.instruccionesCumplidas === false) return `No siguió tus instrucciones${reading.faltaInstrucciones ? `: ${reading.faltaInstrucciones}` : ''}`;
  if (reading.disenoIgual === false) return `No sigue el diseño de tus fotos${reading.diferenciasDiseno ? `: ${reading.diferenciasDiseno}` : ''}`;
  if (!sameText(reading.titulo, t.title)) return `El nombre salió "${reading.titulo}" en vez de "${t.title}"`;
  if (!(Math.abs(amount(reading.precio) - t.price) < 0.01)) return `El precio salió "${reading.precio}" en vez de $${money(t.price)}`;
  const unit = String(reading.precioUnidad || '').trim();
  if (t.unitPrice > 0 && !(Math.abs(amount(unit) - t.unitPrice) < 0.01)) return `El precio por unidad salió "${unit || 'sin poner'}" en vez de $${money(t.unitPrice)}`;
  if (!(t.unitPrice > 0) && unit) return `Apareció un precio por unidad que no va: ${unit}`;
  const others = (reading.otrosPrecios || []).filter(p => !(t.unitPrice > 0 && Math.abs(amount(p) - t.unitPrice) < 0.01));
  if (others.length) return `Apareció otro precio: ${others.join(', ')}`;
  if ((reading.errores || []).length) return `Textos mal escritos o inventados: ${reading.errores.slice(0, 3).join(', ')}`;
  return '';
}

// ---------- IA ----------

async function download(url: string): Promise<Buffer> {
  if (!isOwnStorageUrl(url)) throw new Error('La foto no está en el almacenamiento propio');
  try {
    const { data } = await axios.get(url, { responseType: 'arraybuffer', timeout: 60_000, maxContentLength: 15 * 1024 * 1024 });
    return Buffer.from(data);
  } catch (error: any) {
    const status = error?.response?.status;
    throw new Error(status === 400 || status === 404 ? 'Esa foto ya no existe en el almacenamiento' : `No se pudo abrir una foto (${error.message})`);
  }
}

// Fotos que se le muestran a la IA: las manda el servidor (achicadas), nunca la dirección. Así la IA no depende de que
// el almacenamiento sea público y no se descarga lo mismo varias veces (los parecidos del Catálogo se repiten).
const seen = new Map<string, Promise<string>>();
const SEEN_MAX = 300;
export function imageForAi(url: string, maxSide = 1024): Promise<string> {
  const key = `${maxSide}:${url}`;
  let found = seen.get(key);
  if (!found) {
    found = download(url).then(buffer => `data:image/jpeg;base64,${toJpegMax(buffer, maxSide).toString('base64')}`);
    found.catch(() => seen.delete(key));
    if (seen.size >= SEEN_MAX) seen.delete(seen.keys().next().value as string);
    seen.set(key, found);
  }
  return found;
}

/** refs ya en JPG (se convierten una vez por tanda). */
async function drawPoster(model: Buffer, refs: Buffer[], t: PosterTexts, occasion: string, design = '', instructions = ''): Promise<Buffer> {
  const ai = await socialAi();
  const form = new FormData();
  form.append('model', ai.imageModel);
  form.append('prompt', posterPrompt(t, occasion, design, instructions));
  form.append('size', '1024x1024');
  form.append('quality', ai.imageQuality);
  [toJpeg(model), ...refs].forEach((buffer, i) => form.append('image[]', new Blob([buffer], { type: 'image/jpeg' }), `foto${i}.jpg`));
  const response = await fetch('https://api.openai.com/v1/images/edits', { method: 'POST', headers: { Authorization: `Bearer ${ai.client.apiKey}` }, body: form });
  const data: any = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data?.error?.message || `OpenAI respondió ${response.status}`);
  track(ai.imageModel, data.usage);
  const b64 = data?.data?.[0]?.b64_json;
  if (!b64) throw new Error('La IA no devolvió la foto');
  return toJpeg(Buffer.from(b64, 'base64'));
}

/**
 * Revisión del afiche nuevo (con el modelo más preciso): lee los textos y precios, y lo compara con el afiche de
 * referencia de la empresa (¿mismo diseño?) y con la foto del PDF (¿la misma vela?).
 */
async function readPoster(jpegBuffer: Buffer, t: PosterTexts, referenceUrl: string, modelUrl: string, instructions = ''): Promise<PosterReading> {
  const owner = instructions.trim();
  const ai = await socialAi();
  const expected = [t.title, t.ribbon, `$${money(t.price)}`, t.unit, ...(t.unitPrice > 0 ? [`UNIDAD $${money(t.unitPrice)}`] : []), ...t.features, ...(t.band ? [t.band] : []), ...(t.bandSmall ? [t.bandSmall] : [])];
  const response = await ai.client.chat.completions.create({
    model: COMPARE_MODEL,
    ...(/^(gpt-5|o\d)/.test(COMPARE_MODEL) ? { reasoning_effort: 'low' } : {}),
    max_completion_tokens: 3000,
    response_format: {
      type: 'json_schema',
      json_schema: {
        name: 'revision',
        strict: true,
        schema: {
          type: 'object',
          additionalProperties: false,
          required: ['titulo', 'precio', 'etiquetaPrecio', 'precioUnidad', 'otrosPrecios', 'errores', 'disenoIgual', 'diferenciasDiseno', 'velaIgual', 'diferenciasVela', 'instruccionesCumplidas', 'faltaInstrucciones'],
          properties: {
            instruccionesCumplidas: { type: 'boolean' },
            faltaInstrucciones: { type: 'string' },
            titulo: { type: 'string' },
            precio: { type: 'string' },
            etiquetaPrecio: { type: 'string' },
            precioUnidad: { type: 'string' },
            otrosPrecios: { type: 'array', items: { type: 'string' } },
            errores: { type: 'array', items: { type: 'string' } },
            disenoIgual: { type: 'boolean' },
            diferenciasDiseno: { type: 'string' },
            velaIgual: { type: 'boolean' },
            diferenciasVela: { type: 'string' }
          }
        }
      }
    },
    messages: [{
      role: 'user',
      content: [
        { type: 'text', text: `Foto 1: un afiche nuevo hecho por IA. Foto 2: un afiche real de la tienda (el diseño que había que copiar). Foto 3: la vela del proveedor que debía aparecer.
Revisa el afiche nuevo (foto 1) con mucho cuidado:
- "titulo": el nombre grande del producto, letra por letra tal como está escrito.
- "precio": el precio grande tal cual (con $). "etiquetaPrecio": lo que dice debajo del precio.
- "precioUnidad": el precio por unidad si aparece (por ejemplo "$5"); si no aparece, "".
- "otrosPrecios": cualquier otro precio o monto.
- "errores": cada texto mal escrito, deformado o que no sea uno de estos: ${expected.map(x => `"${x}"`).join(', ')}.
- "disenoIgual": ¿parece un afiche más de la misma serie que la foto 2? Debe tener la misma disposición y orden de los elementos (título grande, cinta, recuadro de precio con su etiqueta, íconos con textos, franja inferior), el mismo tipo de letra, los mismos colores del título, la cinta y el recuadro de precio, el mismo estilo de íconos y la misma cantidad de elementos. El tema del fondo puede cambiar con la ocasión. false si cambia la letra, los colores del título, el orden o la posición de los elementos, o si sobra o falta algo (por ejemplo un ícono de más); di en "diferenciasDiseno" qué cambia.
- "velaIgual": ¿la vela del afiche es la misma de la foto 3? Ignora la mecha y la llama (en el afiche va apagada a propósito), la luz, el tamaño y pequeños cambios de tono por la iluminación. false solo si cambia la figura o la forma, faltan partes o hay partes inventadas; di en "diferenciasVela" qué cambia.
${owner
    ? `- La dueña de la tienda escribió cómo quiere sus fotos: """${owner}""". "instruccionesCumplidas": ¿el afiche nuevo cumple TODAS esas instrucciones? false si alguna no se cumple; di en "faltaInstrucciones" cuál, en pocas palabras. Lo que pidan esas instrucciones manda sobre la foto 2: una diferencia con la foto 2 que las instrucciones piden no cuenta en "disenoIgual", y los textos que ellas pidan no son "errores".`
    : '- "instruccionesCumplidas": true. "faltaInstrucciones": "".'}` },
        { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${jpegBuffer.toString('base64')}`, detail: 'high' } },
        { type: 'image_url', image_url: { url: await imageForAi(referenceUrl), detail: 'high' } },
        { type: 'image_url', image_url: { url: await imageForAi(modelUrl), detail: 'high' } }
      ]
    }]
  } as any);
  track(COMPARE_MODEL, response.usage);
  return JSON.parse(response.choices[0]?.message?.content || '{}');
}

// v2: además de los textos, la descripción del diseño (y los íconos sin la franja).
const REFERENCE_TEXTS_KEY = 'poster_reference_texts_v2';

/** Lee (una vez, luego se recuerda) los textos fijos del afiche de referencia de la empresa: cinta, íconos, franja… */
async function referenceTexts(url: string): Promise<Partial<ReferenceTexts>> {
  let cache: Record<string, ReferenceTexts> = {};
  try { cache = JSON.parse((await getConfig(REFERENCE_TEXTS_KEY)) || '{}'); } catch { cache = {}; }
  if (cache[url]) return cache[url];
  try {
    const ai = await socialAi();
    const response = await ai.client.chat.completions.create({
      model: ai.textModel,
      ...(/^(gpt-5|o\d)/.test(ai.textModel) ? { reasoning_effort: 'low' } : {}),
      max_completion_tokens: 1500,
      response_format: {
        type: 'json_schema',
        json_schema: {
          name: 'textos',
          strict: true,
          schema: {
            type: 'object',
            additionalProperties: false,
            required: ['cinta', 'iconos', 'franja', 'franjaPequena', 'etiquetaPrecio', 'diseno'],
            properties: {
              cinta: { type: 'string' }, iconos: { type: 'array', items: { type: 'string' } }, franja: { type: 'string' },
              franjaPequena: { type: 'string' }, etiquetaPrecio: { type: 'string' }, diseno: { type: 'string' }
            }
          }
        }
      },
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: 'Este es un afiche de una tienda de velas. Copia, letra por letra, sus textos fijos (los que no son el nombre del producto ni los precios): "cinta" = la frase de la cinta o banda bajo el título; "iconos" = solo el texto que va junto a cada ícono redondo o viñeta, en orden (no incluyas la franja de abajo); "franja" = el texto grande de la franja de abajo del todo; "franjaPequena" = el texto chico de esa franja; "etiquetaPrecio" = lo que dice junto al precio grande (por ejemplo "DOCENA" o "POR DOCENA"). Lo que no exista va vacío. Además, "diseno": en inglés, describe con precisión el diseño para que un diseñador lo copie igual en otro afiche: posición de cada elemento (título, cinta, recuadro de precio, píldora de unidad si hay, íconos, franja de abajo, producto), tipo de letra (grosor, estilo), colores y degradados de cada texto y recuadro, formas y bordes, qué dibujo tiene cada ícono y cómo es el fondo. No describas el producto.' },
          { type: 'image_url', image_url: { url: await imageForAi(url), detail: 'high' } }
        ]
      }]
    } as any);
    track(ai.textModel, response.usage);
    const read = JSON.parse(response.choices[0]?.message?.content || '{}');
    const texts: ReferenceTexts = {
      cinta: cleanText(read.cinta, 80),
      iconos: (Array.isArray(read.iconos) ? read.iconos : []).map((x: unknown) => cleanText(x, 40)).filter(Boolean).slice(0, 4),
      franja: cleanText(read.franja, 40),
      franjaPequena: cleanText(read.franjaPequena, 60),
      etiquetaPrecio: cleanText(read.etiquetaPrecio, 30),
      diseno: String(read.diseno || '').replace(/\s+/g, ' ').trim().slice(0, 1500)
    };
    cache[url] = texts;
    await setConfig(REFERENCE_TEXTS_KEY, JSON.stringify(cache)).catch(() => {});
    return texts;
  } catch (error: any) {
    console.warn('⚠️ No se pudieron leer los textos del afiche de referencia:', error.message);
    return {};
  }
}

// ---------- Fotos de referencia ----------

const words = (text: string) => occasionOf(text).split(' ').filter(w => w.length > 2 && w !== 'TI');

/**
 * Dos fotos del Catálogo de la empresa para copiar el estilo: las suyas (no las que vinieron de un PDF), primero las
 * de la misma ocasión (MOLDES NAVIDAD → NAVIDAD) y, si no hay, las más recientes.
 */
export function pickReferences(category: string, catalog: any[], fromPdf: Set<string>): string[] {
  return pickReferenceProducts(category, catalog, fromPdf).map(p => p.image_url);
}

export function pickReferenceProducts(category: string, catalog: any[], fromPdf: Set<string>): any[] {
  const own = catalog.filter(p => p.image_url && isOwnStorageUrl(p.image_url) && !fromPdf.has(p.id));
  const wanted = words(category);
  const score = (p: any) => words(String(p.category || '')).filter(w => wanted.includes(w)).length;
  const sorted = [...own].sort((a, b) => score(b) - score(a) || String(b.created_at || '').localeCompare(String(a.created_at || '')));
  const picked: any[] = [];
  for (const p of sorted) if (!picked.some(x => x.image_url === p.image_url) && picked.length < 2) picked.push(p);
  return picked;
}

// ---------- ¿Ya lo tiene la empresa? ----------

// Palabras que no ayudan a encontrar el mismo producto.
const NAME_NOISE = new Set(['VELA', 'VELAS', 'DEL', 'LOS', 'LAS', 'CON', 'PARA', 'MINI', 'GRANDE', 'PEQUENA', 'MEDIANA']);
const nameWords = (name: string) => String(name || '').toUpperCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^A-Z ]+/g, ' ')
  .split(' ').filter(w => w.length > 2 && !NAME_NOISE.has(w));

/**
 * Productos del Catálogo con los que comparar un modelo: los de la misma ocasión (MOLDES NAVIDAD → NAVIDAD) y los que
 * comparten alguna palabra del nombre (RENO, GNOMO…), hasta 20. Nunca los que entraron desde este mismo PDF.
 */
export function duplicateCandidates(model: { name: string }, category: string, catalog: any[], exclude: Set<string>, max = 20): any[] {
  const wantedCategory = words(category);
  const wantedName = nameWords(model.name);
  const score = (p: any) => 2 * nameWords(p.name).filter(w => wantedName.includes(w)).length + words(String(p.category || '')).filter(w => wantedCategory.includes(w)).length;
  return catalog
    .filter(p => p.image_url && !exclude.has(p.id))
    .map(p => ({ p, score: score(p) }))
    .filter(x => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, max)
    .map(x => x.p);
}

const reasoning = (model: string) => (/^(gpt-5|o\d)/.test(model) ? { reasoning_effort: 'low' } : {});
const jsonSchema = (name: string, properties: Record<string, unknown>) => ({
  type: 'json_schema',
  json_schema: { name, strict: true, schema: { type: 'object', additionalProperties: false, required: Object.keys(properties), properties } }
});

/**
 * ¿La empresa ya vende esta vela? En dos pasos:
 *   1. Entre los parecidos del Catálogo (fotos chicas), la IA elige hasta dos que podrían ser la misma vela.
 *   2. Mira cada par en grande y confirma que es el mismo molde (sameMold). Dos gnomos o dos Papá Noel distintos no
 *      cuentan, pero sí se aceptan pequeñas diferencias de dibujo (los afiches son la vela redibujada).
 */
async function findExisting(model: SupplierProduct, allCandidates: any[]): Promise<{ id: string; name: string; image_url: string } | null> {
  // Solo fotos del almacenamiento propio (el servidor las descarga para mostrárselas a la IA).
  const candidates = allCandidates.filter(c => isOwnStorageUrl(c.image_url));
  if (candidates.length === 0 || !model.image_url) return null;
  // Un producto cuya foto no se puede descargar se salta (no detiene la revisión).
  const loaded = await Promise.allSettled(candidates.map(async c => ({ ...c, data: await imageForAi(c.image_url, 512) })));
  const shown = loaded.flatMap(r => (r.status === 'fulfilled' ? [r.value] : []));
  if (shown.length === 0) return null;
  const ai = await socialAi();
  const pick = await ai.client.chat.completions.create({
    model: ai.textModel,
    ...reasoning(ai.textModel),
    max_completion_tokens: 1500,
    response_format: jsonSchema('comparacion', { posibles: { type: 'array', items: { type: 'integer' } } }),
    messages: [{
      role: 'user',
      content: [
        { type: 'text', text: `La foto 0 es una vela del catálogo de un proveedor. Las fotos 1 a ${shown.length} son productos que la tienda ya vende: suelen ser afiches con textos, precio y otro fondo, y la vela puede tener otro color. ¿Cuáles podrían ser la misma vela (la misma figura)? Pon en "posibles" hasta 2 números, del más parecido al menos; vacío si ninguna se le parece. Después se revisa cada una con calma.` },
        { type: 'image_url', image_url: { url: await imageForAi(model.image_url, 512), detail: 'low' } },
        ...shown.map(c => ({ type: 'image_url', image_url: { url: c.data, detail: 'low' } }))
      ]
    }]
  } as any);
  track(ai.textModel, pick.usage);
  const picked: unknown[] = JSON.parse(pick.choices[0]?.message?.content || '{}').posibles || [];
  const options = [...new Set(picked.map(Number))].filter(i => Number.isInteger(i) && i >= 1 && i <= shown.length).slice(0, 2).map(i => shown[i - 1]);
  if (options.length === 0) console.log(`🔁 ${model.name}: nada parecido en el Catálogo (${candidates.length} revisados)`);
  for (const found of options) {
    // Dos confirmaciones seguidas: descartar de más es peor (quita un producto nuevo del Catálogo) y la IA a veces duda.
    const same = await sameMold(model.image_url, found.image_url) && await sameMold(model.image_url, found.image_url);
    console.log(`🔁 ${model.name}: ¿es ${found.name}? ${same ? "sí, ya lo tiene" : "no"}`);
    if (same) return { id: found.id, name: found.name, image_url: found.image_url };
  }
  return null;
}

/**
 * Modelo para confirmar si dos velas son el mismo molde. Con el catálogo real MOLDES NAVIDAD (92 modelos), luna confundió
 * 5 de 14: otros hombres de jengibre, otro árbol, otro Papá Noel; terra acertó 34 de 34 en esos casos difíciles. Cuesta
 * cerca de un centavo por comparación (dos si parece repetido); lo demás del agente sigue con el modelo de Cerebro IA.
 */
export const COMPARE_MODEL = 'gpt-5.6-terra';

/**
 * Segundo paso: ¿estas dos fotos muestran el mismo molde? La IA describe cada vela por separado (gorro, cara, brazos,
 * piernas, adornos) y recién después compara: así no confunde dos Papá Noel distintos.
 */
export async function sameMold(modelUrl: string, productUrl: string): Promise<boolean> {
  const ai = await socialAi();
  const confirm = await ai.client.chat.completions.create({
    model: COMPARE_MODEL,
    ...reasoning(COMPARE_MODEL),
    max_completion_tokens: 2000,
    response_format: jsonSchema('confirmacion', { proveedor: { type: 'string' }, afiche: { type: 'string' }, mismoMolde: { type: 'boolean' } }),
    messages: [{
      role: 'user',
      content: [
        { type: 'text', text: `La primera foto es una vela de un proveedor. La segunda es un afiche de una tienda hecho con la foto de una vela: puede estar redibujada, con otro color, otra luz, otro fondo y textos encima (eso no importa).
Primero describe cada vela por separado, en pocas palabras: qué figura es; su gorro o sombrero (forma); su cara (qué se ve); brazos y manos (posición y qué sostienen); piernas o base; adornos en relieve.
Después decide: "mismoMolde" = true solo si es la misma figura y coinciden la forma del gorro, la postura de brazos y piernas y los adornos principales. Diferencias pequeñas de dibujo no cuentan; un personaje del mismo tema pero con otra forma (otro gnomo, otro Papá Noel) no es el mismo.` },
        { type: 'image_url', image_url: { url: await imageForAi(modelUrl), detail: 'high' } },
        { type: 'image_url', image_url: { url: await imageForAi(productUrl), detail: 'high' } }
      ]
    }]
  } as any);
  track(COMPARE_MODEL, confirm.usage);
  return JSON.parse(confirm.choices[0]?.message?.content || '{}').mismoMolde === true;
}

// ---------- Trabajo en segundo plano ----------

interface Job { model: SupplierProduct; texts: PosterTexts; occasion: string; price: number; unitPrice: number; instructions?: string }

/**
 * ¿Cambió el modelo mientras se hacía su foto (tamaño, nombre o el precio de la regla)? Entonces la foto dice datos viejos
 * y no se guarda. Sin efectos, para poder probarla.
 */
export function posterIsStale(job: Pick<Job, 'model' | 'price' | 'unitPrice'>, now: Pick<SupplierProduct, 'name' | 'size'> | null, settings: Pick<SupplierSettings, 'sizePrices' | 'unitPrices'>): boolean {
  if (!now) return true;
  return now.name !== job.model.name || now.size !== job.model.size
    || (settings.sizePrices[now.size] || 0) !== job.price
    || (settings.unitPrices?.[now.size] || 0) !== job.unitPrice;
}
interface References { buffers: Buffer[]; urls: string[]; design?: string }

/**
 * Hace la foto con el diseño de la empresa, la revisa y, si está bien, el modelo entra al Catálogo con ella (o, si ya
 * estaba, se le cambia la foto). Si no pasa la revisión dos veces, queda "para revisar" y NO entra: nunca va al
 * Catálogo una foto sin el diseño de la empresa.
 */
async function makeOne(catalogId: string, job: Job, refs: References) {
  const { model, texts, occasion } = job;
  try {
    const photo = await download(model.image_url);
    let last: { url: string; problem: string } | null = null;
    for (let attempt = 1; attempt <= TRIES; attempt++) {
      const poster = await drawPoster(photo, refs.buffers, texts, occasion, refs.design, job.instructions);
      const problem = posterProblem(await readPoster(poster, texts, refs.urls[0], model.image_url, job.instructions), texts);
      const url = await uploadBufferToStorage(poster, 'image/jpeg', 'product-images');
      last = { url, problem };
      if (!problem) break;
      console.warn(`⚠️ Afiche de ${texts.title} (intento ${attempt}): ${problem}`);
    }
    if (!last) return;
    // Si mientras tanto le cambiaron el tamaño, el nombre o el precio, esta foto ya no sirve: vuelve a la fila y se hace
    // otra con los datos nuevos (nunca queda en el Catálogo una foto con el precio anterior).
    const current = await getSupplierProduct(model.id);
    if (!current) {
      await setState(catalogId, model.id, { status: 'error', detail: 'El modelo ya no existe' });
      return;
    }
    if (posterIsStale(job, current, await getSupplierSettings())) {
      console.log(`🔁 ${model.name} cambió mientras se hacía su foto: se vuelve a hacer con los datos nuevos`);
      await setState(catalogId, model.id, { status: 'cola', detail: '' });
      return;
    }
    if (last.problem) {
      await setState(catalogId, model.id, { status: 'revisar', url: last.url, detail: last.problem });
      return;
    }
    await putInCatalog(model, last.url);
    await setState(catalogId, model.id, { status: 'lista', url: last.url, detail: '' });
  } catch (error: any) {
    await setState(catalogId, model.id, { status: 'error', detail: String(error?.message || error).slice(0, 200) });
    if (isStopError(error)) throw error;
  }
}

/**
 * Foto con la plantilla fija (sin IA): el diseño siempre igual y el nombre y el precio exactos, así que no hace falta
 * revisarla. Si mientras tanto cambió el modelo, se vuelve a hacer con los datos nuevos.
 */
async function makeFromTemplate(catalogId: string, job: Job, category: string) {
  const { model, texts } = job;
  try {
    const poster = renderPoster({ product: await download(model.image_url), texts, category });
    const current = await getSupplierProduct(model.id);
    if (!current) {
      await setState(catalogId, model.id, { status: 'error', detail: 'El modelo ya no existe' });
      return;
    }
    if (posterIsStale(job, current, await getSupplierSettings())) {
      await setState(catalogId, model.id, { status: 'cola', detail: '' });
      return;
    }
    const url = await uploadBufferToStorage(poster, 'image/jpeg', 'product-images');
    await putInCatalog(current, url);
    await setState(catalogId, model.id, { status: 'lista', url, detail: '' });
  } catch (error: any) {
    await setState(catalogId, model.id, { status: 'error', detail: String(error?.message || error).slice(0, 200) });
    if (isStopError(error)) throw error;
  }
}

/** Sin IA (tope del día, sin clave o sin crédito), lo repetido se reconoce por el nombre. */
export function sameNameInCatalog(model: { name: string }, catalog: any[], exclude: Set<string>) {
  const key = productKey(model.name);
  return catalog.find(p => !exclude.has(p.id) && productKey(p.name) === key) || null;
}

/** El modelo con su foto con el diseño: entra al Catálogo con ella o, si ya estaba, se le cambia la foto. */
async function putInCatalog(model: SupplierProduct, posterUrl: string) {
  if (model.status === 'en_catalogo' && model.catalog_product_id) {
    await updateProduct(model.catalog_product_id, { image_url: posterUrl });
    return;
  }
  const result = await addSupplierProductsToCatalog([model.id], true, { [model.id]: posterUrl });
  if (!result.added) throw new Error(result.withoutPrice ? 'Falta el precio de su tamaño en la regla' : 'Ya hay un producto con ese nombre en el Catálogo');
}

const DONE_FOR_POSTER: PosterStatus[] = ['lista', 'revisar', 'repetido', 'cola', 'revisando', 'creando'];
const BUSY: PosterStatus[] = ['cola', 'revisando', 'creando'];

/**
 * Pone en fila los modelos de un catálogo: los indicados (rehacer) o todos los que falten. Cada uno se compara primero
 * con el Catálogo (una vez) y, con posters, después se le hace la foto con el diseño. Sigue en segundo plano; el avance
 * se ve en el CRM.
 */
export async function startPosters(catalogId: string, options: { ids?: string[]; posters?: boolean } = {}): Promise<{ queued: number }> {
  const posters = options.posters !== false;
  // Con la IA, sin clave (o pasado el tope) error claro antes de empezar; la plantilla no la necesita.
  if ((await getSupplierSettings()).posterMode === 'ia') await socialAi();
  const { data: rows, error } = await supabase.from('supplier_products').select('*').eq('catalog_id', catalogId).filter('business_id', tenantOp(), tenantValue()).order('page');
  if (error) throw new Error(`Error leyendo los modelos: ${error.message}`);
  const models = (rows || []) as SupplierProduct[];
  if (models.length === 0) throw new Error('El catálogo no tiene modelos');
  const states = await posterStates(catalogId);
  const statusOf = (m: SupplierProduct) => states[m.id]?.status as PosterStatus;
  const wanted = models.filter(m => m.image_url && (options.ids
    ? options.ids.includes(m.id) && !BUSY.includes(statusOf(m))
    : posters
      ? !DONE_FOR_POSTER.includes(statusOf(m))
      : !states[m.id]?.checked && !states[m.id]?.keep && !BUSY.includes(statusOf(m))));
  for (const model of wanted) await setState(catalogId, model.id, { status: 'cola', poster: posters || !!states[model.id]?.poster, detail: '' });
  if (wanted.length && !postersRunning(catalogId)) void runQueue(catalogId);
  return { queued: wanted.length };
}

async function runQueue(catalogId: string) {
  const key = scope(catalogId);
  running.add(key);
  try {
    const { data: catalog } = await supabase.from('supplier_catalogs').select('name').eq('id', catalogId).filter('business_id', tenantOp(), tenantValue()).maybeSingle();
    if (!catalog) return;
    const category = String(catalog.name || '');
    const settings = await getSupplierSettings();
    const templateMode = settings.posterMode !== 'ia';
    // Con qué comparar: el Catálogo al empezar, sin lo que vino de este PDF; y las fotos de referencia, solo si hacen falta.
    const { data: own } = await supabase.from('supplier_products').select('catalog_product_id').eq('catalog_id', catalogId).filter('business_id', tenantOp(), tenantValue());
    const fromThisPdf = new Set(((own || []) as any[]).map(r => r.catalog_product_id).filter(Boolean));
    const catalogAtStart = await getAllProducts();
    let refs: (References & { texts: Partial<ReferenceTexts> & { occasion?: string } }) | null = null;
    const references = async () => {
      if (refs) return refs;
      const { data: all } = await supabase.from('supplier_products').select('catalog_product_id').filter('business_id', tenantOp(), tenantValue());
      const fromPdf = new Set(((all || []) as any[]).map(r => r.catalog_product_id).filter(Boolean));
      const catalogNow = await getAllProducts();
      const chosen = settings.designProductIds.map(id => catalogNow.find((p: any) => p.id === id)).filter((p: any) => p?.image_url && isOwnStorageUrl(p.image_url));
      // Nunca dos fotos de estilos distintos (la IA los mezcla): las que eligió la empresa o una sola de la misma ocasión.
      const picked = chosen.length ? chosen : pickReferenceProducts(category, catalogNow, fromPdf).slice(0, 1);
      if (picked.length === 0) throw new Error('Para copiar tu diseño hace falta al menos una foto tuya en el Catálogo');
      const buffers = (await Promise.all(picked.map(p => download(p.image_url)))).map(buffer => toJpeg(buffer));
      // Los textos fijos (cinta, íconos, franja) salen del primer afiche de referencia, para que el nuevo diga lo mismo.
      const texts = { ...(await referenceTexts(picked[0].image_url)), occasion: occasionOf(String(picked[0].category || '')) };
      refs = { buffers, urls: picked.map(p => p.image_url), texts, design: texts.diseno || '' };
      return refs;
    };

    // Tope del día o cuenta sin crédito: se detiene toda la fila (seguir solo acumularía errores o gasto).
    let stopped = '';
    // Primero se revisan (y entran al Catálogo) todos los modelos; las fotos, que tardan, van después.
    const next = async (): Promise<{ model: SupplierProduct; state: PosterState } | null> => {
      for (;;) {
        if (stopped) return null;
        const states = await posterStates(catalogId);
        const queued = Object.keys(states).filter(k => states[k].status === 'cola');
        const id = queued.find(k => !states[k].checked && !states[k].keep) || queued[0];
        if (!id) return null;
        const state = { ...states[id] };
        await setState(catalogId, id, { status: !state.checked && !state.keep ? 'revisando' : 'creando' });
        const { data } = await supabase.from('supplier_products').select('*').eq('id', id).filter('business_id', tenantOp(), tenantValue()).maybeSingle();
        if (data) return { model: data as SupplierProduct, state };
        await setState(catalogId, id, { status: 'error', detail: 'El modelo ya no existe' });
      }
    };

    const worker = async () => {
      for (let job = await next(); job; job = await next()) {
        let { model } = job;
        const { state } = job;
        try {
          if (!state.checked && !state.keep) {
            let match: { id: string; name: string; image_url: string } | null;
            try {
              match = await findExisting(model, duplicateCandidates(model, category, catalogAtStart, fromThisPdf));
            } catch (error: any) {
              // Con la plantilla la IA solo sirve para ver repetidos: si no está, se compara por el nombre y se sigue.
              if (!templateMode) throw error;
              match = sameNameInCatalog(model, catalogAtStart, fromThisPdf);
            }
            if (match) {
              await discardAsDuplicate(model);
              await setState(catalogId, model.id, { status: 'repetido', checked: true, match, detail: '' });
              continue;
            }
            // Nuevo. Con foto con el diseño, vuelve a la fila y entra al Catálogo recién con su foto lista; sin ella, entra
            // ya con la foto del PDF (si la regla lo pide).
            if (!state.poster && model.status !== 'en_catalogo' && settings.autoAddToCatalog) {
              await addSupplierProductsToCatalog([model.id]);
              const { data } = await supabase.from('supplier_products').select('*').eq('id', model.id).filter('business_id', tenantOp(), tenantValue()).maybeSingle();
              if (data) model = data as SupplierProduct;
            }
            await setState(catalogId, model.id, { status: state.poster ? 'cola' : 'nuevo', checked: true });
            continue;
          }
          if (!state.poster) { await setState(catalogId, model.id, { status: 'nuevo' }); continue; }
          const price = settings.sizePrices[model.size];
          if (!(price > 0)) { await setState(catalogId, model.id, { status: 'error', detail: 'Falta el precio de su tamaño en la regla' }); continue; }
          const unitPrice = settings.unitPrices?.[model.size] || 0;
          if (templateMode) {
            await makeFromTemplate(catalogId, { model, texts: posterTexts(model.name, price, category, undefined, {}, unitPrice), occasion: occasionOf(category), price, unitPrice }, category);
            continue;
          }
          const ref = await references();
          const texts = posterTexts(model.name, price, category, undefined, ref.texts, unitPrice);
          // Las instrucciones se leen en cada foto: si la empresa las cambia a mitad de la tanda, las siguientes ya las usan.
          const instructions = (await getSupplierSettings()).posterInstructions;
          await makeOne(catalogId, { model, texts, occasion: occasionOf(category), price, unitPrice, instructions }, ref);
        } catch (error: any) {
          await setState(catalogId, model.id, { status: 'error', detail: String(error?.message || error).slice(0, 200) });
          if (isStopError(error)) stopped = String(error?.message || error).slice(0, 200);
        }
      }
    };
    await Promise.all(Array.from({ length: WORKERS }, worker));
    if (stopped) {
      console.warn(`⏸️ Fotos de proveedores detenidas: ${stopped}`);
      const states = await posterStates(catalogId);
      for (const [id, state] of Object.entries(states)) if (BUSY.includes(state.status)) await setState(catalogId, id, { status: 'error', detail: stopped });
    }
  } catch (error: any) {
    console.error('❌ Revisión de modelos de proveedor detenida:', error.message);
    const states = await posterStates(catalogId);
    for (const [id, state] of Object.entries(states)) if (BUSY.includes(state.status)) await setState(catalogId, id, { status: 'error', detail: String(error.message).slice(0, 200) });
  } finally {
    running.delete(key);
  }
}

/** Usa un afiche que quedó "para revisar" (la empresa lo vio y le sirve). */
export async function applyPoster(catalogId: string, model: SupplierProduct): Promise<PosterState> {
  const state = (await posterStates(catalogId))[model.id];
  if (!state?.url) throw new Error('Ese modelo no tiene afiche');
  await putInCatalog(model, state.url);
  await setState(catalogId, model.id, { status: 'lista', detail: '' });
  return (await posterStates(catalogId))[model.id];
}

/**
 * "No es el mismo": con fotos con el diseño, se le hace la suya y entra al Catálogo con ella; si no, entra ya con la
 * foto del PDF.
 */
export async function keepModel(catalogId: string, model: SupplierProduct): Promise<PosterState> {
  const settings = await getSupplierSettings();
  if (!settings.autoPosters) {
    const added = await addSupplierProductsToCatalog([model.id], true);
    if (!added.added && model.status !== 'en_catalogo') throw new Error(added.withoutPrice ? 'Falta el precio de su tamaño en la regla' : 'No se pudo agregar al Catálogo');
  }
  await setState(catalogId, model.id, { status: settings.autoPosters ? 'cola' : 'nuevo', keep: true, checked: true, match: undefined, poster: settings.autoPosters, detail: '' });
  if (settings.autoPosters && !postersRunning(catalogId)) void runQueue(catalogId);
  return (await posterStates(catalogId))[model.id];
}

/** Lo que se quedó a medias porque el servidor se reinició vuelve a la fila. */
export async function resumeStuck(catalogId: string) {
  if (postersRunning(catalogId)) return;
  const states = await posterStates(catalogId);
  const stuck = Object.entries(states).filter(([, s]) => BUSY.includes(s.status));
  if (stuck.length === 0) return;
  try {
    if ((await getSupplierSettings()).posterMode === 'ia') await socialAi();
  } catch (error: any) {
    console.warn('⚠️ No se pudo retomar la revisión de modelos:', error.message);
    return;
  }
  for (const [id] of stuck) await setState(catalogId, id, { status: 'cola' });
  if (!postersRunning(catalogId)) void runQueue(catalogId);
}
