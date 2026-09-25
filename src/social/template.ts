import fs from 'fs';
import path from 'path';
import { PNG } from 'pngjs';
import jpeg from 'jpeg-js';
import { decodeImage, RawImage } from './images';
import type { PosterTexts } from './posters';

/**
 * Plantilla fija para las fotos de los catálogos de proveedores: el diseño de la empresa se dibuja con código (siempre
 * igual: mismas posiciones, letras y colores) y solo cambian la vela, el nombre y el precio. No usa IA: sale exacto y
 * no cuesta nada. Copia la estructura de los afiches de VELAMIA: título grande dorado, cinta, recuadro de precio,
 * tres íconos con su texto y franja inferior; la vela, grande a la derecha. Cada ocasión tiene su paleta y su fondo
 * (o el fondo que suba la empresa).
 */

const SIZE = 1080;
const FONTS_DIR = path.join(__dirname, '../../assets/fonts');
const FONT_FILES = ['Montserrat-Black.ttf', 'Montserrat-ExtraBold.ttf', 'Montserrat-Bold.ttf', 'Montserrat-SemiBold.ttf'].map(f => path.join(FONTS_DIR, f));

export interface TemplateTheme {
  /** Fondo: degradado de arriba a abajo. */
  sky: [string, string];
  /** Luces difuminadas del fondo. */
  lights: string[];
  /** Degradado del título y del precio (claro → oscuro). */
  metal: [string, string, string];
  /** Cinta, etiqueta del precio, círculos y franja. */
  accent: [string, string];
  /** Texto oscuro (íconos). */
  ink: string;
  /** Adorno de las puntas de la franja. */
  ornament: 'snowflake' | 'sparkle' | 'heart' | 'star';
}

const GOLD: TemplateTheme = { sky: ['#FBF4E8', '#EAD7B5'], lights: ['#F6C76B', '#E8A93A', '#FFF1C9', '#D9892B'], metal: ['#E9B64E', '#9A6424', '#5B3813'], accent: ['#C8913F', '#7A4A1A'], ink: '#4A2A10', ornament: 'sparkle' };

/** Paleta por ocasión (por la categoría); lo que no se reconoce va en dorado, como los afiches de VELAMIA. */
export function themeFor(category: string): TemplateTheme {
  const c = String(category || '').normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase();
  if (/navid|christmas|noel/.test(c)) return { ...GOLD, sky: ['#F7E7C8', '#C99A55'], lights: ['#FFD27A', '#F2B040', '#FFF3D1', '#E39A2E'], ornament: 'snowflake' };
  if (/hallow|difunt|terror/.test(c)) return { sky: ['#2B1B3A', '#120B1C'], lights: ['#FF8A2B', '#FFB347', '#8E44AD', '#FFD27A'], metal: ['#FFC15E', '#F07B1D', '#A8430C'], accent: ['#F07B1D', '#8E3B0A'], ink: '#FFF4E6', ornament: 'star' };
  if (/baby|bebe|revelaci|genero/.test(c)) return { sky: ['#F4F8FC', '#DDE8F2'], lights: ['#BFD6EA', '#F3D9E4', '#FFFFFF', '#E9C98F'], metal: ['#8FB1CF', '#5C82A6', '#3E5E7E'], accent: ['#C9A45C', '#8C6A2C'], ink: '#34506B', ornament: 'heart' };
  if (/bautiz|comuni|misa|confirm|primera/.test(c)) return { sky: ['#FFFFFF', '#EFE7DA'], lights: ['#F2E2BF', '#FFFFFF', '#E7CF9A', '#F7EEDB'], metal: ['#D9B25F', '#A07A33', '#6E5120'], accent: ['#C9A45C', '#8C6A2C'], ink: '#5A4320', ornament: 'sparkle' };
  if (/boda|matrimon|aniversar/.test(c)) return { sky: ['#FFF9F4', '#F1E2D3'], lights: ['#F4D8C2', '#FFFFFF', '#E8C9A1', '#F7E6E0'], metal: ['#D8A77A', '#A8744A', '#6E4527'], accent: ['#C99A6E', '#8A5C38'], ink: '#5B3A22', ornament: 'heart' };
  if (/cumple|quince|fiesta/.test(c)) return { sky: ['#FFF4F8', '#F7DDE8'], lights: ['#F7B7CF', '#FFE08A', '#FFFFFF', '#E7A1C0'], metal: ['#F08DB4', '#C24C83', '#7E2553'], accent: ['#E0659A', '#9C2D63'], ink: '#6A1E45', ornament: 'star' };
  if (/gradu/.test(c)) return { sky: ['#F3F5FA', '#D9DFEC'], lights: ['#E3C680', '#FFFFFF', '#9FB3D6', '#F0DDA8'], metal: ['#2F4A7A', '#1F3358', '#121F38'], accent: ['#C9A45C', '#8C6A2C'], ink: '#1F3358', ornament: 'star' };
  return GOLD;
}

