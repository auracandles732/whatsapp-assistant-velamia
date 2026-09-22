import axios from 'axios';
import { spawn } from 'child_process';
import { mkdtemp, writeFile, readFile, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY || '';
const ELEVENLABS_VOICE_ID = process.env.ELEVENLABS_VOICE_ID || 'tTQzD8U9VSnJgfwC6HbY';

/**
 * Convierte texto a audio MP3 usando Elevenlabs, luego lo convierte a OGG Opus
 * (formato que WhatsApp acepta como nota de voz).
 */
export async function textToVoice(text: string): Promise<Buffer> {
  if (!ELEVENLABS_API_KEY) {
    throw new Error('ELEVENLABS_API_KEY no configurada');
  }

  // 1. Obtener MP3 de Elevenlabs
  const mp3 = await textToMp3(text);

  // 2. Convertir MP3 a OGG Opus (formato WhatsApp)
  return await mp3ToWhatsAppVoice(mp3);
}

async function textToMp3(text: string): Promise<Buffer> {
  const response = await axios.post(
    `https://api.elevenlabs.io/v1/text-to-speech/${ELEVENLABS_VOICE_ID}`,
    {
      text,
      model_id: 'eleven_monolingual_v1',
      voice_settings: {
        stability: 0.5,
        similarity_boost: 0.75
      }
    },
    {
      headers: {
        'xi-api-key': ELEVENLABS_API_KEY,
        'Content-Type': 'application/json'
      },
      responseType: 'arraybuffer',
      timeout: 30_000
    }
  );

  return Buffer.from(response.data);
}

/**
 * Convierte MP3 a OGG Opus (igual que toWhatsAppVoice pero para archivos descargados).
 */
async function mp3ToWhatsAppVoice(mp3: Buffer): Promise<Buffer> {
  const ffmpeg: string | null = require('ffmpeg-static');
  if (!ffmpeg) throw new Error('ffmpeg no disponible');

  const dir = await mkdtemp(join(tmpdir(), 'elevenlabs-'));
  try {
    const source = join(dir, 'input.mp3');
    const target = join(dir, 'output.ogg');
    await writeFile(source, mp3);

    await new Promise<void>((resolve, reject) => {
      const proc = spawn(ffmpeg, [
        '-y',
        '-protocol_whitelist', 'file',
        '-i', source,
        '-vn',
        '-c:a', 'libopus',
        '-b:a', '32k',
        '-ar', '48000',
        '-ac', '1',
        '-f', 'ogg',
        target
      ]);

      let errors = '';
      const timer = setTimeout(() => proc.kill('SIGKILL'), 60_000);
      proc.on('close', () => clearTimeout(timer));
      proc.stderr.on('data', chunk => { errors += chunk; });
      proc.on('error', reject);
      proc.on('close', code => {
        if (code === 0) resolve();
        else reject(new Error(`No se pudo convertir audio: ${errors.split('\n').slice(-3).join(' ').trim()}`));
      });
    });

    return await readFile(target);
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}
