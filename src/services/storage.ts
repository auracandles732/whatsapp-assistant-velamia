import { randomUUID } from 'crypto';
import { supabase } from './supabase';
import { currentTenant } from './tenant';

/** Nombre del archivo dentro del bucket: los de cada negocio van en su propia carpeta. */
export function storagePath(ext: string): string {
  const tenant = currentTenant();
  return `${tenant ? `${tenant.businessId}/` : ''}${randomUUID()}.${ext}`;
}

export async function uploadBufferToStorage(buffer: Buffer, mimeType: string, bucket: string = 'chat-media'): Promise<string> {
  const ext = mimeType.split('/')[1]?.split(';')[0] || 'bin';
  const fileName = storagePath(ext);

  const { error } = await supabase.storage
    .from(bucket)
    .upload(fileName, buffer, { contentType: mimeType });

  if (error) throw new Error(`Error subiendo archivo: ${error.message}`);

  const { data } = supabase.storage.from(bucket).getPublicUrl(fileName);
  return data.publicUrl;
}

/**
 * Borra del almacenamiento las fotos/audios/documentos que envió un cliente. Solo toca el bucket
 * indicado: las fotos del catálogo (product-images) nunca se eliminan por borrar un chat.
 */
export async function removeFilesByPublicUrls(urls: string[], bucket: string = 'chat-media'): Promise<number> {
  const marker = `/storage/v1/object/public/${bucket}/`;
  const paths = [...new Set(
    urls
      .filter(url => url.includes(marker))
      .map(url => decodeURIComponent(url.split(marker)[1].split('?')[0]))
      // Solo archivos propios: un negocio no puede borrar los de otro (ni VELAMIA los de un negocio).
      .filter(path => {
        const tenant = currentTenant();
        return tenant ? path.startsWith(`${tenant.businessId}/`) && !path.includes('..') : !path.includes('/');
      })
  )];
  if (paths.length === 0) return 0;

  const { error } = await supabase.storage.from(bucket).remove(paths);
  if (error) throw new Error(`Error borrando archivos: ${error.message}`);
  return paths.length;
}
