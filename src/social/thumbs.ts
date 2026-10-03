import { spawn } from 'child_process';
import { mkdtemp, writeFile, readFile, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import axios from 'axios';
import { supabase } from '../services/supabase';
import { toJpegMax, isOwnStorageUrl } from './images';

/**
 * Miniaturas de la biblioteca: la cuadrícula muestra una foto chica (unos 30 KB) en lugar del archivo completo (fotos de
 * hasta 10 MB y videos de hasta 50 MB, que hacían esperar mucho). Se hacen una sola vez, en segundo plano, y quedan
 * guardadas al lado del archivo: <carpeta>/thumbs/<id>.jpg.
 */

const BUCKET = 'product-images';
const SIDE = 480;
const MAX_IMAGE = 15 * 1024 * 1024;
const MAX_VIDEO = 60 * 1024 * 1024;
// Si una miniatura falla (archivo dañado), no se reintenta en cada visita: espera una hora.
const RETRY_MS = 60 * 60 * 1000;

export interface ThumbSource { id: string; kind: 'image' | 'video'; url: string; storage_path: string }

export const thumbPath = (storagePath: string, id: string) => storagePath.replace(/[^/]*$/, `thumbs/${id}.jpg`);
export const thumbUrl = (storagePath: string, id: string) => supabase.storage.from(BUCKET).getPublicUrl(thumbPath(storagePath, id)).data.publicUrl;

/** Las miniaturas que ya existen en una carpeta de la biblioteca (nombres "<id>.jpg"). */
export async function existingThumbs(folder: string): Promise<Set<string>> {
  const { data, error } = await supabase.storage.from(BUCKET).list(`${folder.replace(/\/$/, '')}/thumbs`, { limit: 1000 });
  if (error || !Array.isArray(data)) return new Set();
  return new Set(data.map(f => String(f.name || '').replace(/\.jpg$/, '')));
}

function runFfmpeg(args: string[]): Promise<void> {
  const ffmpeg: string | null = require('ffmpeg-static');
  if (!ffmpeg) return Promise.reject(new Error('No hay ffmpeg en el servidor'));
  return new Promise((resolve, reject) => {
    const proc = spawn(ffmpeg, args);
    let errors = '';
    const timer = setTimeout(() => proc.kill('SIGKILL'), 90_000);
    proc.stderr.on('data', chunk => { errors += chunk; });
    proc.on('error', reject);
    proc.on('close', code => { clearTimeout(timer); code === 0 ? resolve() : reject(new Error(errors.split('\n').slice(-3).join(' ').trim() || 'ffmpeg falló')); });
  });
}

/** Un cuadro del video (a medio segundo del inicio), achicado. Se descarga el video a un archivo temporal. */
async function videoFrame(url: string): Promise<Buffer> {
  const dir = await mkdtemp(join(tmpdir(), 'miniatura-'));
  try {
    const source = join(dir, 'video');
    const target = join(dir, 'cuadro.jpg');
    const { data } = await axios.get(url, { responseType: 'arraybuffer', timeout: 120_000, maxContentLength: MAX_VIDEO });
    const video = Buffer.from(data);
    // Solo MP4 o MOV de verdad ("ftyp" al inicio): un archivo disfrazado (por ejemplo una lista de reproducción) podría
    // hacer que el convertidor lea otros archivos del servidor.
    if (video.length < 12 || video.subarray(4, 8).toString('latin1') !== 'ftyp') throw new Error('El video no es MP4 ni MOV');
    await writeFile(source, video);
    const scale = `scale='min(${SIDE},iw)':-2`;
    // Solo archivos locales: el video no puede pedirle al convertidor que abra otras direcciones.
    const base = ['-y', '-protocol_whitelist', 'file', '-v', 'error', '-f', 'mov'];
    await runFfmpeg([...base, '-ss', '0.5', '-i', source, '-frames:v', '1', '-vf', scale, '-q:v', '5', target])
      .catch(() => runFfmpeg([...base, '-i', source, '-frames:v', '1', '-vf', scale, '-q:v', '5', target]));
    return await readFile(target);
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

/** Hace la miniatura y la guarda. Devuelve su dirección pública. */
export async function makeThumb(asset: ThumbSource): Promise<string> {
  if (!isOwnStorageUrl(asset.url)) throw new Error('El archivo no es de la biblioteca');
  let jpg: Buffer;
  if (asset.kind === 'video') {
    jpg = await videoFrame(asset.url);
  } else {
    const { data } = await axios.get(asset.url, { responseType: 'arraybuffer', timeout: 60_000, maxContentLength: MAX_IMAGE });
    jpg = toJpegMax(Buffer.from(data), SIDE, 78);
  }
  const { error } = await supabase.storage.from(BUCKET).upload(thumbPath(asset.storage_path, asset.id), jpg, { contentType: 'image/jpeg', upsert: true, cacheControl: '31536000' });
  if (error) throw new Error(`No se pudo guardar la miniatura: ${error.message}`);
  return thumbUrl(asset.storage_path, asset.id);
}

// Una a la vez, para no cargar el servidor (un video se descarga entero para sacar el cuadro).
const queue: ThumbSource[] = [];
const queued = new Set<string>();
const failedAt = new Map<string, number>();
let running = false;

export function queueThumbs(assets: ThumbSource[]) {
  for (const asset of assets) {
    if (queued.has(asset.id)) continue;
    if (Date.now() - (failedAt.get(asset.id) || 0) < RETRY_MS) continue;
    queued.add(asset.id);
    queue.push(asset);
  }
  void drain();
}

async function drain() {
  if (running) return;
  running = true;
  try {
    while (queue.length) {
      const asset = queue.shift()!;
      try {
        await makeThumb(asset);
        failedAt.delete(asset.id);
      } catch (error: any) {
        failedAt.set(asset.id, Date.now());
        console.warn(`⚠️ Miniatura de la biblioteca (${asset.kind} ${asset.id}) no se pudo hacer: ${error.message}`);
      } finally {
        queued.delete(asset.id);
      }
    }
  } finally {
    running = false;
  }
}

/** Borra la miniatura de un archivo (al borrarlo de la biblioteca). */
export async function removeThumb(storagePath: string, id: string) {
  await supabase.storage.from(BUCKET).remove([thumbPath(storagePath, id)]).catch(() => {});
}