// ---------- Medidas de texto (aprox. de Montserrat, en "em") ----------

const WIDE = 'MW';
const NARROW = 'IJ1.,:;\'!|';
/** Ancho aproximado de un texto en mayúsculas con Montserrat del peso indicado (em). */
export function textWidth(text: string, weight = 900): number {
  const base = weight >= 900 ? 0.78 : weight >= 800 ? 0.74 : 0.7;
  let w = 0;
  for (const ch of text) {
    if (ch === ' ') w += 0.3;
    else if (WIDE.includes(ch)) w += base * 1.3;
    else if (NARROW.includes(ch)) w += base * 0.45;
    else if (/[0-9]/.test(ch)) w += base * 0.92;
    else if (ch === '$') w += base * 0.85;
    else if (/[a-zñáéíóú]/.test(ch)) w += base * 0.78;
    else w += base;
  }
  return w;
}

/** Reparte las palabras en líneas y elige el tamaño de letra más grande que entra en la caja. */
export function fitLines(text: string, boxW: number, boxH: number, maxSize: number, maxLines = 3, weight = 900, lineHeight = 0.98, minLines = 1): { lines: string[]; size: number } {
  const words = text.trim().split(/\s+/).filter(Boolean);
  const least = Math.min(minLines, words.length);
  let best = { lines: [text.trim()], size: least > 1 ? 0 : Math.min(maxSize, boxW / Math.max(1, textWidth(text, weight))) };
  // Todos los cortes posibles (los nombres son cortos): gana el que deja la letra más grande.
  const splits = (from: number, left: number): string[][] => {
    if (left === 1) return [[words.slice(from).join(' ')]];
    const out: string[][] = [];
    for (let cut = from + 1; cut <= words.length - left + 1; cut++) {
      for (const rest of splits(cut, left - 1)) out.push([words.slice(from, cut).join(' '), ...rest]);
    }
    return out;
  };
  for (let n = Math.max(1, least); n <= Math.min(maxLines, words.length); n++) for (const lines of splits(0, n)) {
    const widest = Math.max(...lines.map(l => textWidth(l, weight)));
    const size = Math.min(maxSize, boxW / widest, boxH / (lines.length * lineHeight));
    const bestWidest = Math.max(...best.lines.map(l => textWidth(l, weight)));
    if (size > best.size + 0.5 || (Math.abs(size - best.size) <= 0.5 && lines.length === best.lines.length && widest < bestWidest)) best = { lines, size };
  }
  return { lines: best.lines, size: Math.floor(best.size) };
}

/** ¿Color oscuro? (luminancia baja) */
const isDark = (hex: string) => { const n = parseInt(hex.slice(1), 16); return (0.299 * (n >> 16) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) < 110; };

const esc = (s: string) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const money = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(2));

// ---------- Íconos (trazos blancos, caja de 48×48) ----------

