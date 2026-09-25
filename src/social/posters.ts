import axios from 'axios';
import { getAllProducts, getConfig, setConfig, updateProduct, supabase, tenantOp, tenantValue } from '../services/supabase';
import { uploadBufferToStorage } from '../services/storage';
import { profile } from '../config/businessProfile';
import { socialAi, track } from './ai';
import { toJpeg, isOwnStorageUrl } from './images';
import { getSupplierSettings, SupplierProduct, addSupplierProductsToCatalog, discardAsDuplicate } from './suppliers';

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

export interface PosterTexts { title: string; price: number; unit: string; ribbon: string; features: string[]; band: string; bandSmall: string }

export function posterTexts(name: string, price: number, category: string, unit = profile().sales.unitSingular): PosterTexts {
  return {
    title: String(name).replace(/\s+/g, ' ').trim().toUpperCase(),
    price,
    unit: String(unit || 'unidad').toUpperCase(),
    ribbon: `UN DETALLE ESPECIAL PARA ${occasionOf(category)}`,
    features: ['DISEÑO DECORATIVO', 'IDEAL PARA REGALAR', 'ELABORADAS BAJO PEDIDO'],
    band: 'PEDIDOS BAJO RESERVA',
    bandSmall: 'Asegura tu pedido con anticipación'
  };
}

const money = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(2));

export function posterPrompt(t: PosterTexts, occasion: string): string {
  return `Create a square 1:1 advertising poster for a handmade candle shop. Copy EXACTLY the layout, typography, colors and decorative style of the reference posters (every image after the first one): a left column with the title in huge bold capital letters, a ribbon banner under it, a rounded price box with a big price and a label under it, three round icons (gift, heart, calendar) each with a short text, and a band across the bottom with a padlock-heart icon. The background decoration must fit the occasion "${occasion}" (keep the same warm, elegant, bokeh look as the references).
On the right side, place the candle from the FIRST image, large and well lit, standing on a soft surface. Reproduce that candle faithfully: same shape, colors, face, details and proportions; do not redesign it. Show it with a short white unlit cotton wick.
Write exactly these Spanish texts and nothing else:
- Title: "${t.title}"
- Ribbon: "${t.ribbon}"
- Price box: "$${money(t.price)}" and under it "${t.unit}"
- Icons: "${t.features.join('", "')}"
- Bottom band: "${t.band}" and smaller "${t.bandSmall}"
No other text, no unit price, no second price, no logos, no watermarks. Spelling must be exact, including accents and Ñ.`;
}

