import { createHash, randomUUID } from 'crypto';
import { supabase, getAllProducts, getConfig, setConfig, updateProduct, tenantOp, tenantValue } from './supabase';
import { askJson } from './openai';
import { costOf } from './aiPrices';
import { currentTenant } from './tenant';
import { profile } from '../config/businessProfile';
import { plain, localParts, zonedTime } from '../social/posts';
import { setProductWeb, scheduleWebPush } from './webCatalog';
import { renameProductInAds } from './ads';

/**
 * Revisión del catálogo (la hace el supervisor, para todas las empresas). Mira cada producto nuevo o que cambió:
 *  - La escritura del nombre, del nombre y el texto de la web y de las categorías (tildes, letras, ñ, ü).
 *  - La foto: que muestre lo que dice el nombre y que el precio escrito en la foto sea el del catálogo.
 *  - Nombres repetidos, la misma foto en dos productos y productos sin foto (sin IA).
 * Las correcciones de solo tildes, ñ y ü se aplican solas (si la empresa lo deja así) y se pueden deshacer; las que
 * cambian letras o una categoría se aplican con un toque. Una foto o un precio los decide siempre la empresa.
 */

const STATE_KEY = 'catalog_review';
/** Tope diario de la revisión del catálogo (US$), aparte del de los chats. */
export const CATALOG_DAILY_BUDGET = 0.5;
const PURPOSE = 'catalogo';
const TEXT_BATCH = 40;
const PHOTO_BATCH = 8;
/** Lo que se revisa por pasada: lo demás sigue en la próxima (una por hora). */
const TEXT_PER_RUN = 200;
const PHOTOS_PER_RUN = 64;
const RUN_EVERY_MS = 60 * 60 * 1000;
const MAX_FINDINGS = 400;

export type FindingKind = 'ortografia' | 'foto' | 'precio_foto' | 'nombre_repetido' | 'foto_repetida' | 'sin_foto';
export type Field = 'name' | 'web.name' | 'web.description' | 'category';
export type FindingStatus = 'pendiente' | 'aplicado' | 'ignorado' | 'deshecho';

export interface Finding {
  id: string;
  /** Producto (vacío en una categoría: el cambio es para todos sus productos). */
  productId: string;
  product: string;
  image: string;
  kind: FindingKind;
  field?: Field;
  current?: string;
  suggested?: string;
  detail: string;
  /** Solo cambia tildes, ñ o ü: se puede aplicar sin preguntar. */
  accentsOnly?: boolean;
  status: FindingStatus;
  /** Lo aplicó el supervisor solo (sin que nadie tocara). */
  auto?: boolean;
  createdAt: string;
  decidedAt?: string;
}

export interface ReviewState {
  /** Revisión automática cada hora (VELAMIA sí; cada empresa la prende en el Supervisor). */
  enabled: boolean;
  autoFix: boolean;
  lastRunAt: string;
  lastError: string;
  /** Lo último revisado de cada producto (huella del texto y de la foto): solo se vuelve a mirar lo que cambió. */
  checked: Record<string, { t?: string; f?: string }>;
  checkedCategories: string[];
  /** Palabras ya corregidas (sin tilde → con tilde) para corregirlas igual en todo el catálogo. */
  words: Record<string, string>;
  findings: Finding[];
}

const nowIso = () => new Date().toISOString();

export async function readState(): Promise<ReviewState> {
  let s: any = {};
  try {
    const raw = await getConfig(STATE_KEY);
    s = raw ? JSON.parse(raw) : {};
  } catch {
    s = {};
  }
  return {
    // Apagada para todas: gasta IA, así que se revisa con "Revisar ahora" cuando la dueña quiera o se prende la revisión cada hora.
    enabled: s.enabled === true, autoFix: typeof s.autoFix === 'boolean' ? s.autoFix : !currentTenant(), lastRunAt: String(s.lastRunAt || ''), lastError: String(s.lastError || ''),
    checked: s.checked && typeof s.checked === 'object' ? s.checked : {}, checkedCategories: Array.isArray(s.checkedCategories) ? s.checkedCategories : [],
    words: s.words && typeof s.words === 'object' ? s.words : {}, findings: Array.isArray(s.findings) ? s.findings : []
  };
}

async function writeState(s: ReviewState) {
  // Primero lo pendiente; de lo ya resuelto, solo lo más reciente.
  const pending = s.findings.filter(f => f.status === 'pendiente');
  const done = s.findings.filter(f => f.status !== 'pendiente').sort((a, b) => String(b.decidedAt || b.createdAt).localeCompare(String(a.decidedAt || a.createdAt)));
  await setConfig(STATE_KEY, JSON.stringify({ ...s, findings: [...pending, ...done].slice(0, MAX_FINDINGS) }));
}

// ---------- Huellas y reglas (sin efectos) ----------

