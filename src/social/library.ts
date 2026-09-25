import { randomUUID } from 'crypto';
import axios from 'axios';
import { supabase, tenantOp, tenantValue, tenantColumns } from '../services/supabase';
import { currentTenant } from '../services/tenant';
import { profile } from '../config/businessProfile';

/**
 * Biblioteca del agente de redes: fotos y videos que sube la empresa (y, más adelante, las fotos que genere la IA).
 * El archivo va directo del navegador al almacenamiento con un permiso de subida de un solo uso (un video de 50 MB no
 * pasa por el servidor); después se registra aquí. Las fotos del Catálogo no se copian: el agente las usa desde ahí.
 */

export type AssetKind = 'image' | 'video';

export interface SocialAsset {
  id: string;
  kind: AssetKind;
  source: 'upload' | 'generated';
  url: string;
  storage_path: string;
  title: string;
  product_name: string | null;
  width: number | null;
  height: number | null;
  duration_seconds: number | null;
  size_bytes: number | null;
  used_count: number;
  last_used_at: string | null;
  created_at: string;
}

const TABLE = 'social_assets';
const BUCKET = 'product-images';

// Instagram publica reels MP4 o MOV; las fotos, JPG o PNG. El límite de Supabase (plan gratis) es 50 MB por archivo.
export const ALLOWED_TYPES: Record<string, { kind: AssetKind; ext: string; maxBytes: number }> = {
  'image/jpeg': { kind: 'image', ext: 'jpg', maxBytes: 10 * 1024 * 1024 },
  'image/png': { kind: 'image', ext: 'png', maxBytes: 10 * 1024 * 1024 },
  'video/mp4': { kind: 'video', ext: 'mp4', maxBytes: 50 * 1024 * 1024 },
  'video/quicktime': { kind: 'video', ext: 'mov', maxBytes: 50 * 1024 * 1024 }
};

/** Carpeta de la empresa en el almacenamiento: nadie registra un archivo de otra empresa. */
const folder = () => `${currentTenant() ? `${currentTenant()!.businessId}/` : ''}social/`;

export function checkUpload(contentType: string, size: number) {
  const type = ALLOWED_TYPES[contentType];
  if (!type) throw new Error('Solo se pueden subir fotos JPG o PNG y videos MP4 o MOV');
  if (!(size > 0) || size > type.maxBytes) {
    throw new Error(type.kind === 'video' ? 'El video pesa más de 50 MB: recórtalo o bájale la calidad' : 'La foto pesa más de 10 MB');
  }
  return type;
}

/** Permiso para subir un archivo directo al almacenamiento (vale para ese archivo y esa ruta solamente). */
export async function createUpload(contentType: string, size: number) {
  const type = checkUpload(contentType, size);
  const path = `${folder()}${randomUUID()}.${type.ext}`;
  const { data, error } = await supabase.storage.from(BUCKET).createSignedUploadUrl(path);
  if (error || !data) throw new Error(`No se pudo preparar la subida: ${error?.message || 'sin respuesta'}`);
  return { path, uploadUrl: data.signedUrl, publicUrl: supabase.storage.from(BUCKET).getPublicUrl(path).data.publicUrl };
}

/** Registra un archivo ya subido (se comprueba que exista y sea de esta empresa). */
export async function registerAsset(input: { path: unknown; title?: unknown; product_name?: unknown; width?: unknown; height?: unknown; duration_seconds?: unknown; size_bytes?: unknown }) {
  const path = String(input.path || '');
  const ext = path.split('.').pop() || '';
  const type = Object.values(ALLOWED_TYPES).find(t => t.ext === ext);
  if (!type || !path.startsWith(folder()) || path.includes('..') || path.slice(folder().length).includes('/')) throw new Error('Archivo inválido');
  const url = supabase.storage.from(BUCKET).getPublicUrl(path).data.publicUrl;
  const exists = await axios.head(url, { timeout: 15_000 }).then(r => r.status === 200).catch(() => false);
  if (!exists) throw new Error('El archivo no terminó de subirse: vuelve a intentarlo');
  const num = (v: unknown) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : null);
  const { data, error } = await supabase.from(TABLE).insert([{
    id: randomUUID(),
    ...tenantColumns(),
    kind: type.kind,
    source: 'upload',
    url,
    storage_path: path,
    title: String(input.title || '').trim().slice(0, 120),
    product_name: String(input.product_name || '').trim().slice(0, 200) || null,
    width: num(input.width),
    height: num(input.height),
    duration_seconds: num(input.duration_seconds),
    size_bytes: num(input.size_bytes)
  }]).select().single();
  if (error) throw new Error(`Error guardando en la biblioteca: ${error.message}`);
  return data as SocialAsset;
}