const ICONS: Record<string, string> = {
  gift: '<rect x="9" y="20" width="30" height="20" rx="2"/><rect x="7" y="13" width="34" height="8" rx="2"/><path d="M24 13v27M17 13c-5-6 3-10 7 0M31 13c5-6-3-10-7 0"/>',
  heart: '<path d="M24 39s-14-8.5-14-18a7.5 7.5 0 0 1 14-4 7.5 7.5 0 0 1 14 4c0 9.5-14 18-14 18z"/>',
  calendar: '<rect x="8" y="11" width="30" height="27" rx="3"/><path d="M8 19h30M15 7v7M31 7v7M14 26h3M21 26h3M28 26h3M14 32h3M21 32h3"/>',
  lock: '<rect x="9" y="21" width="30" height="21" rx="4"/><path d="M15 21v-5a9 9 0 0 1 18 0v5"/><path d="M24 36s-5.5-3.3-5.5-6.8a2.9 2.9 0 0 1 5.5-1.4 2.9 2.9 0 0 1 5.5 1.4c0 3.5-5.5 6.8-5.5 6.8z" fill="#fff"/>',
  snowflake: '<path d="M24 6v36M8.4 15l31.2 18M8.4 33l31.2-18M24 6l-4 4M24 6l4 4M24 42l-4-4M24 42l4-4"/>',
  sparkle: '<path d="M24 6c1.5 9 4 11.5 13 13-9 1.5-11.5 4-13 13-1.5-9-4-11.5-13-13 9-1.5 11.5-4 13-13z" fill="#fff"/>',
  star: '<path d="M24 7l5 11 12 1.2-9 8 2.7 11.8L24 33l-10.7 6 2.7-11.8-9-8L19 18z" fill="#fff"/>'
};
const FEATURE_ICONS = ['gift', 'heart', 'calendar', 'sparkle'];

function icon(name: string, x: number, y: number, size: number, color = '#fff'): string {
  const s = size / 48;
  return `<g transform="translate(${x} ${y}) scale(${s})" fill="none" stroke="${color}" stroke-width="${2.6}" stroke-linecap="round" stroke-linejoin="round" color="${color}">${ICONS[name] || ICONS.sparkle}</g>`;
}

// ---------- La vela ----------

/**
 * Lleva el fondo casi blanco de la foto a blanco puro (el color de la vela se aclara apenas): al fundirse con la
 * plantilla, el fondo desaparece sin dejar un recuadro gris.
 */
export function whiten(img: RawImage): RawImage {
  const { width: w, height: h } = img;
  const src = img.data;
  const border: number[][] = [];
  for (let x = 0; x < w; x += 2) for (const y of [0, h - 1]) { const i = (y * w + x) * 4; border.push([src[i], src[i + 1], src[i + 2]]); }
  for (let y = 0; y < h; y += 2) for (const x of [0, w - 1]) { const i = (y * w + x) * 4; border.push([src[i], src[i + 1], src[i + 2]]); }
  const level = [0, 1, 2].map(c => Math.max(200, border.map(p => p[c]).sort((a, b) => a - b)[Math.floor(border.length * 0.3)]));
  const out = Buffer.alloc(w * h * 4);
  for (let i = 0; i < w * h * 4; i += 4) {
    const r = Math.min(255, src[i] * 255 / level[0]), g = Math.min(255, src[i + 1] * 255 / level[1]), b = Math.min(255, src[i + 2] * 255 / level[2]);
    const white = r > 246 && g > 246 && b > 246;
    out[i] = white ? 255 : r; out[i + 1] = white ? 255 : g; out[i + 2] = white ? 255 : b; out[i + 3] = 255;
  }
  return { width: w, height: h, data: out };
}

/** ¿La foto tiene fondo blanco (o casi)? Se mira todo el borde. */
export function whiteBackground(img: RawImage): boolean {
  const { width: w, height: h, data } = img;
  let white = 0, total = 0;
  const check = (x: number, y: number) => { const i = (y * w + x) * 4; total++; if (data[i] > 225 && data[i + 1] > 225 && data[i + 2] > 225) white++; };
  for (let x = 0; x < w; x += 2) { check(x, 0); check(x, h - 1); }
  for (let y = 0; y < h; y += 2) { check(0, y); check(w - 1, y); }
  return white / total > 0.85;
}