const hash = (...parts: unknown[]) => createHash('sha1').update(parts.map(p => String(p ?? '')).join('\u0001')).digest('hex').slice(0, 16);

export const textPrint = (p: any) => hash(p.name, p.web?.name, p.web?.description);
// Sin tildes: corregir la escritura no hace volver a mirar la foto.
export const photoPrint = (p: any) => hash(p.image_url, p.price, plain(p.name), plain(p.web?.name || ''));

/** Distancia de edición (letras) entre dos textos. */
export function editDistance(a: string, b: string): number {
  const m = a.length, n = b.length;
  if (!m) return n;
  if (!n) return m;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[n];
}

const digitsOf = (t: string) => (t.match(/\d+/g) || []).join(',');
const isUpper = (t: string) => t === t.toUpperCase() && /[A-ZÁÉÍÓÚÑÜ]/.test(t);

/**
 * ¿La corrección que propone la IA es solo de escritura? Mismos números, mismo estilo de mayúsculas y pocas letras
 * distintas (sin tildes): nunca otro sentido. Devuelve la corrección lista o null si no se acepta. Sin efectos.
 */
export function acceptCorrection(current: string, suggested: string): { text: string; accentsOnly: boolean } | null {
  const cur = String(current || '').trim();
  let next = String(suggested || '').replace(/\s+/g, ' ').trim();
  if (!cur || !next) return null;
  if (isUpper(cur)) next = next.toUpperCase();
  if (next === cur) return null;
  if (digitsOf(cur) !== digitsOf(next)) return null;
  const curWords = cur.split(/\s+/), nextWords = next.split(/\s+/);
  if (curWords.length === nextWords.length) {
    for (let i = 0; i < curWords.length; i++) {
      const wa = plain(curWords[i]), wb = plain(nextWords[i]);
      // Nunca otro género: "graduado" y "graduada" son productos distintos.
      const stem = (w: string) => w.replace(/(o|a|os|as)$/, '');
      if (wa !== wb && stem(wa) === stem(wb) && /(o|a|os|as)$/.test(wa) && /(o|a|os|as)$/.test(wb) && wa.endsWith('s') === wb.endsWith('s')) return null;
      // Los diminutivos no llevan tilde: angelito, corazoncito.
      if (/(it|ill)(o|a|os|as)$/.test(wb) && /[áéíóúÁÉÍÓÚ]/.test(nextWords[i]) && !/[áéíóúÁÉÍÓÚ]/.test(curWords[i])) return null;
    }
  }
  const a = plain(cur), b = plain(next);
  const distance = editDistance(a, b);
  const limit = Math.max(2, Math.round(a.length * 0.15));
  if (distance > limit) return null;
  return { text: next, accentsOnly: distance === 0 };
}

// Palabras que llevan o no tilde según la frase (o que son otra palabra sin ella: mono/moño, papa/papá, Nina/niña):
// nunca se corrigen en todo el catálogo de una vez; la IA las corrige producto por producto.
const AMBIGUOUS = new Set(['como', 'mas', 'solo', 'este', 'esta', 'ese', 'esa', 'esto', 'eso', 'aquel', 'aquella', 'tu', 'te', 'el', 'si', 'se', 'de', 'mi', 'que',
  'cual', 'donde', 'cuando', 'quien', 'cuanto', 'aun', 'o', 'papa', 'mama', 'bebe', 'bebes', 'mono', 'monos', 'nina', 'nino', 'anos', 'ano', 'sabana', 'ultimo',
  'publico', 'practico', 'esta', 'continuo', 'tomo', 'animo', 'rio', 'fin']);

// Palabras que en español siempre llevan tilde (o ñ, ü): se corrigen en todo el catálogo aunque la IA las pase por alto.
const ALWAYS: Record<string, string> = {
  numero: 'número', numeros: 'números', unico: 'único', unica: 'única', unicos: 'únicos', unicas: 'únicas', tambien: 'también', dia: 'día', dias: 'días',
  diseno: 'diseño', disenos: 'diseños', corazon: 'corazón', cumpleanos: 'cumpleaños', arbol: 'árbol', angel: 'ángel', leon: 'león', pinguino: 'pingüino',
  pinguinos: 'pingüinos', ademas: 'además', facil: 'fácil', util: 'útil', rapido: 'rápido', rapida: 'rápida', clasico: 'clásico', clasica: 'clásica',
  magico: 'mágico', magica: 'mágica', romantico: 'romántico', romantica: 'romántica', cilindrico: 'cilíndrico', cilindrica: 'cilíndrica', biberon: 'biberón',
  buho: 'búho', arcoiris: 'arcoíris', pequeno: 'pequeño', pequena: 'pequeña', pequenos: 'pequeños', pequenas: 'pequeñas', tamano: 'tamaño', tamanos: 'tamaños',
  navideno: 'navideño', navidena: 'navideña', navidenos: 'navideños', navidenas: 'navideñas', carino: 'cariño', exito: 'éxito', regalame: 'regálame'
};