export async function listAssets(): Promise<SocialAsset[]> {
  const { data, error } = await supabase.from(TABLE).select('*')
    .filter('business_id', tenantOp(), tenantValue())
    .order('created_at', { ascending: false })
    .limit(300);
  if (error) throw new Error(`Error leyendo la biblioteca: ${error.message}`);
  return (data || []) as SocialAsset[];
}

export async function getAssets(ids: string[]): Promise<SocialAsset[]> {
  if (ids.length === 0) return [];
  const { data, error } = await supabase.from(TABLE).select('*')
    .filter('business_id', tenantOp(), tenantValue())
    .in('id', ids);
  if (error) throw new Error(`Error leyendo la biblioteca: ${error.message}`);
  return (data || []) as SocialAsset[];
}

export async function updateAsset(id: string, changes: { title?: unknown; product_name?: unknown }) {
  const row: Record<string, unknown> = {};
  if (changes.title !== undefined) row.title = String(changes.title).trim().slice(0, 120);
  if (changes.product_name !== undefined) row.product_name = String(changes.product_name || '').trim().slice(0, 200) || null;
  const { data, error } = await supabase.from(TABLE).update(row)
    .eq('id', id).filter('business_id', tenantOp(), tenantValue()).select().maybeSingle();
  if (error) throw new Error(`Error actualizando: ${error.message}`);
  return data as SocialAsset | null;
}

// Publicaciones que todavía pueden salir (o reintentarse): necesitan sus archivos.
const PENDING_POST_STATUSES = ['draft', 'approved', 'publishing', 'failed', 'partial'];

/** Publicaciones pendientes que usan este archivo. */
export async function pendingPostsUsing(asset: { id: string; url: string }): Promise<{ theme: string; scheduled_at: string }[]> {
  const { data, error } = await supabase.from('social_posts').select('theme, scheduled_at, media')
    .filter('business_id', tenantOp(), tenantValue())
    .in('status', PENDING_POST_STATUSES);
  if (error) throw new Error(`Error revisando las publicaciones: ${error.message}`);
  return ((data || []) as any[])
    .filter(p => (Array.isArray(p.media) ? p.media : []).some((m: any) => m?.asset_id === asset.id || m?.url === asset.url))
    .map(p => ({ theme: String(p.theme || 'Publicación'), scheduled_at: String(p.scheduled_at) }));
}

/** Error que el CRM muestra tal cual (no es una falla del servidor). */
export class AssetInUseError extends Error {}

/**
 * Borra el registro y el archivo. Las publicaciones que ya salieron no se ven afectadas (Meta guarda su copia), pero si
 * una que todavía no sale lo usa, no se borra: esa publicación fallaría a su hora.
 */
export async function deleteAsset(id: string): Promise<boolean> {
  const [asset] = await getAssets([id]);
  if (!asset) return false;
  const using = await pendingPostsUsing(asset);
  if (using.length) {
    const when = (iso: string) => new Date(iso).toLocaleDateString('es-EC', { timeZone: profile().business.timezone, day: 'numeric', month: 'short' });
    const list = using.slice(0, 3).map(p => `"${p.theme}" del ${when(p.scheduled_at)}`).join(', ') + (using.length > 3 ? ` y ${using.length - 3} más` : '');
    throw new AssetInUseError(`No se puede borrar: está en ${using.length === 1 ? 'una publicación que todavía no sale' : `${using.length} publicaciones que todavía no salen`} (${list}). Quítalo de ahí o elimina esa publicación primero.`);
  }
  const { data, error } = await supabase.from(TABLE).delete()
    .eq('id', id).filter('business_id', tenantOp(), tenantValue()).select('storage_path');
  if (error) throw new Error(`Error borrando: ${error.message}`);
  const paths = (data || []).map((r: any) => String(r.storage_path)).filter(p => p.startsWith(folder()));
  if (paths.length) await supabase.storage.from(BUCKET).remove(paths);
  return (data || []).length > 0;
}

/** Anota que se usaron en una publicación (el cerebro prefiere lo que menos ha salido). */
export async function markAssetsUsed(ids: string[]) {
  for (const asset of await getAssets(ids)) {
    await supabase.from(TABLE).update({ used_count: (asset.used_count || 0) + 1, last_used_at: new Date().toISOString() })
      .eq('id', asset.id).filter('business_id', tenantOp(), tenantValue());
  }
}
