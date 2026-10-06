import axios from 'axios';
import { createHash } from 'crypto';
import { PNG } from 'pngjs';
import jpeg from 'jpeg-js';
import { supabase } from '../services/supabase';
import { currentTenant } from '../services/tenant';

/**
 * Instagram solo publica fotos JPG con proporción entre 4:5 (vertical) y 1.91:1 (horizontal), la cuadrícula del perfil
 * las muestra recortadas a 3:4 y las historias ocupan toda la pantalla (9:16) acercando la foto hasta llenarla.
 * Por eso cada foto del catálogo se arma sobre un lienzo de la medida exacta, con la foto completa al centro y un fondo
 * hecho con la misma foto difuminada: nunca se recorta (el diseño de la foto trae el precio y el nombre en los bordes).
 */

export type ImageKind = 'feed' | 'story';

const LAYOUT: Record<ImageKind, { width: number; height: number; boxW: number; boxH: number }> = {
  // 4:5, lo más alto que acepta Instagram. La foto va dentro del ancho que se ve en la cuadrícula del perfil (3:4).
  feed: { width: 1080, height: 1350, boxW: 1012, boxH: 1350 },
  // 9:16. Se deja libre arriba y abajo lo que tapan el nombre de la cuenta y la barra para responder.
  story: { width: 1080, height: 1920, boxW: 1000, boxH: 1480 }
};
const MAX_DOWNLOAD = 15 * 1024 * 1024;
const JPEG_QUALITY = 90;
// Versión del armado: si cambia, se vuelven a preparar las fotos en lugar de usar las guardadas antes.
// v3: las fotos del celular se enderezan según su orientación (antes salían acostadas).
const LAYOUT_VERSION = 'v3';

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
    return applyOrientation({ width: img.width, height: img.height, data: img.data }, jpegOrientation(buffer));
  }
  throw new Error('La foto no es PNG ni JPG');
}

/**
 * Orientación EXIF de un JPG (1 = normal). El celular guarda la foto vertical acostada y anota cómo girarla: la galería y
 * el navegador la giran solos, pero al decodificarla aquí hay que hacerlo a mano o sale de lado.
 */
export function jpegOrientation(b: Buffer): number {
  if (!isJpeg(b)) return 1;
  let off = 2;
  while (off + 4 <= b.length) {
    if (b[off] !== 0xff) return 1;
    const marker = b[off + 1];
    // Fin de la imagen o comienzo de los datos de la foto: ya no hay marcas.
    if (marker === 0xd9 || marker === 0xda) return 1;
    const len = b.readUInt16BE(off + 2);
    if (marker === 0xe1 && b.toString('latin1', off + 4, off + 10) === 'Exif\0\0') {
      const tiff = off + 10;
      if (tiff + 8 > b.length) return 1;
      const little = b.toString('latin1', tiff, tiff + 2) === 'II';
      const u16 = (p: number) => (little ? b.readUInt16LE(p) : b.readUInt16BE(p));
      const u32 = (p: number) => (little ? b.readUInt32LE(p) : b.readUInt32BE(p));
      const ifd = tiff + u32(tiff + 4);
      if (ifd + 2 > b.length) return 1;
      const count = u16(ifd);
      for (let i = 0; i < count; i++) {
        const entry = ifd + 2 + i * 12;
        if (entry + 12 > b.length) return 1;
        if (u16(entry) === 0x0112) {
          const value = u16(entry + 8);
          return value >= 1 && value <= 8 ? value : 1;
        }
      }
      return 1;
    }
    off += 2 + len;
  }
  return 1;
}