/** La forma correcta de una palabra que siempre lleva tilde (o que termina en -ción). '' si no se sabe. */
export function alwaysFix(word: string): string {
  const w = word.toLowerCase();
  if (ALWAYS[w]) return ALWAYS[w];
  if (/^\p{L}{2,}cion$/u.test(w) && plain(w) === w) return `${w.slice(0, -4)}ción`;
  return '';
}

/**
 * Palabras aprendidas de correcciones de solo tildes ya revisadas ("corazon" → "corazón"): así la misma palabra se
 * corrige en todos los productos aunque la IA la pase por alto en alguno. Sin efectos.
 */
export function wordFixes(pairs: { current: string; suggested: string }[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const { current, suggested } of pairs) {
    const a = String(current || '').split(/\s+/), b = String(suggested || '').split(/\s+/);
    if (a.length !== b.length) continue;
    for (let i = 0; i < a.length; i++) {
      const wa = a[i].toLowerCase().replace(/[^\p{L}]/gu, ''), wb = b[i].toLowerCase().replace(/[^\p{L}]/gu, '');
      if (!wa || wa === wb || plain(wa) !== plain(wb) || AMBIGUOUS.has(plain(wa)) || wa.length < 3) continue;
      out[wa] = wb;
    }
  }
  return out;
}

/** Corrige en un texto las palabras aprendidas (palabra completa, respetando mayúsculas). Sin efectos. */
export function applyWordFixes(text: string, words: Record<string, string>): string {
  return String(text || '').split(/(\p{L}+)/u).map(part => {
    const fix = words[part.toLowerCase()] || (/^\p{L}+$/u.test(part) ? alwaysFix(part) : '');
    if (!fix) return part;
    if (part === part.toUpperCase()) return fix.toUpperCase();
    if (part[0] === part[0].toUpperCase()) return fix[0].toUpperCase() + fix.slice(1);
    return fix;
  }).join('');
}

/** Lo que se ve sin IA: nombres repetidos, la misma foto en dos productos y productos sin foto. */
export function plainFindings(products: any[]): Omit<Finding, 'id' | 'status' | 'createdAt'>[] {
  const out: Omit<Finding, 'id' | 'status' | 'createdAt'>[] = [];
  const byName = new Map<string, any[]>();
  const byPhoto = new Map<string, any[]>();
  for (const p of products) {
    const key = plain(p.name).replace(/\s+/g, ' ');
    byName.set(key, [...(byName.get(key) || []), p]);
    if (p.image_url) byPhoto.set(p.image_url, [...(byPhoto.get(p.image_url) || []), p]);
    else out.push({ productId: p.id, product: p.name, image: '', kind: 'sin_foto', detail: 'No tiene foto: la vendedora no puede mostrarlo y no sale bien en la web ni en anuncios.' });
  }
  for (const list of byName.values()) {
    if (list.length < 2) continue;
    for (const p of list) {
      const others = list.filter(o => o !== p).map(o => `$${Number(o.price)} · ${o.category}`).join('; ');
      out.push({ productId: p.id, product: p.name, image: p.image_url || '', kind: 'nombre_repetido', detail: `Hay otro producto con el mismo nombre (${others}). Cambia uno para que la vendedora y los anuncios no los confundan.` });
    }
  }
  for (const list of byPhoto.values()) {
    if (list.length < 2) continue;
    for (const p of list) {
      out.push({ productId: p.id, product: p.name, image: p.image_url, kind: 'foto_repetida', detail: `Tiene la misma foto que: ${list.filter(o => o !== p).map(o => o.name).join(', ')}. Revisa que cada uno tenga su foto.` });
    }
  }
  return out;
}

const findingKey = (f: Pick<Finding, 'kind' | 'productId' | 'field' | 'suggested'>) => `${f.kind}|${f.productId}|${f.field || ''}|${f.suggested || ''}`;

// ---------- Gasto ----------

export async function catalogSpentToday(now = new Date()): Promise<number> {
  const tz = profile().business.timezone;
  const p = localParts(now, tz);
  const start = zonedTime(p.year, p.month, p.day, 0, 0, tz);
  const { data, error } = await supabase.from('ai_usage').select('model, input_tokens, cached_tokens, output_tokens')
    .eq('purpose', PURPOSE).filter('business_id', tenantOp(), tenantValue()).gte('created_at', start.toISOString()).limit(20000);
  if (error) throw new Error(`Error leyendo el consumo de la revisión del catálogo: ${error.message}`);
  return Math.round((data || []).reduce((sum, row) => sum + costOf(row as any), 0) * 1000) / 1000;
}

const budgetLeft = async () => (await catalogSpentToday().catch(() => 0)) < CATALOG_DAILY_BUDGET;

// ---------- IA: escritura ----------