/** El recuadro donde está la vela dentro de una foto de fondo blanco (sin el margen blanco). */
export function trimWhite(img: RawImage): { x: number; y: number; w: number; h: number } {
  const { width: w, height: h, data } = img;
  let minX = w, minY = h, maxX = -1, maxY = -1;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = (y * w + x) * 4;
    if (data[i] < 240 || data[i + 1] < 240 || data[i + 2] < 240) {
      if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y;
    }
  }
  if (maxX < 0) return { x: 0, y: 0, w, h };
  const pad = Math.round(Math.max(w, h) * 0.02);
  minX = Math.max(0, minX - pad); minY = Math.max(0, minY - pad); maxX = Math.min(w - 1, maxX + pad); maxY = Math.min(h - 1, maxY + pad);
  return { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 };
}

const pngDataUrl = (img: RawImage) => {
  const png = new PNG({ width: img.width, height: img.height });
  Buffer.from(img.data).copy(png.data);
  return `data:image/png;base64,${PNG.sync.write(png).toString('base64')}`;
};

// ---------- El afiche ----------

export interface TemplateInput {
  /** Foto del proveedor (JPG o PNG). */
  product: Buffer;
  texts: PosterTexts;
  category: string;
  /** Fondo propio de la empresa para esa categoría (opcional). */
  background?: Buffer | null;
}