/** Gira o voltea la foto según su orientación EXIF, para que quede como se ve en el celular. */
export function applyOrientation(img: RawImage, orientation: number): RawImage {
  if (!(orientation >= 2 && orientation <= 8)) return img;
  const W = img.width, H = img.height;
  const swap = orientation >= 5;
  const width = swap ? H : W, height = swap ? W : H;
  const out = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      // Punto (x, y) de la foto derecha → punto de la foto guardada.
      let sx: number, sy: number;
      switch (orientation) {
        case 2: sx = W - 1 - x; sy = y; break;
        case 3: sx = W - 1 - x; sy = H - 1 - y; break;
        case 4: sx = x; sy = H - 1 - y; break;
        case 5: sx = y; sy = x; break;
        case 6: sx = y; sy = H - 1 - x; break;
        case 7: sx = W - 1 - y; sy = H - 1 - x; break;
        default: sx = W - 1 - y; sy = x; break;
      }
      const s = (sy * W + sx) * 4, d = (y * width + x) * 4;
      out[d] = img.data[s]; out[d + 1] = img.data[s + 1]; out[d + 2] = img.data[s + 2]; out[d + 3] = img.data[s + 3];
    }
  }
  return { width, height, data: out };
}

/** Color de un punto de la foto con la transparencia mezclada en blanco. */
function pixel(img: RawImage, x: number, y: number, out: number[], k: number) {
  const s = (Math.min(img.height - 1, Math.max(0, y)) * img.width + Math.min(img.width - 1, Math.max(0, x))) * 4;
  const a = img.data[s + 3] / 255;
  out[k] = img.data[s] * a + 255 * (1 - a);
  out[k + 1] = img.data[s + 1] * a + 255 * (1 - a);
  out[k + 2] = img.data[s + 2] * a + 255 * (1 - a);
}

/** Muestreo bilineal (suave al agrandar o achicar un poco). */
function bilinear(img: RawImage, fx: number, fy: number, rgb: number[]) {
  const x0 = Math.floor(fx), y0 = Math.floor(fy);
  const tx = fx - x0, ty = fy - y0;
  const c = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
  pixel(img, x0, y0, c, 0);
  pixel(img, x0 + 1, y0, c, 3);
  pixel(img, x0, y0 + 1, c, 6);
  pixel(img, x0 + 1, y0 + 1, c, 9);
  for (let i = 0; i < 3; i++) {
    rgb[i] = (c[i] * (1 - tx) + c[3 + i] * tx) * (1 - ty) + (c[6 + i] * (1 - tx) + c[9 + i] * tx) * ty;
  }
}

/**
 * Fondo: la foto estirada hasta cubrir el lienzo, reducida a una cuadrícula de promedios y vuelta a agrandar
 * (queda como un difuminado) y aclarada para que la foto de adelante resalte.
 */
function blurredBackdrop(img: RawImage, width: number, height: number): Buffer {
  const cell = 90;
  const gw = Math.ceil(width / cell), gh = Math.ceil(height / cell);
  const cover = Math.max(width / img.width, height / img.height);
  const offX = (img.width * cover - width) / 2, offY = (img.height * cover - height) / 2;
  const grid = new Float32Array(gw * gh * 3);
  const tmp = [0, 0, 0];
  for (let gy = 0; gy < gh; gy++) {
    for (let gx = 0; gx < gw; gx++) {
      let r = 0, g = 0, b = 0, n = 0;
      for (let sy = 0; sy < 4; sy++) {
        for (let sx = 0; sx < 4; sx++) {
          const cx = (gx * cell + (sx + 0.5) * cell / 4 + offX) / cover;
          const cy = (gy * cell + (sy + 0.5) * cell / 4 + offY) / cover;
          pixel(img, Math.floor(cx), Math.floor(cy), tmp, 0);
          r += tmp[0]; g += tmp[1]; b += tmp[2]; n++;
        }
      }
      const k = (gy * gw + gx) * 3;
      grid[k] = r / n; grid[k + 1] = g / n; grid[k + 2] = b / n;
    }
  }
  const out = Buffer.alloc(width * height * 4, 255);
  for (let y = 0; y < height; y++) {
    const fy = Math.min(gh - 1, Math.max(0, y / cell - 0.5));
    const y0 = Math.floor(fy), y1 = Math.min(gh - 1, y0 + 1), ty = fy - y0;
    for (let x = 0; x < width; x++) {
      const fx = Math.min(gw - 1, Math.max(0, x / cell - 0.5));
      const x0 = Math.floor(fx), x1 = Math.min(gw - 1, x0 + 1), tx = fx - x0;
      const d = (y * width + x) * 4;
      for (let i = 0; i < 3; i++) {
        const top = grid[(y0 * gw + x0) * 3 + i] * (1 - tx) + grid[(y0 * gw + x1) * 3 + i] * tx;
        const bottom = grid[(y1 * gw + x0) * 3 + i] * (1 - tx) + grid[(y1 * gw + x1) * 3 + i] * tx;
        out[d + i] = Math.round((top * (1 - ty) + bottom * ty) * 0.7 + 255 * 0.3);
      }
    }
  }
  return out;
}