const TEXT_RULES = [
  'Revisas la ESCRITURA del catálogo de una tienda en español. Devuelve solo los errores de escritura reales:',
  '- Tildes que faltan o sobran (corazón, cumpleaños, mamá, ángel, león, bebé, árbol, búho, romántico, revelación, género).',
  '- Letras que faltan, sobran o están cambiadas (CALABERA → CALAVERA), ñ y ü (niña, pingüino), concordancia evidente ("pareja abrazadas" → "pareja abrazada").',
  '- Nombres de personajes conocidos mal escritos (Annabelle, Pennywise).',
  '- En empaques y detalles, "mono" suele ser "moño" (un lazo): corrígelo solo si por el texto es claramente un lazo o adorno.',
  'NO cambies: palabras en inglés o nombres de diseños (Boy or Girl, Rose Bloom, Light of Love, Honey Pot, Ghostface), el sentido, el orden de las palabras, los números de modelo (#1, 2, 3), los nombres de empaque (Tul, Acetato, Kraft) ni el estilo. No agregues ni quites palabras. Respeta las MAYÚSCULAS: si está en mayúsculas, la corrección también.',
  '"corregido" es el texto COMPLETO del campo ya corregido. Si un campo no tiene errores, no lo incluyas. Es mejor no corregir que cambiar algo que estaba bien.'
].join('\n');

const TEXT_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['correcciones'],
  properties: {
    correcciones: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false, required: ['n', 'campo', 'corregido', 'motivo'],
        properties: { n: { type: 'integer' }, campo: { type: 'string', enum: ['nombre', 'nombre_web', 'texto_web', 'categoria'] }, corregido: { type: 'string' }, motivo: { type: 'string' } }
      }
    }
  }
};

const FIELD_OF: Record<string, Field> = { nombre: 'name', nombre_web: 'web.name', texto_web: 'web.description', categoria: 'category' };

function fieldValue(p: any, field: Field): string {
  if (field === 'name') return String(p.name || '');
  if (field === 'web.name') return String(p.web?.name || '');
  if (field === 'web.description') return String(p.web?.description || '');
  return String(p.category || '');
}

const VERIFY_RULES = [
  'Eres corrector de español (según la RAE). Cada línea trae un texto "original" y su "corregido". Para cada una responde ok:',
  '- ok = true solo si "corregido" está bien escrito y dice lo mismo que "original" (solo arregla la escritura).',
  '- ok = false si la corrección mete un error (por ejemplo "ángelito" o "corazoncíto": los diminutivos no llevan tilde), cambia masculino por femenino, traduce, cambia el sentido o una palabra en inglés, o si el original ya estaba bien.'
].join('\n');

/** Una segunda mirada a cada corrección propuesta: solo quedan las que el corrector confirma. */
async function verifyCorrections(list: { current: string; suggested: string }[]): Promise<boolean[]> {
  const ok = list.map(() => false);
  for (let i = 0; i < list.length; i += 50) {
    if (!(await budgetLeft())) break;
    const batch = list.slice(i, i + 50);
    const result = await askJson<{ revisiones: { n: number; ok: boolean }[] }>({
      purpose: PURPOSE, schemaName: 'verificar_correcciones', system: VERIFY_RULES, maxTokens: 3000,
      schema: { type: 'object', additionalProperties: false, required: ['revisiones'], properties: { revisiones: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['n', 'ok'], properties: { n: { type: 'integer' }, ok: { type: 'boolean' } } } } } },
      user: batch.map((c, k) => JSON.stringify({ n: k + 1, original: c.current, corregido: c.suggested })).join('\n')
    });
    for (const r of result.revisiones || []) if (r.n >= 1 && r.n <= batch.length && r.ok === true) ok[i + r.n - 1] = true;
  }
  return ok;
}

