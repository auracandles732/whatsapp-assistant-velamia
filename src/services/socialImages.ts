import axios from 'axios';
import { createHash } from 'crypto';
import { PNG } from 'pngjs';
import jpeg from 'jpeg-js';
import { supabase } from './supabase';
import { currentTenant } from './tenant';

/**
 * Instagram solo publica fotos JPG con proporción entre 4:5 (vertical) y 1.91:1 (horizontal). Las fotos del catálogo
 * suelen ser PNG y algunas son más altas que 4:5: se pasan a JPG sobre fondo blanco y, si hace falta, se les agrega
 * margen blanco a los costados (nunca se recortan: el diseño de la foto trae el precio y el nombre en los bordes).
 */

const MIN_RATIO = 4 / 5;
const MAX_RATIO = 1.91;
const MAX_WIDTH = 1440;
const MAX_DOWNLOAD = 15 * 1024 * 1024;
const JPEG_QUALITY = 90;

export interface RawImage { width: number; height: number; data: Buffer | Uint8Array }

const isPng = (b: Buffer) => b.length > 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47;
const isJpeg = (b: Buffer) => b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;

export function decodeImage(buffer: Buffer): RawImage {
  if (isPng(buffer)) {
    const png = PNG.sync.read(buffer);
    return { width: png.width, height: png.height, data: png.data };
  }
  if (isJpeg(buffer)) {
    const img = jpeg.decode(buffer, { useTArray: true, maxMemoryUsageInMB: 512 });
    return { width: img.width, height: img.height, data: img.data };
  }
  throw new Error('La foto no es PNG ni JPG');
}

/** Tamaño final: margen blanco para entrar en la proporción de Instagram y ancho máximo de 1440. */
export function targetSize(width: number, height: number): { canvasW: number; canvasH: number; scale: number } {
  let canvasW = width, canvasH = height;
  const ratio = width / height;
  if (ratio < MIN_RATIO) canvasW = Math.ceil(height * MIN_RATIO);
  else if (ratio > MAX_RATIO) canvasH = Math.ceil(width / MAX_RATIO);
  const scale = Math.min(1, MAX_WIDTH / canvasW);
  return { canvasW: Math.round(canvasW * scale), canvasH: Math.round(canvasH * scale), scale };
}

/** Pinta la foto centrada sobre un lienzo blanco (con la transparencia mezclada en blanco) y la achica si hace falta. */
export function fitOnWhite(img: RawImage): RawImage {
  const { canvasW, canvasH, scale } = targetSize(img.width, img.height);
  const out = Buffer.alloc(canvasW * canvasH * 4, 255);
  const drawW = Math.round(img.width * scale), drawH = Math.round(img.height * scale);
  const offX = Math.floor((canvasW - drawW) / 2), offY = Math.floor((canvasH - drawH) / 2);
  for (let y = 0; y < drawH; y++) {
    // Muestreo al vecino más cercano: la foto casi nunca se achica y, si pasa, es poco.
    const sy = Math.min(img.height - 1, Math.floor(y / scale));
    for (let x = 0; x < drawW; x++) {
      const sx = Math.min(img.width - 1, Math.floor(x / scale));
      const s = (sy * img.width + sx) * 4, d = ((y + offY) * canvasW + (x + offX)) * 4;
      const a = img.data[s + 3] / 255;
      out[d] = Math.round(img.data[s] * a + 255 * (1 - a));
      out[d + 1] = Math.round(img.data[s + 1] * a + 255 * (1 - a));
      out[d + 2] = Math.round(img.data[s + 2] * a + 255 * (1 - a));
      out[d + 3] = 255;
    }
  }
  return { width: canvasW, height: canvasH, data: out };
}

export function toInstagramJpeg(buffer: Buffer): Buffer {
  const fitted = fitOnWhite(decodeImage(buffer));
  return Buffer.from(jpeg.encode({ width: fitted.width, height: fitted.height, data: fitted.data as Buffer }, JPEG_QUALITY).data);
}

/** Solo se descargan fotos del almacenamiento propio (Supabase): nunca una dirección cualquiera. */
export function isOwnStorageUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    const own = new URL(process.env.SUPABASE_URL || 'http://invalido');
    return parsed.host === own.host && parsed.pathname.startsWith('/storage/v1/object/public/');
  } catch {
    return false;
  }
}

/**
 * Devuelve la dirección pública de la foto lista para Instagram. Si ya sirve tal cual (JPG con buena proporción),
 * se usa la original; si no, se convierte y se guarda en la carpeta de la empresa (el mismo nombre para la misma foto,
 * así no se repite el trabajo ni se llenan de copias).
 */
export async function instagramReadyUrl(imageUrl: string): Promise<string> {
  if (!isOwnStorageUrl(imageUrl)) throw new Error('La foto debe estar en el catálogo del CRM');
  const { data } = await axios.get(imageUrl, { responseType: 'arraybuffer', timeout: 60_000, maxContentLength: MAX_DOWNLOAD });
  const original = Buffer.from(data);
  if (isJpeg(original)) {
    const img = decodeImage(original);
    const ratio = img.width / img.height;
    if (ratio >= MIN_RATIO && ratio <= MAX_RATIO && img.width <= MAX_WIDTH) return imageUrl;
  }

  const jpg = toInstagramJpeg(original);
  const tenant = currentTenant();
  const name = `social-${createHash('sha256').update(imageUrl).digest('hex').slice(0, 24)}.jpg`;
  const path = `${tenant ? `${tenant.businessId}/` : ''}${name}`;
  const { error } = await supabase.storage.from('product-images').upload(path, jpg, { contentType: 'image/jpeg', upsert: true });
  if (error) throw new Error(`No se pudo guardar la foto para Instagram: ${error.message}`);
  return supabase.storage.from('product-images').getPublicUrl(path).data.publicUrl;
}