/** Arma la foto para Instagram: lienzo de la medida exacta, fondo difuminado y la foto completa al centro. */
export function composeImage(img: RawImage, kind: ImageKind = 'feed'): RawImage {
  const { width, height, boxW, boxH } = LAYOUT[kind];
  const out = blurredBackdrop(img, width, height);
  const scale = Math.min(boxW / img.width, boxH / img.height);
  const drawW = Math.round(img.width * scale), drawH = Math.round(img.height * scale);
  const offX = Math.floor((width - drawW) / 2), offY = Math.floor((height - drawH) / 2);
  // Al achicar mucho se promedian 4 puntos por píxel para que no se vea granulado.
  const sub = scale < 0.75 ? 2 : 1;
  const rgb = [0, 0, 0];
  for (let y = 0; y < drawH; y++) {
    for (let x = 0; x < drawW; x++) {
      let r = 0, g = 0, b = 0;
      for (let sy = 0; sy < sub; sy++) {
        for (let sx = 0; sx < sub; sx++) {
          bilinear(img, (x + (sx + 0.5) / sub) / scale - 0.5, (y + (sy + 0.5) / sub) / scale - 0.5, rgb);
          r += rgb[0]; g += rgb[1]; b += rgb[2];
        }
      }
      const n = sub * sub, d = ((y + offY) * width + (x + offX)) * 4;
      out[d] = Math.round(r / n);
      out[d + 1] = Math.round(g / n);
      out[d + 2] = Math.round(b / n);
    }
  }
  return { width, height, data: out };
}

export function toInstagramJpeg(buffer: Buffer, kind: ImageKind = 'feed'): Buffer {
  const composed = composeImage(decodeImage(buffer), kind);
  return Buffer.from(jpeg.encode({ width: composed.width, height: composed.height, data: composed.data as Buffer }, JPEG_QUALITY).data);
}

/** La foto achicada para que su lado más largo mida como mucho maxSide (para mandarla a la IA sin gastar de más). */
export function toJpegMax(buffer: Buffer, maxSide: number, quality = 85): Buffer {
  const img = decodeImage(buffer);
  const scale = Math.min(1, maxSide / Math.max(img.width, img.height));
  if (scale >= 1) return Buffer.from(jpeg.encode({ width: img.width, height: img.height, data: img.data as Buffer }, quality).data);
  const width = Math.max(1, Math.round(img.width * scale)), height = Math.max(1, Math.round(img.height * scale));
  const out = Buffer.alloc(width * height * 4);
  const rgb = [0, 0, 0];
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      bilinear(img, (x + 0.5) / scale - 0.5, (y + 0.5) / scale - 0.5, rgb);
      const i = (y * width + x) * 4;
      out[i] = rgb[0]; out[i + 1] = rgb[1]; out[i + 2] = rgb[2]; out[i + 3] = 255;
    }
  }
  return Buffer.from(jpeg.encode({ width, height, data: out }, quality).data);
}