/** Arma el SVG del afiche (se exporta para las pruebas). */
export function posterSvg(input: TemplateInput): string {
  const t = input.texts;
  const th = themeFor(input.category);
  const dark = isDark(th.sky[0]); // fondo oscuro (Halloween): textos claros
  const L = 40, W = 520, CX = L + W / 2;

  // Fondo: el de la empresa o luces difuminadas con la paleta de la ocasión.
  let background = `<rect width="${SIZE}" height="${SIZE}" fill="url(#sky)"/>`;
  if (input.background) {
    const bg = decodeImage(input.background);
    background += `<image href="${pngDataUrl(bg)}" x="0" y="0" width="${SIZE}" height="${SIZE}" preserveAspectRatio="xMidYMid slice"/>`;
  } else {
    let seed = 7;
    const rnd = () => { seed = (seed * 9301 + 49297) % 233280; return seed / 233280; };
    const light = (count: number, rMin: number, rMax: number, oMin: number, oMax: number) => Array.from({ length: count }, (_, i) => {
      const x = 380 + rnd() * 760, y = rnd() * 980, r = rMin + rnd() * (rMax - rMin);
      return `<circle cx="${x.toFixed(0)}" cy="${y.toFixed(0)}" r="${r.toFixed(0)}" fill="${th.lights[i % th.lights.length]}" opacity="${(oMin + rnd() * (oMax - oMin)).toFixed(2)}"/>`;
    }).join('');
    background += `<g filter="url(#blur)">${light(28, 40, 90, 0.35, 0.7)}</g><g filter="url(#blurSoft)">${light(40, 8, 22, 0.5, 0.95)}</g>`;
  }
  // Velo claro a la izquierda para que los textos se lean (como en los afiches de la empresa).
  const veil = `<rect width="${SIZE}" height="${SIZE}" fill="url(#veil)"/>`;

  // Título: hasta 3 líneas, lo más grande que entre.
  const title = fitLines(t.title.replace(/\s+[-–—]\s+/g, ' '), W, 250, 132, 3, 900);
  const lh = title.size * 0.98;
  const ribbonFit = fitLines(t.ribbon, 400, 72, 34, 2, 800, 1.1);
  const ribbonH = Math.max(64, ribbonFit.lines.length * ribbonFit.size * 1.1 + 18);
  const priceH = t.unitPrice > 0 ? 262 : 232;
  const featuresH = Math.min(3, t.features.length) * 96;
  const block = title.lines.length * lh + 14 + ribbonH + 16 + priceH + 22 + featuresH;
  const titleTop = 76 + Math.max(0, (972 - 12 - 76 - block) / 2);
  const titleSvg = title.lines.map((line, i) => {
    const y = titleTop + title.size * 0.8 + i * lh;
    return `<text x="${CX}" y="${y.toFixed(0)}" font-size="${title.size}" font-weight="900" text-anchor="middle" fill="url(#metal)" stroke="#fff" stroke-width="3" paint-order="stroke" filter="url(#shadow)">${esc(line)}</text>`;
  }).join('');
  const afterTitle = titleTop + title.lines.length * lh + 14;

  // Adorno de arriba: líneas finas con un destello al centro.
  const top = `<path d="M${CX - 150} 48H${CX - 34}M${CX + 34} 48H${CX + 150}" stroke="${th.accent[0]}" stroke-width="2.5"/>${icon('sparkle', CX - 22, 26, 44, th.accent[0]).replace(/fill="#fff"/g, `fill="${th.accent[0]}"`)}`;

  // Cinta con puntas.
  const ribbon = ribbonFit;
  const rY = afterTitle, rH = ribbonH;
  const ribbonSvg = `<path d="M${CX - 225} ${rY}H${CX + 225}L${CX + 250} ${rY + rH / 2}L${CX + 225} ${rY + rH}H${CX - 225}L${CX - 250} ${rY + rH / 2}Z" fill="url(#accent)"/>`
    + ribbon.lines.map((line, i) => `<text x="${CX}" y="${(rY + rH / 2 - (ribbon.lines.length - 1) * ribbon.size * 0.55 + i * ribbon.size * 1.1 + ribbon.size * 0.36).toFixed(0)}" font-size="${ribbon.size}" font-weight="800" text-anchor="middle" fill="#fff">${esc(line)}</text>`).join('')
    + icon('sparkle', CX - 300, rY + rH / 2 - 18, 36, th.accent[0]).replace(/fill="#fff"/g, `fill="${th.accent[0]}"`)
    + icon('sparkle', CX + 264, rY + rH / 2 - 18, 36, th.accent[0]).replace(/fill="#fff"/g, `fill="${th.accent[0]}"`);

  // Recuadro del precio con la etiqueta de la unidad.
  const pY = rY + rH + 16, pH = priceH;
  const price = `$${money(t.price)}`;
  const priceSize = Math.min(170, Math.floor(430 / textWidth(price, 900)));
  const unit = fitLines(t.unit, 380, 56, 56, 1, 800);
  const priceSvg = `<rect x="${L + 10}" y="${pY}" width="${W - 20}" height="${pH}" rx="26" fill="#fff" fill-opacity="0.94" stroke="${th.accent[0]}" stroke-width="3"/>`
    + `<text x="${CX}" y="${pY + priceSize * 0.86}" font-size="${priceSize}" font-weight="900" text-anchor="middle" fill="url(#metal)">${esc(price)}</text>`
    + `<rect x="${L + 40}" y="${pY + priceSize * 0.95}" width="${W - 80}" height="70" rx="18" fill="url(#accent)"/>`
    + `<text x="${CX}" y="${pY + priceSize * 0.95 + 35 + unit.size * 0.36}" font-size="${unit.size}" font-weight="800" text-anchor="middle" fill="#fff" letter-spacing="3">${esc(unit.lines[0])}</text>`
    + (t.unitPrice > 0 ? `<text x="${CX}" y="${pY + pH - 12}" font-size="26" font-weight="800" text-anchor="middle" fill="${th.accent[1]}">UNIDAD $${money(t.unitPrice)}</text>` : '');

  // Tres (o cuatro) íconos con su texto.
  const fY = pY + pH + 22;
  const bandY = 972;
  const rows = t.features.slice(0, 3);
  const rowH = Math.min(96, (bandY - 14 - fY) / Math.max(1, rows.length));
  const featuresSvg = rows.map((text, i) => {
    const y = fY + i * rowH;
    const r = Math.min(40, rowH * 0.42);
    const f = fitLines(text, 330, rowH - 14, 34, 2, 800, 1.08, 2);
    const textY = y + rowH / 2 - (f.lines.length - 1) * f.size * 0.54 + f.size * 0.36;
    return `<circle cx="${L + 58}" cy="${(y + rowH / 2).toFixed(0)}" r="${r.toFixed(0)}" fill="url(#accent)"/>`
      + icon(FEATURE_ICONS[i], L + 58 - r * 0.62, y + rowH / 2 - r * 0.62, r * 1.24)
      + f.lines.map((line, j) => `<text x="${L + 120}" y="${(textY + j * f.size * 1.08).toFixed(0)}" font-size="${f.size}" font-weight="800" fill="${dark ? '#FFF4E6' : th.ink}">${esc(line)}</text>`).join('')
      + (i < rows.length - 1 ? `<path d="M${L + 118} ${(y + rowH).toFixed(0)}H${L + W - 30}" stroke="${th.accent[0]}" stroke-width="1.5" opacity="0.7"/>` : '');
  }).join('');

  // Franja inferior.
  const band = t.band ? fitLines(t.band, 560, 44, 44, 1, 800) : null;
  const small = t.bandSmall ? fitLines(t.bandSmall, 560, 28, 26, 1, 600) : null;
  const textW = Math.max(band ? textWidth(band.lines[0], 800) * band.size : 0, small ? textWidth(small.lines[0], 600) * small.size * 0.92 : 0);
  const groupW = (band ? 96 : 0) + textW;
  const gx = (SIZE - groupW) / 2;
  const lineL = [120, gx - 30], lineR = [gx + groupW + 30, SIZE - 120];
  const bandSvg = `<rect x="0" y="${bandY}" width="${SIZE}" height="${SIZE - bandY}" fill="url(#accentH)"/>`
    + (band
      ? icon('lock', gx, bandY + 24, 62) + `<path d="M${gx + 80} ${bandY + 22}V${SIZE - 22}" stroke="#fff" stroke-width="2"/>`
        + `<text x="${gx + 96}" y="${bandY + (small ? 54 : 70)}" font-size="${band.size}" font-weight="800" fill="#fff">${esc(band.lines[0])}</text>`
        + (small ? `<text x="${gx + 96}" y="${bandY + 90}" font-size="${small.size}" font-weight="600" fill="#fff">${esc(small.lines[0])}</text>` : '')
      : small ? `<text x="${SIZE / 2}" y="${bandY + 64}" font-size="${small.size}" font-weight="700" text-anchor="middle" fill="#fff">${esc(small.lines[0])}</text>` : '')
    + icon(th.ornament, 44, bandY + 30, 50) + icon(th.ornament, SIZE - 94, bandY + 30, 50)
    + (lineL[1] - lineL[0] > 40 ? `<path d="M${lineL[0]} ${bandY + 56}H${lineL[1].toFixed(0)}M${lineR[0].toFixed(0)} ${bandY + 56}H${lineR[1]}" stroke="#fff" stroke-width="2" opacity="0.8"/>` : '');

  // La vela, grande a la derecha. Con fondo blanco (lo normal en los PDF) se pone sobre un halo de luz y el blanco de la
  // foto se funde con él: se ve la vela sola, sin recortes que borren partes claras (un fantasma blanco, por ejemplo).
  const raw = decodeImage(input.product);
  const boxX = 585, boxY = 120, boxW = 450, boxH = 800;
  let productSvg: string;
  if (whiteBackground(raw)) {
    const clean = whiten(raw);
    const area = trimWhite(clean);
    const scale = Math.min(boxW / area.w, boxH / area.h);
    const pw = area.w * scale, ph = area.h * scale;
    const px = boxX + (boxW - pw) / 2, py = boxY + boxH - ph;
    const full = { w: clean.width * scale, h: clean.height * scale };
    const ix = px - area.x * scale, iy = py - area.y * scale;
    const cx = px + pw / 2, cy = py + ph / 2;
    productSvg = `<ellipse cx="${cx.toFixed(0)}" cy="${cy.toFixed(0)}" rx="${(Math.max(pw, ph) * 0.62 + 40).toFixed(0)}" ry="${(Math.max(pw, ph) * 0.62 + 40).toFixed(0)}" fill="url(#halo)"/>`
      + `<ellipse cx="${cx.toFixed(0)}" cy="${(py + ph - 4).toFixed(0)}" rx="${(pw * 0.4).toFixed(0)}" ry="16" fill="#000" opacity="0.18" filter="url(#blurSmall)"/>`
      + `<mask id="area"><rect x="${(px - 4).toFixed(0)}" y="${(py - 4).toFixed(0)}" width="${(pw + 8).toFixed(0)}" height="${(ph + 8).toFixed(0)}" fill="#fff" filter="url(#blurMask)"/></mask>`
      + `<image href="${pngDataUrl(clean)}" x="${ix.toFixed(0)}" y="${iy.toFixed(0)}" width="${full.w.toFixed(0)}" height="${full.h.toFixed(0)}" mask="url(#area)" style="mix-blend-mode:multiply"/>`;
  } else {
    const side = 470;
    const px = boxX, py = boxY + (boxH - side) / 2;
    productSvg = `<rect x="${px - 8}" y="${py - 8}" width="${side + 16}" height="${side + 16}" rx="34" fill="#fff" filter="url(#shadow)"/>`
      + `<clipPath id="card"><rect x="${px}" y="${py}" width="${side}" height="${side}" rx="28"/></clipPath>`
      + `<image href="${pngDataUrl(raw)}" x="${px}" y="${py}" width="${side}" height="${side}" preserveAspectRatio="xMidYMid slice" clip-path="url(#card)"/>`;
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${SIZE}" height="${SIZE}" viewBox="0 0 ${SIZE} ${SIZE}" font-family="Montserrat">
<defs>
  <linearGradient id="sky" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${th.sky[0]}"/><stop offset="1" stop-color="${th.sky[1]}"/></linearGradient>
  <linearGradient id="veil" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="${dark ? '#000' : '#fff'}" stop-opacity="${dark ? 0.45 : 0.82}"/><stop offset="0.48" stop-color="${dark ? '#000' : '#fff'}" stop-opacity="${dark ? 0.3 : 0.55}"/><stop offset="0.62" stop-color="${dark ? '#000' : '#fff'}" stop-opacity="0"/></linearGradient>
  <linearGradient id="metal" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${th.metal[0]}"/><stop offset="0.55" stop-color="${th.metal[1]}"/><stop offset="1" stop-color="${th.metal[2]}"/></linearGradient>
  <linearGradient id="accent" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${th.accent[0]}"/><stop offset="1" stop-color="${th.accent[1]}"/></linearGradient>
  <linearGradient id="accentH" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="${th.accent[1]}"/><stop offset="0.5" stop-color="${th.accent[0]}"/><stop offset="1" stop-color="${th.accent[1]}"/></linearGradient>
  <radialGradient id="halo"><stop offset="0" stop-color="#fff"/><stop offset="0.62" stop-color="#fff"/><stop offset="0.8" stop-color="#fff" stop-opacity="0.55"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></radialGradient>
  <filter id="blur" x="-20%" y="-20%" width="140%" height="140%"><feGaussianBlur stdDeviation="16"/></filter>
  <filter id="blurSoft" x="-20%" y="-20%" width="140%" height="140%"><feGaussianBlur stdDeviation="5"/></filter>
  <filter id="blurMask" x="-10%" y="-10%" width="120%" height="120%"><feGaussianBlur stdDeviation="6"/></filter>
  <filter id="blurSmall" x="-20%" y="-50%" width="140%" height="200%"><feGaussianBlur stdDeviation="10"/></filter>
  <filter id="shadow" x="-10%" y="-10%" width="120%" height="130%"><feDropShadow dx="0" dy="4" stdDeviation="5" flood-color="#000" flood-opacity="0.22"/></filter>
</defs>
${background}${veil}${productSvg}${top}${titleSvg}${ribbonSvg}${priceSvg}${featuresSvg}${bandSvg}
</svg>`;
}

/** El afiche listo, en JPG de 1080×1080. */
export function renderPoster(input: TemplateInput): Buffer {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { Resvg } = require('@resvg/resvg-js');
  const resvg = new Resvg(posterSvg(input), {
    fitTo: { mode: 'width', value: SIZE },
    font: { fontFiles: FONT_FILES.filter(f => fs.existsSync(f)), loadSystemFonts: false, defaultFontFamily: 'Montserrat' }
  });
  const rendered = resvg.render();
  const png = PNG.sync.read(rendered.asPng());
  return Buffer.from(jpeg.encode({ width: png.width, height: png.height, data: png.data }, 92).data);
}
