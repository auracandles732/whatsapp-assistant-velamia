import { randomUUID } from 'crypto';
import {
  supabase, tenantOp, tenantValue, tenantColumns, getConfig, setConfig, getAllProducts, createProduct, updateProduct
} from '../services/supabase';
import { uploadBufferToStorage } from '../services/storage';
import { productKey } from '../services/openai';
import { findPackaging } from '../config/businessProfile';

/**
 * Catálogos de proveedores (PDF): el CRM lee el PDF en el navegador y manda cada modelo con su foto, su nombre, el
 * precio del proveedor y la nota de tamaño si la trae. Aquí se guarda y, en automático, cada modelo pasa al Catálogo
 * con el precio de venta según su tamaño (regla de cada empresa). Así el bot de WhatsApp y el agente de redes lo
 * conocen de inmediato. Cambiar el tamaño después actualiza el precio en el Catálogo.
 */

export type CandleSize = 'pequena' | 'mediana' | 'grande';
export const SIZES: CandleSize[] = ['pequena', 'mediana', 'grande'];

export interface SupplierSettings {
  /** Precio de venta por tamaño (el mismo que usa el Catálogo: por docena, por unidad… según el negocio). 0 = sin definir. */
  sizePrices: Record<CandleSize, number>;
  /** Tamaño que se usa cuando el PDF no lo dice (queda marcado como estimado). */
  defaultSize: CandleSize;
  /** Palabra que va antes del nombre del modelo en el Catálogo ("VELA" → "VELA CALABAZA 1"). */
  namePrefix: string;
  /** Empaque incluido (de los del perfil del negocio) con el que entran al Catálogo. */
  packaging: string;
  /** Pasar cada modelo al Catálogo apenas se sube el PDF. */
  autoAddToCatalog: boolean;
}

export const DEFAULT_SUPPLIER_SETTINGS: SupplierSettings = {
  sizePrices: { pequena: 0, mediana: 0, grande: 0 },
  defaultSize: 'mediana',
  namePrefix: '',
  packaging: '',
  autoAddToCatalog: true
};

const SETTINGS_KEY = 'supplier_settings';
const money = (v: unknown) => (Number.isFinite(Number(v)) && Number(v) >= 0 ? Math.round(Number(v) * 100) / 100 : 0);

export function normalizeSupplierSettings(raw: any): SupplierSettings {
  const r = raw && typeof raw === 'object' ? raw : {};
  const prices = r.sizePrices && typeof r.sizePrices === 'object' ? r.sizePrices : {};
  return {
    sizePrices: { pequena: money(prices.pequena), mediana: money(prices.mediana), grande: money(prices.grande) },
    defaultSize: SIZES.includes(r.defaultSize) ? r.defaultSize : DEFAULT_SUPPLIER_SETTINGS.defaultSize,
    namePrefix: String(r.namePrefix ?? '').replace(/\s+/g, ' ').trim().toUpperCase().slice(0, 20),
    packaging: String(r.packaging ?? '').trim().slice(0, 60),
    autoAddToCatalog: typeof r.autoAddToCatalog === 'boolean' ? r.autoAddToCatalog : true
  };
}

export async function getSupplierSettings(): Promise<SupplierSettings> {
  const raw = await getConfig(SETTINGS_KEY);
  try {
    return normalizeSupplierSettings(raw ? JSON.parse(raw) : {});
  } catch {
    return normalizeSupplierSettings({});
  }
}

export async function saveSupplierSettings(raw: unknown): Promise<SupplierSettings> {
  const settings = normalizeSupplierSettings(raw);
  if (settings.packaging && !findPackaging(settings.packaging)) throw new Error('Ese empaque no está en el perfil del negocio');
  await setConfig(SETTINGS_KEY, JSON.stringify(settings));
  return settings;
}

/**
 * Tamaño según la nota del PDF: primero el peso en cera ("Peso en cera: 85 g"), si no la medida ("7,8 x 5,8 cm").
 * Referencias del primer catálogo: 85 g / 7,8×5,8 = grande · 40 g / 6,5×5,5 = mediana · 31,5 g / 7×4,5 = pequeña.
 */
export function sizeFromNote(note: string): CandleSize | null {
  const text = String(note || '').toLowerCase().replace(/,/g, '.');
  const grams = text.match(/(\d+(?:\.\d+)?)\s*(?:g|gr|gramos)\b/);
  if (grams) {
    const g = Number(grams[1]);
    return g >= 70 ? 'grande' : g >= 38 ? 'mediana' : 'pequena';
  }
  const cm = text.match(/(\d+(?:\.\d+)?)\s*x\s*(\d+(?:\.\d+)?)\s*cm/);
  if (cm) {
    const area = Number(cm[1]) * Number(cm[2]);
    return area >= 40 ? 'grande' : area >= 33 ? 'mediana' : 'pequena';
  }
  return null;
}