/** PNG o JPG → JPG (las fotos hechas por la IA pesan ~1,5 MB en PNG; en JPG, unas 10 veces menos). */
export function toJpeg(buffer: Buffer, quality = JPEG_QUALITY): Buffer {
  const img = decodeImage(buffer);
  return Buffer.from(jpeg.encode({ width: img.width, height: img.height, data: img.data as Buffer }, quality).data);
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
 * Facebook publica la foto original: si es del celular y viene acostada (orientación EXIF), se publica una copia ya
 * derecha. Si la foto no necesita giro (o no es JPG), se usa la original tal cual.
 */
export async function uprightUrl(imageUrl: string): Promise<string> {
  if (!isOwnStorageUrl(imageUrl)) return imageUrl;
  const tenant = currentTenant();
  const name = `social-upright-${LAYOUT_VERSION}-${createHash('sha256').update(imageUrl).digest('hex').slice(0, 24)}.jpg`;
  const path = `${tenant ? `${tenant.businessId}/` : ''}${name}`;
  const publicUrl = supabase.storage.from('product-images').getPublicUrl(path).data.publicUrl;
  if (await axios.head(publicUrl, { timeout: 15_000 }).then(r => r.status === 200).catch(() => false)) return publicUrl;
  const { data } = await axios.get(imageUrl, { responseType: 'arraybuffer', timeout: 60_000, maxContentLength: MAX_DOWNLOAD });
  const buffer = Buffer.from(data);
  if (jpegOrientation(buffer) <= 1) return imageUrl;
  const { error } = await supabase.storage.from('product-images').upload(path, toJpeg(buffer), { contentType: 'image/jpeg', upsert: true });
  if (error) throw new Error(`No se pudo preparar la foto para Facebook: ${error.message}`);
  return publicUrl;
}

/**
 * Devuelve la dirección pública de la foto armada para Instagram (publicación o historia). Se guarda en la carpeta de
 * la empresa con un nombre fijo por foto y formato, así no se repite el trabajo ni se llenan de copias.
 */
export async function instagramReadyUrl(imageUrl: string, kind: ImageKind = 'feed'): Promise<string> {
  if (!isOwnStorageUrl(imageUrl)) throw new Error('La foto debe estar en el catálogo del CRM');
  const tenant = currentTenant();
  const name = `social-${kind}-${LAYOUT_VERSION}-${createHash('sha256').update(imageUrl).digest('hex').slice(0, 24)}.jpg`;
  const path = `${tenant ? `${tenant.businessId}/` : ''}${name}`;
  const publicUrl = supabase.storage.from('product-images').getPublicUrl(path).data.publicUrl;
  // Ya se armó antes: se usa la guardada.
  const existing = await axios.head(publicUrl, { timeout: 15_000 }).then(r => r.status === 200).catch(() => false);
  if (existing) return publicUrl;

  const { data } = await axios.get(imageUrl, { responseType: 'arraybuffer', timeout: 60_000, maxContentLength: MAX_DOWNLOAD });
  const jpg = toInstagramJpeg(Buffer.from(data), kind);
  const { error } = await supabase.storage.from('product-images').upload(path, jpg, { contentType: 'image/jpeg', upsert: true });
  if (error) throw new Error(`No se pudo guardar la foto para Instagram: ${error.message}`);
  return publicUrl;
}

// ---------- Texto sobre las historias ----------

/** Frase y llamado a la acción que van sobre una historia (el producto sigue siendo el protagonista). */
export interface StoryText { phrase?: string; cta?: string }

const escapeXml = (t: string) => t.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c] as string));

/** Corta el texto en líneas de hasta `max` letras (como mucho 2 líneas por parte). */
export function wrapText(text: string, max: number, maxLines = 2): string[] {
  const words = String(text || '').replace(/\s+/g, ' ').trim().split(' ').filter(Boolean);
  const lines: string[] = [];
  for (const w of words) {
    const last = lines[lines.length - 1];
    if (last !== undefined && (last + ' ' + w).length <= max) lines[lines.length - 1] = last + ' ' + w;
    else lines.push(w);
  }
  if (lines.length > maxLines) {
    const kept = lines.slice(0, maxLines);
    kept[maxLines - 1] = `${kept[maxLines - 1]}…`;
    return kept;
  }
  return lines;
}

/**
 * Pone la frase y el llamado a la acción en una franja clara debajo de la foto (o sobre su borde de abajo si no hay
 * espacio), lejos de lo que tapan el nombre de la cuenta arriba y la barra para responder abajo.
 */
