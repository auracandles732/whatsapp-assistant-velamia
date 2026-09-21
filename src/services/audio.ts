import { spawn } from 'child_process';
import { mkdtemp, writeFile, readFile, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

/**
 * WhatsApp solo reproduce como nota de voz el audio OGG con códec Opus. Los navegadores graban en otros formatos
 * (Chrome en webm, Safari en mp4), así que se convierte aquí sea cual sea el original.
 */
export async function toWhatsAppVoice(input: Buffer): Promise<Buffer> {
  const ffmpeg: string | null = require('ffmpeg-static');
  if (!ffmpeg) throw new Error('No hay convertidor de audio disponible en el servidor');

  const dir = await mkdtemp(join(tmpdir(), 'voz-'));
  try {
    const source = join(dir, 'entrada');
    const target = join(dir, 'nota.ogg');
    await writeFile(source, input);
    await new Promise<void>((resolve, reject) => {
      const proc = spawn(ffmpeg, ['-y', '-i', source, '-vn', '-c:a', 'libopus', '-b:a', '32k', '-ar', '48000', '-ac', '1', '-f', 'ogg', target]);
      let errors = '';
      proc.stderr.on('data', chunk => { errors += chunk; });
      proc.on('error', reject);
      proc.on('close', code => (code === 0 ? resolve() : reject(new Error(`No se pudo convertir el audio: ${errors.split('\n').slice(-3).join(' ').trim()}`))));
    });
    return await readFile(target);
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}
