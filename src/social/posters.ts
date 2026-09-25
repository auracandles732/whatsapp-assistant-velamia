import axios from 'axios';
import { getAllProducts, getConfig, setConfig, updateProduct, supabase, tenantOp, tenantValue } from '../services/supabase';
import { uploadBufferToStorage } from '../services/storage';
import { profile } from '../config/businessProfile';
import { socialAi, track } from './ai';
import { toJpeg, isOwnStorageUrl } from './images';
import { getSupplierSettings, SupplierProduct } from './suppliers';

/**
 * Fotos con el diseño de la empresa para los modelos de los PDF de proveedores. El PDF trae fotos simples (fondo blanco);
 * la empresa vende con afiches: título grande, precio, frases, franja de "pedidos bajo reserva"… Para cada modelo:
 *   1. La IA de imágenes del agente (su clave, gpt-image-2) arma el afiche copiando el estilo de dos fotos del Catálogo
 *      de la empresa, con la vela del PDF tal cual, el nombre y el precio según su tamaño.
 *   2. La IA de texto lee el afiche y revisa que el nombre y el precio estén bien escritos y que no haya textos
 *      inventados (otros precios, palabras raras). Si algo salió mal, se hace otra vez; si vuelve a fallar queda
 *      "para revisar" y no se usa sola.
 *   3. El afiche pasa a ser la foto del producto en el Catálogo (la foto original del PDF se conserva en el modelo).
 * Se trabaja en segundo plano (un afiche tarda cerca de un minuto); el avance se guarda por catálogo.
 */

export type PosterStatus = 'cola' | 'creando' | 'lista' | 'revisar' | 'error';
export interface PosterState { status: PosterStatus; url?: string; detail?: string; at: string }

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

/** Cambia el estado de un modelo; las escrituras van en fila para que dos afiches a la vez no se pisen. */
async function setState(catalogId: string, productId: string, state: Omit<PosterState, 'at'>) {
  const key = scope(catalogId);
  const states = memory.get(key) || await posterStates(catalogId);
  states[productId] = { ...state, at: new Date().toISOString() };
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
    await setState(catalogId, model.id, { status: 'lista', url: last.url });
  } catch (error: any) {
    await setState(catalogId, model.id, { status: 'error', detail: String(error?.message || error).slice(0, 200) });
  }
}

/**
 * Pone en fila los afiches de un catálogo: los indicados (rehacer) o todos los que todavía no tienen uno listo. Solo los
 * modelos que ya están en el Catálogo (el afiche lleva su precio). Sigue en segundo plano; se ve el avance en el CRM.
 */
export async function startPosters(catalogId: string, ids?: string[]): Promise<{ queued: number; references: string[] }> {
  await socialAi(); // sin clave del agente, error claro antes de empezar
  const { data: catalog, error } = await supabase.from('supplier_catalogs').select('*').eq('id', catalogId).filter('business_id', tenantOp(), tenantValue()).maybeSingle();
  if (error) throw new Error(`Error leyendo el catálogo: ${error.message}`);
  if (!catalog) throw new Error('El catálogo ya no existe');
  const { data: rows, error: rowsError } = await supabase.from('supplier_products').select('*').eq('catalog_id', catalogId).filter('business_id', tenantOp(), tenantValue()).order('page');
  if (rowsError) throw new Error(`Error leyendo los modelos: ${rowsError.message}`);
  const models = (rows || []) as SupplierProduct[];
  const states = await posterStates(catalogId);
  const products = await getAllProducts();
  const byId = new Map(products.map((p: any) => [p.id, p]));
  const allPdf = await supabase.from('supplier_products').select('catalog_product_id').filter('business_id', tenantOp(), tenantValue());
  const fromPdf = new Set(((allPdf.data || []) as any[]).map(r => r.catalog_product_id).filter(Boolean));
  const references = pickReferences(catalog.name, products, fromPdf);
  if (references.length === 0) throw new Error('Para copiar tu diseño hace falta al menos una foto tuya en el Catálogo');

  const wanted = models.filter(m => m.status === 'en_catalogo' && m.catalog_product_id && byId.has(m.catalog_product_id) && m.image_url
    && (ids ? ids.includes(m.id) : !['lista', 'creando'].includes(states[m.id]?.status || '')));
  for (const model of wanted) await setState(catalogId, model.id, { status: 'cola' });
  if (wanted.length && !postersRunning(catalogId)) void runQueue(catalogId, references);
  return { queued: wanted.length, references };
}

async function runQueue(catalogId: string, references: string[]) {
  const key = scope(catalogId);
  running.add(key);
  try {
    const refs = (await Promise.all(references.map(download))).map(buffer => toJpeg(buffer));
    // Se leen los pendientes cada vez: lo que se agregue a la fila mientras trabaja también sale.
    const next = async (): Promise<SupplierProduct | null> => {
      const states = await posterStates(catalogId);
      const id = Object.keys(states).find(k => states[k].status === 'cola');
      if (!id) return null;
      await setState(catalogId, id, { status: 'creando' });
      const { data } = await supabase.from('supplier_products').select('*').eq('id', id).filter('business_id', tenantOp(), tenantValue()).maybeSingle();
      return (data as SupplierProduct) || null;
    };
    const settings = await getSupplierSettings();
    const { data: catalog } = await supabase.from('supplier_catalogs').select('name').eq('id', catalogId).maybeSingle();
    const category = String(catalog?.name || '');
    const worker = async () => {
      for (let model = await next(); model; model = await next()) {
        const product: any = model.catalog_product_id ? (await getAllProducts()).find((p: any) => p.id === model!.catalog_product_id) : null;
        if (!product) { await setState(catalogId, model.id, { status: 'error', detail: 'El producto ya no está en el Catálogo' }); continue; }
        await makeOne(catalogId, { model, texts: posterTexts(product.name, Number(product.price) || settings.sizePrices[model.size], category), occasion: occasionOf(category) }, refs);
      }
    };
    await Promise.all(Array.from({ length: WORKERS }, worker));
  } catch (error: any) {
    console.error('❌ Afiches de proveedor detenidos:', error.message);
    const states = await posterStates(catalogId);
    for (const [id, state] of Object.entries(states)) if (state.status === 'cola' || state.status === 'creando') await setState(catalogId, id, { status: 'error', detail: String(error.message).slice(0, 200) });
  } finally {
    running.delete(key);
  }
}

/** Usa un afiche que quedó "para revisar" (la empresa lo vio y le sirve). */
export async function applyPoster(catalogId: string, model: SupplierProduct): Promise<PosterState> {
  const state = (await posterStates(catalogId))[model.id];
  if (!state?.url) throw new Error('Ese modelo no tiene afiche');
  if (model.catalog_product_id) await updateProduct(model.catalog_product_id, { image_url: state.url });
  await setState(catalogId, model.id, { status: 'lista', url: state.url });
  return (await posterStates(catalogId))[model.id];
}

/** Un afiche que se quedó "creando" porque el servidor se reinició vuelve a la fila. */
export async function resumeStuck(catalogId: string) {
  if (postersRunning(catalogId)) return;
  const states = await posterStates(catalogId);
  const stuck = Object.entries(states).filter(([, s]) => s.status === 'creando' || s.status === 'cola').map(([id]) => id);
  if (stuck.length) await startPosters(catalogId, stuck).catch(error => console.warn('⚠️ No se pudieron retomar los afiches:', error.message));
}