/** Revisa la escritura; devuelve también qué alcanzó a revisar (si se acaba el tope, lo demás sigue después). */
async function reviewTexts(products: any[], categories: string[], all: any[] = products): Promise<{ findings: Omit<Finding, 'id' | 'status' | 'createdAt'>[]; doneIds: string[]; doneCategories: string[] }> {
  const out: Omit<Finding, 'id' | 'status' | 'createdAt'>[] = [];
  const doneIds: string[] = [];
  const doneCategories: string[] = [];
  const items: { n: number; p?: any; category?: string }[] = [
    ...products.map((p, i) => ({ n: i + 1, p })),
    ...categories.map((c, i) => ({ n: products.length + i + 1, category: c }))
  ];
  for (let i = 0; i < items.length; i += TEXT_BATCH) {
    if (!(await budgetLeft())) break;
    const batch = items.slice(i, i + TEXT_BATCH);
    const list = batch.map(x => x.p
      ? JSON.stringify({ n: x.n, nombre: x.p.name, ...(x.p.web?.name ? { nombre_web: x.p.web.name } : {}), ...(x.p.web?.description ? { texto_web: x.p.web.description } : {}) })
      : JSON.stringify({ n: x.n, categoria: x.category }));
    const result = await askJson<{ correcciones: { n: number; campo: string; corregido: string; motivo: string }[] }>({
      purpose: PURPOSE, schemaName: 'escritura_del_catalogo', schema: TEXT_SCHEMA, system: TEXT_RULES, maxTokens: 6000,
      user: `Productos y categorías (uno por línea):\n${list.join('\n')}`
    });
    for (const c of result.correcciones || []) {
      const item = batch.find(x => x.n === c.n);
      const field = FIELD_OF[c.campo];
      if (!item || !field || (item.category !== undefined) !== (field === 'category')) continue;
      const current = item.p ? fieldValue(item.p, field) : String(item.category);
      const ok = acceptCorrection(current, c.corregido);
      if (!ok) continue;
      // Un nombre nunca puede quedar igual al de otro producto ("VELA GRADUADO" → "VELA GRADUADA" ya existe).
      if (field === 'name' && all.some(o => o.id !== item.p.id && plain(o.name) === plain(ok.text))) continue;
      out.push({
        productId: item.p ? item.p.id : '', product: item.p ? item.p.name : `Categoría ${current}`, image: item.p?.image_url || '', kind: 'ortografia', field,
        current, suggested: ok.text, accentsOnly: ok.accentsOnly, detail: String(c.motivo || '').slice(0, 160) || 'Error de escritura'
      });
    }
    for (const x of batch) {
      if (x.p) doneIds.push(x.p.id);
      else if (x.category !== undefined) doneCategories.push(x.category);
    }
  }
  const verified = out.length ? await verifyCorrections(out.map(f => ({ current: f.current!, suggested: f.suggested! }))) : [];
  return { findings: out.filter((_, i) => verified[i]), doneIds, doneCategories };
}

/** Lo que las palabras aprendidas corrigen en todo el catálogo (nombre y textos de la web). Sin efectos. */
export function propagatedFindings(products: any[], words: Record<string, string>): Omit<Finding, 'id' | 'status' | 'createdAt'>[] {
  const out: Omit<Finding, 'id' | 'status' | 'createdAt'>[] = [];
  for (const p of products) {
    for (const field of ['name', 'web.name', 'web.description'] as Field[]) {
      const current = fieldValue(p, field);
      if (!current) continue;
      const fixed = applyWordFixes(current, words);
      if (fixed === current) continue;
      const ok = acceptCorrection(current, fixed);
      if (!ok || !ok.accentsOnly) continue;
      if (field === 'name' && products.some(o => o.id !== p.id && plain(o.name) === plain(ok.text) && o.name === ok.text)) continue;
      out.push({ productId: p.id, product: p.name, image: p.image_url || '', kind: 'ortografia', field, current, suggested: ok.text, accentsOnly: true, detail: 'La misma corrección que en otros productos del catálogo.' });
    }
  }
  return out;
}

// ---------- IA: fotos ----------

const PHOTO_RULES = [
  'Revisas las FOTOS del catálogo de una tienda. Cada foto viene con el producto que debería mostrar (nombre y precio del catálogo).',
  '- "coincide": false SOLO si la foto muestra claramente otra cosa (por ejemplo el nombre dice fantasma y la foto es un pollito, o el nombre escrito en la foto es de otro producto). Si trae nombre de la web, revísalo también: si ese nombre no es lo que muestra la foto (dice paloma y la foto son esferas), también es false. Si el nombre es abstracto o no estás segura, true.',
  '- "precio_en_foto": el precio principal escrito en la foto (solo el número, por ejemplo 38), o null si la foto no trae precio.',
  '- No marques detalles chicos que no se distinguen bien en la foto (un rosario, un moño, una medalla, el color exacto): solo cuando la figura principal es otra (un oso en vez de un león, elefantes en vez de una virgen).',
  '- "muestra": qué se ve, en pocas palabras ("pollito saliendo del cascarón").',
  '- "problema": si no coincide, explícalo en una frase simple; si coincide, vacío.'
].join('\n');

const PHOTO_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['fotos'],
  properties: {
    fotos: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false, required: ['n', 'coincide', 'precio_en_foto', 'muestra', 'problema'],
        properties: { n: { type: 'integer' }, coincide: { type: 'boolean' }, precio_en_foto: { type: ['number', 'null'] }, muestra: { type: 'string' }, problema: { type: 'string' } }
      }
    }
  }
};