export function storyWithText(buffer: Buffer, text: StoryText): Buffer {
  const img = decodeImage(buffer);
  const composed = composeImage(img, 'story');
  const { width, height, boxW, boxH } = LAYOUT.story;
  const phrase = wrapText(text.phrase || '', 26);
  const cta = wrapText(text.cta || '', 30);
  if (!phrase.length && !cta.length) return Buffer.from(jpeg.encode({ width, height, data: composed.data as Buffer }, JPEG_QUALITY).data);
  const scale = Math.min(boxW / img.width, boxH / img.height);
  const photoBottom = Math.floor((height + Math.round(img.height * scale)) / 2);
  const PHRASE = 56, CTA = 44, GAP = 14, PAD = 36;
  const bandH = PAD * 2 + phrase.length * (PHRASE + 12) + (phrase.length && cta.length ? GAP : 0) + cta.length * (CTA + 12) - 12;
  const limit = height - 210; // la barra para responder
  const top = Math.max(240, Math.min(photoBottom + 28, limit - bandH));
  let y = top + PAD;
  const lines: string[] = [];
  for (const l of phrase) { y += PHRASE; lines.push(`<text x="${width / 2}" y="${y}" text-anchor="middle" font-family="Montserrat" font-weight="800" font-size="${PHRASE}" fill="#2B1C14">${escapeXml(l)}</text>`); y += 12; }
  if (phrase.length && cta.length) y += GAP;
  for (const l of cta) { y += CTA; lines.push(`<text x="${width / 2}" y="${y}" text-anchor="middle" font-family="Montserrat" font-weight="700" font-size="${CTA}" fill="#A3522F">${escapeXml(l)}</text>`); y += 12; }
  const background = Buffer.from(jpeg.encode({ width, height, data: composed.data as Buffer }, 95).data).toString('base64');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`
    + `<image href="data:image/jpeg;base64,${background}" x="0" y="0" width="${width}" height="${height}"/>`
    + `<rect x="80" y="${top}" width="${width - 160}" height="${bandH}" rx="40" fill="#FFFDF9" fill-opacity="0.93"/>`
    + lines.join('') + '</svg>';
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { Resvg } = require('@resvg/resvg-js');
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const path = require('path') as typeof import('path');
  const fonts = ['Montserrat-ExtraBold.ttf', 'Montserrat-Bold.ttf', 'Montserrat-SemiBold.ttf'].map(f => path.join(__dirname, '../../assets/fonts', f));
  const png = PNG.sync.read(new Resvg(svg, { font: { fontFiles: fonts, loadSystemFonts: false, defaultFontFamily: 'Montserrat' } }).render().asPng());
  return Buffer.from(jpeg.encode({ width: png.width, height: png.height, data: png.data }, JPEG_QUALITY).data);
}

/** La historia lista con su texto, guardada (un nombre por foto y texto: no se repite el trabajo). */
export async function storyWithTextUrl(imageUrl: string, text: StoryText): Promise<string> {
  if (!text.phrase && !text.cta) return instagramReadyUrl(imageUrl, 'story');
  if (!isOwnStorageUrl(imageUrl)) throw new Error('La foto debe estar en el catálogo del CRM');
  const tenant = currentTenant();
  const key = createHash('sha256').update(`${imageUrl}|${text.phrase || ''}|${text.cta || ''}`).digest('hex').slice(0, 24);
  const path = `${tenant ? `${tenant.businessId}/` : ''}social-story-text-${LAYOUT_VERSION}-${key}.jpg`;
  const publicUrl = supabase.storage.from('product-images').getPublicUrl(path).data.publicUrl;
  if (await axios.head(publicUrl, { timeout: 15_000 }).then(r => r.status === 200).catch(() => false)) return publicUrl;
  const { data } = await axios.get(imageUrl, { responseType: 'arraybuffer', timeout: 60_000, maxContentLength: MAX_DOWNLOAD });
  const { error } = await supabase.storage.from('product-images').upload(path, storyWithText(Buffer.from(data), text), { contentType: 'image/jpeg', upsert: true });
  if (error) throw new Error(`No se pudo guardar la historia con texto: ${error.message}`);
  return publicUrl;
}