/** Nombre con el que entra al Catálogo: en mayúsculas, con la palabra de la empresa delante y sin repetir. */
export function catalogName(name: string, prefix: string, taken: Set<string>): string {
  const clean = String(name || '').replace(/\*/g, '').replace(/\s+/g, ' ').trim().toUpperCase();
  const base = prefix && !clean.startsWith(prefix + ' ') && clean !== prefix ? `${prefix} ${clean}` : clean;
  let candidate = base;
  for (let n = 2; taken.has(productKey(candidate)); n++) candidate = `${base} ${n}`;
  taken.add(productKey(candidate));
  return candidate;
}

export interface ImportedProduct { name: unknown; page?: unknown; supplierPrice?: unknown; sizeNote?: unknown; imageBase64?: unknown }

export interface SupplierProduct {
  id: string;
  catalog_id: string;
  name: string;
  supplier_name: string;
  page: number | null;
  supplier_price: number | null;
  size: CandleSize;
  size_estimated: boolean;
  size_note: string;
  image_url: string;
  status: 'nuevo' | 'en_catalogo' | 'descartado';
  catalog_product_id: string | null;
}

const CATALOGS = 'supplier_catalogs';
const PRODUCTS = 'supplier_products';
const MAX_PRODUCTS = 300;

/** Guarda la foto del modelo (JPG o PNG que manda el navegador, sin la marca de agua del PDF). */
async function storeImage(base64: unknown): Promise<string> {
  const match = String(base64 || '').match(/^data:(image\/(?:jpeg|png));base64,(.+)$/);
  if (!match) return '';
  const buffer = Buffer.from(match[2], 'base64');
  if (buffer.length > 3 * 1024 * 1024) return '';
  return uploadBufferToStorage(buffer, match[1], 'product-images');
}

/** Pasa un modelo al Catálogo con su precio por tamaño. Devuelve el id del producto creado ('' si falta el precio). */
async function toCatalog(product: { name: string; size: CandleSize; image_url: string }, category: string, settings: SupplierSettings): Promise<string> {
  const price = settings.sizePrices[product.size];
  if (!(price > 0)) return '';
  const created: any = await createProduct(product.name, price, category, product.image_url || undefined, settings.packaging);
  return String(created?.id || '');
}

/** El catálogo de proveedor al que se le siguen agregando modelos (el CRM los manda por partes). */
async function existingCatalog(id: unknown) {
  const { data, error } = await supabase.from(CATALOGS).select('*').eq('id', String(id)).filter('business_id', tenantOp(), tenantValue()).maybeSingle();
  if (error) throw new Error(`Error leyendo el catálogo: ${error.message}`);
  if (!data) throw new Error('El catálogo ya no existe: vuelve a subir el PDF');
  return data;
}

/**
 * Importa un catálogo de proveedor ya leído por el CRM (en una o varias partes: con catalogId se agregan al mismo).
 * Los modelos sin nombre se descartan y los nombres nunca se repiten en el Catálogo.
 */
export async function importSupplierCatalog(input: { catalogId?: unknown; name?: unknown; supplier?: unknown; fileName?: unknown; pages?: unknown; products?: unknown }) {
  const settings = await getSupplierSettings();
  const category = String(input.name || '').replace(/\s+/g, ' ').trim().toUpperCase().slice(0, 60);
  if (!category) throw new Error('Escribe el nombre del catálogo (será la categoría en el Catálogo)');
  const items = (Array.isArray(input.products) ? input.products : []).slice(0, MAX_PRODUCTS) as ImportedProduct[];
  const valid = items.filter(p => String(p?.name || '').trim());
  if (valid.length === 0) throw new Error('No se encontraron modelos en el PDF');

  let catalog: any;
  if (input.catalogId) {
    catalog = await existingCatalog(input.catalogId);
  } else {
    const { data, error } = await supabase.from(CATALOGS).insert([{
      id: randomUUID(),
      ...tenantColumns(),
      name: category,
      supplier: String(input.supplier || '').trim().slice(0, 80),
      file_name: String(input.fileName || '').trim().slice(0, 160),
      pages: Number.isFinite(Number(input.pages)) ? Number(input.pages) : null
    }]).select().single();
    if (error || !data) throw new Error(`Error guardando el catálogo: ${error?.message || 'sin respuesta'}`);
    catalog = data;
  }

  // Nombres ya usados: los del Catálogo y los de los modelos de proveedores (aunque todavía no hayan pasado al Catálogo).
  const [existing, { products: supplierProducts }] = await Promise.all([getAllProducts(), listSupplierCatalogs()]);
  const taken = new Set<string>([...existing.map((p: any) => productKey(p.name)), ...supplierProducts.map(p => productKey(p.name))]);
  const summary = { catalog, total: 0, added: 0, estimated: 0, withoutPrice: 0 };
  for (const item of valid) {
    const supplierName = String(item.name).replace(/\s+/g, ' ').trim().slice(0, 120);
    const detected = sizeFromNote(String(item.sizeNote || ''));
    const size = detected || settings.defaultSize;
    const row: any = {
      id: randomUUID(),
      ...tenantColumns(),
      catalog_id: catalog.id,
      supplier_name: supplierName,
      name: catalogName(supplierName, settings.namePrefix, taken),
      page: Number.isFinite(Number(item.page)) ? Number(item.page) : null,
      supplier_price: money(item.supplierPrice) || null,
      size,
      size_estimated: !detected,
      size_note: String(item.sizeNote || '').trim().slice(0, 200),
      image_url: await storeImage(item.imageBase64).catch(() => ''),
      status: 'nuevo',
      catalog_product_id: null
    };
    if (settings.autoAddToCatalog) {
      const productId = await toCatalog(row, String(catalog.name || category), settings);
      if (productId) {
        row.status = 'en_catalogo';
        row.catalog_product_id = productId;
        summary.added++;
      } else {
        summary.withoutPrice++;
      }
    }
    const { error: rowError } = await supabase.from(PRODUCTS).insert([row]);
    if (rowError) throw new Error(`Error guardando los modelos: ${rowError.message}`);
    summary.total++;
    if (!detected) summary.estimated++;
  }
  return summary;
}