/** Para comparar textos: mayúsculas, sin espacios repetidos ni tildes, pero la Ñ cuenta. */
export function sameText(a: string, b: string): boolean {
  const norm = (s: string) => String(s || '').toUpperCase().replace(/Ñ/g, '\u0001').normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/\u0001/g, 'Ñ').replace(/[^A-Z0-9Ñ#$.]+/g, ' ').trim();
  return norm(a) === norm(b);
}

export interface PosterReading { titulo: string; precio: string; etiquetaPrecio: string; otrosPrecios: string[]; errores: string[] }

/** Qué salió mal en un afiche leído por la IA ('' = todo bien). */
export function posterProblem(reading: PosterReading, t: PosterTexts): string {
  if (!sameText(reading.titulo, t.title)) return `El nombre salió "${reading.titulo}" en vez de "${t.title}"`;
  const price = Number(String(reading.precio || '').replace(/[^\d.,]/g, '').replace(',', '.'));
  if (!(Math.abs(price - t.price) < 0.01)) return `El precio salió "${reading.precio}" en vez de $${money(t.price)}`;
  if ((reading.otrosPrecios || []).length) return `Apareció otro precio: ${reading.otrosPrecios.join(', ')}`;
  if ((reading.errores || []).length) return `Textos mal escritos o inventados: ${reading.errores.slice(0, 3).join(', ')}`;
  return '';
}

// ---------- IA ----------

async function download(url: string): Promise<Buffer> {
  if (!isOwnStorageUrl(url)) throw new Error('La foto no está en el almacenamiento propio');
  const { data } = await axios.get(url, { responseType: 'arraybuffer', timeout: 60_000, maxContentLength: 15 * 1024 * 1024 });
  return Buffer.from(data);
}

/** refs ya en JPG (se convierten una vez por tanda). */
async function drawPoster(model: Buffer, refs: Buffer[], t: PosterTexts, occasion: string): Promise<Buffer> {
  const ai = await socialAi();
  const form = new FormData();
  form.append('model', ai.imageModel);
  form.append('prompt', posterPrompt(t, occasion));
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

async function readPoster(jpegBuffer: Buffer, t: PosterTexts): Promise<PosterReading> {
  const ai = await socialAi();
  const expected = [t.title, t.ribbon, `$${money(t.price)}`, t.unit, ...t.features, t.band, t.bandSmall];
  const response = await ai.client.chat.completions.create({
    model: ai.textModel,
    ...(/^(gpt-5|o\d)/.test(ai.textModel) ? { reasoning_effort: 'low' } : {}),
    max_completion_tokens: 2000,
    response_format: {
      type: 'json_schema',
      json_schema: {
        name: 'lectura',
        strict: true,
        schema: {
          type: 'object',
          additionalProperties: false,
          required: ['titulo', 'precio', 'etiquetaPrecio', 'otrosPrecios', 'errores'],
          properties: {
            titulo: { type: 'string' },
            precio: { type: 'string' },
            etiquetaPrecio: { type: 'string' },
            otrosPrecios: { type: 'array', items: { type: 'string' } },
            errores: { type: 'array', items: { type: 'string' } }
          }
        }
      }
    },
    messages: [{
      role: 'user',
      content: [
        { type: 'text', text: `Lee con cuidado los textos de este afiche. Devuelve: "titulo" = el nombre grande del producto, letra por letra tal como está escrito; "precio" = el precio grande tal cual (con $); "etiquetaPrecio" = lo que dice debajo del precio; "otrosPrecios" = cualquier otro precio o monto que aparezca; "errores" = cada texto que esté mal escrito, deformado o que no sea uno de estos: ${expected.map(x => `"${x}"`).join(', ')}. Si todo está bien, las listas van vacías.` },
        { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${jpegBuffer.toString('base64')}`, detail: 'high' } }
      ]
    }]
  } as any);
  track(ai.textModel, response.usage);
  return JSON.parse(response.choices[0]?.message?.content || '{}');
}

// ---------- Fotos de referencia ----------

const words = (text: string) => occasionOf(text).split(' ').filter(w => w.length > 2 && w !== 'TI');

/**
 * Dos fotos del Catálogo de la empresa para copiar el estilo: las suyas (no las que vinieron de un PDF), primero las
 * de la misma ocasión (MOLDES NAVIDAD → NAVIDAD) y, si no hay, las más recientes.
 */
export function pickReferences(category: string, catalog: any[], fromPdf: Set<string>): string[] {
  const own = catalog.filter(p => p.image_url && isOwnStorageUrl(p.image_url) && !fromPdf.has(p.id));
  const wanted = words(category);
  const score = (p: any) => words(String(p.category || '')).filter(w => wanted.includes(w)).length;
  const sorted = [...own].sort((a, b) => score(b) - score(a) || String(b.created_at || '').localeCompare(String(a.created_at || '')));
  const urls: string[] = [];
  for (const p of sorted) if (!urls.includes(p.image_url) && urls.length < 2) urls.push(p.image_url);
  return urls;
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
async function findExisting(model: SupplierProduct, candidates: any[]): Promise<{ id: string; name: string; image_url: string } | null> {
  if (candidates.length === 0 || !model.image_url) return null;
  const ai = await socialAi();
  const pick = await ai.client.chat.completions.create({
    model: ai.textModel,
    ...reasoning(ai.textModel),
    max_completion_tokens: 1500,
    response_format: jsonSchema('comparacion', { posibles: { type: 'array', items: { type: 'integer' } } }),
    messages: [{
      role: 'user',
      content: [
        { type: 'text', text: `La foto 0 es una vela del catálogo de un proveedor. Las fotos 1 a ${candidates.length} son productos que la tienda ya vende: suelen ser afiches con textos, precio y otro fondo, y la vela puede tener otro color. ¿Cuáles podrían ser la misma vela (la misma figura)? Pon en "posibles" hasta 2 números, del más parecido al menos; vacío si ninguna se le parece. Después se revisa cada una con calma.` },
        { type: 'image_url', image_url: { url: model.image_url, detail: 'low' } },
        ...candidates.map(c => ({ type: 'image_url', image_url: { url: c.image_url, detail: 'low' } }))
      ]
    }]
  } as any);
  track(ai.textModel, pick.usage);
  const picked: unknown[] = JSON.parse(pick.choices[0]?.message?.content || '{}').posibles || [];
  const options = [...new Set(picked.map(Number))].filter(i => Number.isInteger(i) && i >= 1 && i <= candidates.length).slice(0, 2).map(i => candidates[i - 1]);
  if (options.length === 0) console.log(`🔁 ${model.name}: nada parecido en el Catálogo (${candidates.length} revisados)`);
  for (const found of options) {
    const same = await sameMold(model.image_url, found.image_url);
    console.log(`🔁 ${model.name}: ¿es ${found.name}? ${same ? "sí, ya lo tiene" : "no"}`);
    if (same) return { id: found.id, name: found.name, image_url: found.image_url };
  }
  return null;
}

/**
 * Segundo paso: ¿estas dos fotos muestran el mismo molde? La IA describe cada vela por separado (gorro, cara, brazos,
 * piernas, adornos) y recién después compara: así no confunde dos Papá Noel distintos (probado 24 de 24 con 4 pares
 * iguales y 4 distintos de MOLDES NAVIDAD).
 */
async function sameMold(modelUrl: string, productUrl: string): Promise<boolean> {
  const ai = await socialAi();
  const confirm = await ai.client.chat.completions.create({
    model: ai.textModel,
    ...reasoning(ai.textModel),
    max_completion_tokens: 2000,
    response_format: jsonSchema('confirmacion', { proveedor: { type: 'string' }, afiche: { type: 'string' }, mismoMolde: { type: 'boolean' } }),
    messages: [{
      role: 'user',
      content: [
        { type: 'text', text: `La primera foto es una vela de un proveedor. La segunda es un afiche de una tienda hecho con la foto de una vela: puede estar redibujada, con otro color, otra luz, otro fondo y textos encima (eso no importa).
Primero describe cada vela por separado, en pocas palabras: qué figura es; su gorro o sombrero (forma); su cara (qué se ve); brazos y manos (posición y qué sostienen); piernas o base; adornos en relieve.
Después decide: "mismoMolde" = true solo si es la misma figura y coinciden la forma del gorro, la postura de brazos y piernas y los adornos principales. Diferencias pequeñas de dibujo no cuentan; un personaje del mismo tema pero con otra forma (otro gnomo, otro Papá Noel) no es el mismo.` },
        { type: 'image_url', image_url: { url: modelUrl, detail: 'high' } },
        { type: 'image_url', image_url: { url: productUrl, detail: 'high' } }
      ]
    }]
  } as any);
  track(ai.textModel, confirm.usage);
  return JSON.parse(confirm.choices[0]?.message?.content || '{}').mismoMolde === true;
}

// ---------- Trabajo en segundo plano ----------

interface Job { model: SupplierProduct; texts: PosterTexts; occasion: string }

async function makeOne(catalogId: string, job: Job, refs: Buffer[]) {
  const { model, texts, occasion } = job;
  try {
    const photo = await download(model.image_url);
    let last: { url: string; problem: string } | null = null;
    for (let attempt = 1; attempt <= TRIES; attempt++) {
      const poster = await drawPoster(photo, refs, texts, occasion);
      const problem = posterProblem(await readPoster(poster, texts), texts);
      const url = await uploadBufferToStorage(poster, 'image/jpeg', 'product-images');
      last = { url, problem };
      if (!problem) break;
      console.warn(`⚠️ Afiche de ${texts.title} (intento ${attempt}): ${problem}`);
    }
    if (!last) return;
    if (last.problem) {
      await setState(catalogId, model.id, { status: 'revisar', url: last.url, detail: last.problem });
      return;
    }
    if (model.catalog_product_id) await updateProduct(model.catalog_product_id, { image_url: last.url });
    await setState(catalogId, model.id, { status: 'lista', url: last.url, detail: '' });
  } catch (error: any) {
    await setState(catalogId, model.id, { status: 'error', detail: String(error?.message || error).slice(0, 200) });
  }
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
  await socialAi(); // sin clave del agente, error claro antes de empezar
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
    // Con qué comparar: el Catálogo al empezar, sin lo que vino de este PDF; y las fotos de referencia, solo si hacen falta.
    const { data: own } = await supabase.from('supplier_products').select('catalog_product_id').eq('catalog_id', catalogId).filter('business_id', tenantOp(), tenantValue());
    const fromThisPdf = new Set(((own || []) as any[]).map(r => r.catalog_product_id).filter(Boolean));
    const catalogAtStart = await getAllProducts();
    let refs: Buffer[] | null = null;
    const references = async () => {
      if (refs) return refs;
      const { data: all } = await supabase.from('supplier_products').select('catalog_product_id').filter('business_id', tenantOp(), tenantValue());
      const fromPdf = new Set(((all || []) as any[]).map(r => r.catalog_product_id).filter(Boolean));
      const urls = pickReferences(category, await getAllProducts(), fromPdf);
      if (urls.length === 0) throw new Error('Para copiar tu diseño hace falta al menos una foto tuya en el Catálogo');
      refs = (await Promise.all(urls.map(download))).map(buffer => toJpeg(buffer));
      return refs;
    };

    // Primero se revisan (y entran al Catálogo) todos los modelos; las fotos, que tardan, van después.
    const next = async (): Promise<{ model: SupplierProduct; state: PosterState } | null> => {
      for (;;) {
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
            const match = await findExisting(model, duplicateCandidates(model, category, catalogAtStart, fromThisPdf));
            if (match) {
              await discardAsDuplicate(model);
              await setState(catalogId, model.id, { status: 'repetido', checked: true, match, detail: '' });
              continue;
            }
            // Nuevo: entra al Catálogo con su precio (si la regla lo pide) y, si lleva foto, vuelve a la fila para después.
            if (model.status !== 'en_catalogo' && settings.autoAddToCatalog) {
              await addSupplierProductsToCatalog([model.id]);
              const { data } = await supabase.from('supplier_products').select('*').eq('id', model.id).filter('business_id', tenantOp(), tenantValue()).maybeSingle();
              if (data) model = data as SupplierProduct;
            }
            await setState(catalogId, model.id, { status: state.poster ? 'cola' : 'nuevo', checked: true });
            continue;
          }
          if (!state.poster) { await setState(catalogId, model.id, { status: 'nuevo' }); continue; }
          const product: any = model.catalog_product_id ? (await getAllProducts()).find((p: any) => p.id === model.catalog_product_id) : null;
          if (!product) { await setState(catalogId, model.id, { status: 'error', detail: 'No está en el Catálogo (revisa que tenga precio)' }); continue; }
          await makeOne(catalogId, { model, texts: posterTexts(product.name, Number(product.price) || settings.sizePrices[model.size], category), occasion: occasionOf(category) }, await references());
        } catch (error: any) {
          await setState(catalogId, model.id, { status: 'error', detail: String(error?.message || error).slice(0, 200) });
        }
      }
    };
    await Promise.all(Array.from({ length: WORKERS }, worker));
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
  if (model.catalog_product_id) await updateProduct(model.catalog_product_id, { image_url: state.url });
  await setState(catalogId, model.id, { status: 'lista', detail: '' });
  return (await posterStates(catalogId))[model.id];
}

/** "No es el mismo": el modelo entra al Catálogo y, si la regla lo pide, se le hace la foto con el diseño. */
export async function keepModel(catalogId: string, model: SupplierProduct): Promise<PosterState> {
  const settings = await getSupplierSettings();
  const added = await addSupplierProductsToCatalog([model.id], true);
  if (!added.added && model.status !== 'en_catalogo') throw new Error(added.withoutPrice ? 'Falta el precio de su tamaño en la regla' : 'No se pudo agregar al Catálogo');
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
    await socialAi();
  } catch (error: any) {
    console.warn('⚠️ No se pudo retomar la revisión de modelos:', error.message);
    return;
  }
  for (const [id] of stuck) await setState(catalogId, id, { status: 'cola' });
  if (!postersRunning(catalogId)) void runQueue(catalogId);
}
