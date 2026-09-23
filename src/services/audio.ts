import { spawn } from 'child_process';
import { mkdtemp, writeFile, readFile, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

/** Solo lo que graban los navegadores: WebM (Chrome, Firefox), OGG y MP4/M4A (Safari). */
export function isRecordedAudio(input: Buffer): boolean {
  if (input.length < 12) return false;
  const webm = input[0] === 0x1a && input[1] === 0x45 && input[2] === 0xdf && input[3] === 0xa3;
  const ogg = input.subarray(0, 4).toString('latin1') === 'OggS';
  const mp4 = input.subarray(4, 8).toString('latin1') === 'ftyp';
  return webm || ogg || mp4;
}

/**
 * WhatsApp solo reproduce como nota de voz el audio OGG con códec Opus. Los navegadores graban en otros formatos
 * (Chrome en webm, Safari en mp4), así que se convierte aquí sea cual sea el original.
 */
export async function toWhatsAppVoice(input: Buffer): Promise<Buffer> {
  // Un archivo disfrazado (por ejemplo una lista de reproducción) podría hacer que el convertidor lea archivos del
  // servidor o visite direcciones de internet: se rechaza todo lo que no sea una grabación.
  if (!isRecordedAudio(input)) throw new Error('El audio no tiene un formato de grabación válido');
  return encodeVoice(input);
}

/** MP3 que devuelve ElevenLabs: se acepta solo si de verdad es MP3 (cabecera ID3 o marco de audio). */
export function isMp3(input: Buffer): boolean {
  if (input.length < 4) return false;
  return input.subarray(0, 3).toString('latin1') === 'ID3' || (input[0] === 0xff && (input[1] & 0xe0) === 0xe0);
}

export async function mp3ToWhatsAppVoice(input: Buffer): Promise<Buffer> {
  if (!isMp3(input)) throw new Error('La voz generada no es un MP3 válido');
  return encodeVoice(input);
}

async function encodeVoice(input: Buffer): Promise<Buffer> {
  const ffmpeg: string | null = require('ffmpeg-static');
  if (!ffmpeg) throw new Error('No hay convertidor de audio disponible en el servidor');

  const dir = await mkdtemp(join(tmpdir(), 'voz-'));
  try {
    const source = join(dir, 'entrada');
    const target = join(dir, 'nota.ogg');
    await writeFile(source, input);
    await new Promise<void>((resolve, reject) => {
      const proc = spawn(ffmpeg, ['-y', '-protocol_whitelist', 'file', '-i', source, '-vn', '-c:a', 'libopus', '-b:a', '32k', '-ar', '48000', '-ac', '1', '-f', 'ogg', target]);
      let errors = '';
      // Un archivo que no termina de convertirse no puede dejar el proceso colgado.
      const timer = setTimeout(() => proc.kill('SIGKILL'), 60_000);
      proc.on('close', () => clearTimeout(timer));
      proc.stderr.on('data', chunk => { errors += chunk; });
      proc.on('error', reject);
      proc.on('close', code => (code === 0 ? resolve() : reject(new Error(`No se pudo convertir el audio: ${errors.split('\n').slice(-3).join(' ').trim()}`))));
    });
    return await readFile(target);
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}
