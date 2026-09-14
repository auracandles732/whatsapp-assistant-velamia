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