/** De lo que vio la IA en las fotos a lo que hay que revisar (foto de otro producto, precio distinto en la foto). Sin efectos. */
export function photoFindings(batch: any[], fotos: { n: number; coincide: boolean; precio_en_foto: number | null; muestra: string; problema: string }[]) {
  const out: Omit<Finding, 'id' | 'status' | 'createdAt'>[] = [];
  for (const f of fotos || []) {
    const p = batch[f.n - 1];
    if (!p) continue;
    if (f.coincide === false) {
      out.push({ productId: p.id, product: p.name, image: p.image_url, kind: 'foto', detail: (String(f.problema || '').trim() || `La foto muestra ${String(f.muestra || 'otra cosa')}.`).slice(0, 220) });
    }
    const price = Number(f.precio_en_foto);
    if (f.precio_en_foto !== null && Number.isFinite(price) && price > 0 && Math.abs(price - Number(p.price)) > 0.009) {
      out.push({ productId: p.id, product: p.name, image: p.image_url, kind: 'precio_foto', detail: `La foto dice $${price} y el catálogo cobra $${Number(p.price)}. Cambia la foto o el precio para que digan lo mismo.` });
    }
  }
  return out;
}

async function reviewPhotos(products: any[]): Promise<{ findings: Omit<Finding, 'id' | 'status' | 'createdAt'>[]; done: string[] }> {
  const findings: Omit<Finding, 'id' | 'status' | 'createdAt'>[] = [];
  const done: string[] = [];
  for (let i = 0; i < products.length; i += PHOTO_BATCH) {
    if (!(await budgetLeft())) break;
    const batch = products.slice(i, i + PHOTO_BATCH);
    const ask = (list: any[]) => askJson<{ fotos: any[] }>({
      purpose: PURPOSE, schemaName: 'fotos_del_catalogo', schema: PHOTO_SCHEMA, system: PHOTO_RULES, maxTokens: 3000,
      user: `Fotos a revisar:\n${list.map((p, k) => `${k + 1}) ${p.name}${p.web?.name ? ` (en la web: ${p.web.name})` : ''} · $${Number(p.price)} · ${p.category}`).join('\n')}`,
      images: list.map((p, k) => ({ label: `Foto ${k + 1}:`, url: p.image_url }))
    });
    try {
      findings.push(...photoFindings(batch, (await ask(batch)).fotos));
      done.push(...batch.map(p => p.id));
    } catch (error: any) {
      // Sin saldo o clave mala: se para. Si es una foto que no abre, se revisan de a una y la que falla queda anotada.
      if (/quota|billing|credit|401|429/i.test(String(error?.message))) throw error;
      for (const p of batch) {
        if (!(await budgetLeft())) break;
        try {
          findings.push(...photoFindings([p], (await ask([p])).fotos));
        } catch {
          findings.push({ productId: p.id, product: p.name, image: p.image_url, kind: 'foto', detail: 'No se pudo abrir la foto: revisa que exista o vuelve a subirla.' });
        }
        done.push(p.id);
      }
    }
  }
  return { findings, done };
}

// ---------- Aplicar y deshacer ----------

async function setField(productIdOrCategory: string, field: Field, from: string, to: string, products: any[]): Promise<void> {
  if (field === 'category') {
    const list = products.filter(p => p.category === from);
    for (const p of list) await updateProduct(p.id, { category: to });
    scheduleWebPush();
    return;
  }
  const p = products.find(x => x.id === productIdOrCategory);
  if (!p) throw new Error('El producto ya no está en el catálogo.');
  if (fieldValue(p, field) !== from) throw new Error('Ese texto ya cambió en el catálogo: no se tocó.');
  if (field === 'name') {
    if (products.some(o => o.id !== p.id && plain(o.name) === plain(to))) throw new Error('Ya hay otro producto con ese nombre.');
    await updateProduct(p.id, { name: to });
    await renameProductInAds(from, to).catch(error => console.warn('⚠️ No se renombró el producto en los anuncios:', error.message));
    scheduleWebPush();
    return;
  }
  await setProductWeb(p.id, field === 'web.name' ? { name: to } : { description: to });
}

const busy = new Set<string>();
const tenantKey = () => currentTenant()?.businessId || 'velamia';

async function locked<T>(fn: () => Promise<T>): Promise<T> {
  const key = tenantKey();
  if (busy.has(key)) throw new Error('El supervisor ya está revisando el catálogo: espera un momento.');
  busy.add(key);
  try {
    return await fn();
  } finally {
    busy.delete(key);
  }
}

async function applyOne(f: Finding, products: any[], auto: boolean): Promise<void> {
  if (f.kind !== 'ortografia' || !f.field || f.current === undefined || f.suggested === undefined) throw new Error('Esto se corrige en el Catálogo (foto o precio).');
  await setField(f.productId, f.field, f.current, f.suggested, products);
  f.status = 'aplicado';
  f.auto = auto;
  f.decidedAt = nowIso();
  // Lo que se cambió ya no se vuelve a revisar como si fuera nuevo.
  const p = products.find(x => x.id === f.productId);
  if (p && f.field !== 'category') {
    if (f.field === 'name') p.name = f.suggested;
    else p.web = { ...(p.web || {}), [f.field === 'web.name' ? 'name' : 'description']: f.suggested };
  }
  if (f.field === 'category') for (const x of products) if (x.category === f.current) x.category = f.suggested;
}

