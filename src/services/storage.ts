import { createClient } from '@supabase/supabase-js';
import { randomUUID } from 'crypto';

const supabase = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_KEY!);

export async function uploadBufferToStorage(buffer: Buffer, mimeType: string, bucket: string = 'chat-media'): Promise<string> {
  const ext = mimeType.split('/')[1]?.split(';')[0] || 'bin';
  const fileName = `${randomUUID()}.${ext}`;

  const { error } = await supabase.storage
    .from(bucket)
    .upload(fileName, buffer, { contentType: mimeType });

  if (error) throw new Error(`Error subiendo archivo: ${error.message}`);

  const { data } = supabase.storage.from(bucket).getPublicUrl(fileName);
  return data.publicUrl;
}

/**
 * Borra del almacenamiento las fotos/audios que envió un cliente. Solo toca el bucket
 * indicado: las fotos del catálogo (product-images) nunca se eliminan por borrar un chat.
 */
export async function removeFilesByPublicUrls(urls: string[], bucket: string = 'chat-media'): Promise<number> {
  const marker = `/storage/v1/object/public/${bucket}/`;
  const paths = [...new Set(
    urls
      .filter(url => url.includes(marker))
      .map(url => decodeURIComponent(url.split(marker)[1].split('?')[0]))
  )];
  if (paths.length === 0) return 0;

  const { error } = await supabase.storage.from(bucket).remove(paths);
  if (error) throw new Error(`Error borrando archivos: ${error.message}`);
  return paths.length;
}