export async function listSupplierCatalogs() {
  const [catalogs, products] = await Promise.all([
    supabase.from(CATALOGS).select('*').filter('business_id', tenantOp(), tenantValue()).order('created_at', { ascending: false }),
    supabase.from(PRODUCTS).select('*').filter('business_id', tenantOp(), tenantValue()).order('page', { ascending: true }).limit(2000)
  ]);
  if (catalogs.error) throw new Error(`Error leyendo catálogos de proveedores: ${catalogs.error.message}`);
  if (products.error) throw new Error(`Error leyendo modelos: ${products.error.message}`);
  return { catalogs: catalogs.data || [], products: (products.data || []) as SupplierProduct[] };
}

async function getSupplierProduct(id: string): Promise<SupplierProduct | null> {
  const { data, error } = await supabase.from(PRODUCTS).select('*').eq('id', id).filter('business_id', tenantOp(), tenantValue()).maybeSingle();
  if (error) throw new Error(`Error leyendo el modelo: ${error.message}`);
  return data as SupplierProduct | null;
}

/** Cambia el tamaño o el nombre de un modelo; si ya está en el Catálogo, también cambia ahí (precio incluido). */
export async function updateSupplierProduct(id: string, changes: { size?: unknown; name?: unknown }) {
  const current = await getSupplierProduct(id);
  if (!current) return null;
  const settings = await getSupplierSettings();
  const row: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (changes.size !== undefined) {
    if (!SIZES.includes(changes.size as CandleSize)) throw new Error('Tamaño inválido');
    row.size = changes.size;
    row.size_estimated = false;
  }
  if (changes.name !== undefined) {
    const name = String(changes.name).replace(/\*/g, '').replace(/\s+/g, ' ').trim().toUpperCase().slice(0, 120);
    if (!name) throw new Error('El nombre no puede quedar vacío');
    row.name = name;
  }
  const { data, error } = await supabase.from(PRODUCTS).update(row).eq('id', id).filter('business_id', tenantOp(), tenantValue()).select().single();
  if (error) throw new Error(`Error actualizando el modelo: ${error.message}`);
  if (current.status === 'en_catalogo' && current.catalog_product_id) {
    const updates: Record<string, any> = {};
    if (row.size) {
      const price = settings.sizePrices[row.size as CandleSize];
      if (price > 0) updates.price = price;
    }
    if (row.name) updates.name = row.name;
    if (Object.keys(updates).length) await updateProduct(current.catalog_product_id, updates);
  }
  return data as SupplierProduct;
}

/** Pasa al Catálogo los modelos indicados (o todos los que falten de un catálogo). */
export async function addSupplierProductsToCatalog(ids: string[]) {
  const settings = await getSupplierSettings();
  const { catalogs, products } = await listSupplierCatalogs();
  const byId = new Map(catalogs.map((c: any) => [c.id, c]));
  const existing = new Set((await getAllProducts()).map((p: any) => productKey(p.name)));
  let added = 0, withoutPrice = 0, alreadyThere = 0;
  for (const product of products.filter(p => ids.includes(p.id) && p.status !== 'en_catalogo')) {
    if (existing.has(productKey(product.name))) { alreadyThere++; continue; }
    const catalog: any = byId.get(product.catalog_id);
    const productId = await toCatalog(product, String(catalog?.name || 'PROVEEDOR'), settings);
    if (!productId) { withoutPrice++; continue; }
    existing.add(productKey(product.name));
    await supabase.from(PRODUCTS).update({ status: 'en_catalogo', catalog_product_id: productId, updated_at: new Date().toISOString() })
      .eq('id', product.id).filter('business_id', tenantOp(), tenantValue());
    added++;
  }
  return { added, withoutPrice, alreadyThere };
}

/** Borra un catálogo de proveedor y sus modelos. Lo que ya pasó al Catálogo se queda ahí. */
export async function deleteSupplierCatalog(id: string): Promise<boolean> {
  const { data, error } = await supabase.from(CATALOGS).delete().eq('id', id).filter('business_id', tenantOp(), tenantValue()).select('id');
  if (error) throw new Error(`Error borrando el catálogo: ${error.message}`);
  return (data || []).length > 0;
}