/** Aplica, ignora o deshace una cosa de la lista (o todas las de escritura pendientes con id "todas"). */
export async function decideFinding(id: string, action: 'aplicar' | 'ignorar' | 'deshacer' | 'resuelto'): Promise<ReviewState> {
  return locked(async () => {
    const s = await readState();
    const products: any[] = await getAllProducts();
    const targets = id === 'todas'
      ? s.findings.filter(f => f.status === 'pendiente' && f.kind === 'ortografia')
      : s.findings.filter(f => f.id === id);
    if (!targets.length) throw new Error('No se encontró eso en la revisión del catálogo.');
    const errors: string[] = [];
    for (const f of targets) {
      try {
        if (action === 'aplicar') await applyOne(f, products, false);
        else if (action === 'ignorar' || action === 'resuelto') { f.status = 'ignorado'; f.decidedAt = nowIso(); }
        else if (action === 'deshacer') {
          if (f.status !== 'aplicado' || !f.field || f.current === undefined || f.suggested === undefined) throw new Error('Solo se deshace un cambio ya aplicado.');
          await setField(f.productId, f.field, f.suggested, f.current, products);
          // Si se deshace, esas palabras ya no se corrigen solas en otros productos.
          for (const word of Object.keys(wordFixes([{ current: f.current, suggested: f.suggested }]))) delete s.words[word];
          f.status = 'deshecho';
          f.decidedAt = nowIso();
        }
      } catch (error: any) {
        errors.push(`${f.product}: ${error.message}`);
      }
    }
    // Lo que se cambió aquí no cuenta como "cambiado" para la próxima revisión.
    for (const p of products) if (s.checked[p.id]?.t) s.checked[p.id].t = textPrint(p);
    await writeState(s);
    if (errors.length && targets.length === 1) throw new Error(errors[0]);
    return s;
  });
}

export async function setAutoFix(on: boolean, enabled?: boolean): Promise<ReviewState> {
  const s = await readState();
  s.autoFix = on;
  if (typeof enabled === 'boolean') s.enabled = enabled;
  await writeState(s);
  return s;
}

// ---------- La revisión ----------

/**
 * Revisa lo nuevo o cambiado del catálogo (escritura y fotos) y lo que se ve sin IA. Con "corrección automática", lo
 * que es solo de tildes, ñ o ü se aplica de una vez. Respeta su tope diario: lo que falte sigue en la próxima pasada.
 */
export async function reviewCatalog(opts: { full?: boolean } = {}): Promise<{ checkedTexts: number; checkedPhotos: number; found: number; applied: number; remaining: number; budgetReached: boolean }> {
  return locked(async () => {
    const s = await readState();
    const products: any[] = (await getAllProducts()).filter((p: any) => p?.id && p?.name);
    if (opts.full) { s.checked = {}; s.checkedCategories = []; }
    const now = nowIso();
    const known = new Set(s.findings.map(findingKey));
    const add = (list: Omit<Finding, 'id' | 'status' | 'createdAt'>[]) => {
      let n = 0;
      for (const f of list) {
        const key = findingKey(f);
        if (known.has(key)) continue;
        known.add(key);
        s.findings.push({ ...f, id: randomUUID(), status: 'pendiente', createdAt: now });
        n++;
      }
      return n;
    };

    // Sin IA: se recalcula siempre; lo que ya no pasa se quita de lo pendiente.
    const plainNow = plainFindings(products);
    const plainKeys = new Set(plainNow.map(findingKey));
    s.findings = s.findings.filter(f => !(f.status === 'pendiente' && ['nombre_repetido', 'foto_repetida', 'sin_foto'].includes(f.kind) && !plainKeys.has(findingKey(f))));
    let found = add(plainNow);

    // Lo pendiente de un producto que cambió ya no vale: se vuelve a revisar.
    const byId = new Map(products.map(p => [p.id, p]));
    const categoriesNow = new Set(products.map(p => String(p.category || '')));
    s.findings = s.findings.filter(f => {
      if (f.status !== 'pendiente') return true;
      if (!f.productId) return f.field !== 'category' || categoriesNow.has(String(f.current));
      const p = byId.get(f.productId);
      if (!p) return false;
      if (f.kind === 'ortografia') return s.checked[p.id]?.t === textPrint(p);
      if (f.kind === 'foto' || f.kind === 'precio_foto') return s.checked[p.id]?.f === photoPrint(p);
      return true;
    });

    const textQueue = products.filter(p => s.checked[p.id]?.t !== textPrint(p)).slice(0, TEXT_PER_RUN);
    const categories = [...new Set(products.map(p => String(p.category || '')).filter(Boolean))].filter(c => !s.checkedCategories.includes(c));
    const photoQueue = products.filter(p => p.image_url && s.checked[p.id]?.f !== photoPrint(p)).slice(0, PHOTOS_PER_RUN);
    let budgetReached = false;
    let checkedTexts = 0;
    let checkedPhotos = 0;
    try {
      if (textQueue.length || categories.length) {
        const texts = await reviewTexts(textQueue, categories, products);
        found += add(texts.findings);
        // Las palabras corregidas (solo tildes) se aprenden para corregirlas igual en todo el catálogo.
        Object.assign(s.words, wordFixes(texts.findings.filter(f => f.accentsOnly && f.field !== 'category').map(f => ({ current: f.current!, suggested: f.suggested! }))));
        for (const id of texts.doneIds) {
          const p = byId.get(id);
          if (p) s.checked[id] = { ...(s.checked[id] || {}), t: textPrint(p) };
        }
        s.checkedCategories = [...new Set([...s.checkedCategories, ...texts.doneCategories])];
        checkedTexts = texts.doneIds.length;
        if (texts.doneIds.length < textQueue.length || texts.doneCategories.length < categories.length) budgetReached = true;
      }
      if (photoQueue.length) {
        const photos = await reviewPhotos(photoQueue);
        found += add(photos.findings);
        for (const id of photos.done) {
          const p = byId.get(id);
          if (p) s.checked[id] = { ...(s.checked[id] || {}), f: photoPrint(p) };
        }
        checkedPhotos = photos.done.length;
        if (photos.done.length < photoQueue.length) budgetReached = true;
      }
      s.lastError = '';
    } catch (error: any) {
      s.lastError = String(error?.message || error).slice(0, 220);
    }

    // Las palabras aprendidas (y las que siempre llevan tilde) se corrigen igual en todo el catálogo; con la corrección
    // automática, lo que es solo de tildes, ñ y ü se aplica (nunca una categoría). Dos vueltas: la segunda alcanza los
    // textos que ya tenían otra corrección pendiente.
    let applied = 0;
    for (let round = 0; round < 2; round++) {
      const open = new Set(s.findings.filter(f => f.status === 'pendiente' && f.kind === 'ortografia').map(f => `${f.productId}|${f.field}`));
      found += add(propagatedFindings(products, s.words).filter(f => !open.has(`${f.productId}|${f.field}`)));
      if (!s.autoFix) break;
      for (const f of s.findings.filter(x => x.status === 'pendiente' && x.kind === 'ortografia' && x.accentsOnly && x.field !== 'category')) {
        try {
          await applyOne(f, products, true);
          applied++;
        } catch (error: any) {
          f.detail = `${f.detail} (no se aplicó: ${error.message})`.slice(0, 220);
          f.accentsOnly = false;
        }
      }
    }
    if (s.autoFix) for (const p of products) if (s.checked[p.id]?.t) s.checked[p.id].t = textPrint(p);
    s.lastRunAt = now;
    await writeState(s);
    const remaining = products.filter(p => s.checked[p.id]?.t !== textPrint(p) || (p.image_url && s.checked[p.id]?.f !== photoPrint(p))).length;
    if (found || applied) console.log(`🕯️ Revisión del catálogo: ${found} cosa(s) nueva(s), ${applied} corrección(es) aplicada(s)`);
    return { checkedTexts, checkedPhotos, found, applied, remaining, budgetReached };
  });
}

/** Para el CRM: lo pendiente, lo aplicado (con deshacer) y cuánto falta revisar. */
export async function catalogOverview() {
  const s = await readState();
  const products: any[] = await getAllProducts().catch(() => []);
  const remaining = products.filter(p => s.checked[p.id]?.t !== textPrint(p) || (p.image_url && s.checked[p.id]?.f !== photoPrint(p))).length;
  return {
    enabled: s.enabled, autoFix: s.autoFix, lastRunAt: s.lastRunAt || null, lastError: s.lastError, total: products.length, remaining,
    pending: s.findings.filter(f => f.status === 'pendiente'),
    done: s.findings.filter(f => f.status !== 'pendiente').slice(0, 60),
    spentToday: await catalogSpentToday().catch(() => 0), dailyBudget: CATALOG_DAILY_BUDGET
  };
}

/** Cuántas cosas del catálogo esperan a la dueña (para el aviso del supervisor). */
export async function pendingCatalogCount(): Promise<number> {
  // Pausada, no se menciona en el reporte: los avisos viejos hacían creer que seguía revisando sola.
  const state = await readState();
  return state.enabled ? state.findings.filter(f => f.status === 'pendiente').length : 0;
}

const lastRun = new Map<string, number>();

/** La llama el supervisor en cada vuelta: una revisión por hora, solo de lo nuevo o cambiado. */
export async function catalogTick(now = new Date()): Promise<void> {
  const key = tenantKey();
  if (now.getTime() - (lastRun.get(key) || 0) < RUN_EVERY_MS) return;
  if (!(await readState()).enabled) return;
  lastRun.set(key, now.getTime());
  await reviewCatalog().catch(error => {
    if (!/ya está revisando/.test(error.message)) console.error('❌ Revisión del catálogo:', error.message);
  });
}
