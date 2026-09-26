import fs from 'fs';
import path from 'path';
import { PNG } from 'pngjs';
import jpeg from 'jpeg-js';
import { decodeImage, RawImage } from './images';
import type { PosterTexts } from './posters';

/**
 * Plantilla fija para las fotos de los catálogos de proveedores: el diseño de la empresa se dibuja con código (siempre
 * igual: mismas posiciones, letras y colores) y solo cambian la vela, el nombre y el precio. No usa IA: sale exacto y
 * no cuesta nada. Copia las tres familias de afiches de VELAMIA y elige la de cada categoría (styleFor):
 * - "dorado" (Navidad): título dorado, cinta, recuadro de precio, tres íconos y franja.
 * - "minimalista" (Bautizo, Matrimonio): "VELA" fino y el nombre grande en dorado, adorno con cruz o corazón, precio en
 *   un bloque de color, recuadro de "Pedidos bajo reserva" y fila de tres íconos.
 * - "tierno" (Misa, Comunión, Graduación, Cumpleaños, Halloween…): "VELA" y el nombre en dos colores, tres íconos,
 *   recuadro de precio y franja con el nombre de la marca; cada categoría con sus colores.
 */

const SIZE = 1080;
const BAND_Y = 972;
const FONTS_DIR = path.join(__dirname, '../../assets/fonts');
const FONT_FILES = ['Montserrat-Black.ttf', 'Montserrat-ExtraBold.ttf', 'Montserrat-Bold.ttf', 'Montserrat-SemiBold.ttf', 'Montserrat-Medium.ttf', 'Montserrat-Regular.ttf', 'DancingScript-Bold.ttf']
  .map(f => path.join(FONTS_DIR, f));

// ---------- Estilo de cada categoría ----------

/** Las tres familias de afiches de la empresa. */
export type Family = 'dorado' | 'minimal' | 'tierno';

export interface CategoryStyle {
  family: Family;
  /** Fondo (arriba → abajo) y luces difuminadas. */
  bg: [string, string];
  lights: string[];
  /** Color principal (precio, franja, círculos) y su tono oscuro. */
  accent: string;
  accentDark: string;
  /** Segundo color del título y de los textos. */
  second: string;
  /** Texto oscuro. */
  ink: string;
  /** Símbolo del adorno (cruz en Bautizo, corazón en Matrimonio…). */
  symbol: 'cross' | 'heart' | 'star' | 'sparkle' | 'snowflake';
  /** Frase corta bajo el título (familia minimalista). */
  subtitle: string;
}

const plainText = (s: string) => String(s || '').normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase();

/**
 * Qué afiche le toca a cada categoría, copiado de los afiches de VELAMIA: Navidad en "dorado"; Bautizo y Matrimonio en
 * "minimalista"; Misa, Comunión, Graduación, Cumpleaños, Halloween, Quinceañera, Revelación, Baby shower, Animales y
 * Personajes en "tierno", cada una con sus colores. Lo que no se reconoce va en dorado.
 */
export function styleFor(category: string): CategoryStyle {
  const c = plainText(category);
  const tierno = (accent: string, accentDark: string, second: string, bg: [string, string], lights: string[], symbol: CategoryStyle['symbol'] = 'heart'): CategoryStyle =>
    ({ family: 'tierno', bg, lights, accent, accentDark, second, ink: second, symbol, subtitle: '' });
  const minimal = (subtitle: string, symbol: CategoryStyle['symbol']): CategoryStyle =>
    ({ family: 'minimal', bg: ['#FAF7F3', '#EDE4D9'], lights: ['#FFFFFF', '#EADBC4', '#F4ECE1', '#E2CFA9'], accent: '#B08A4E', accentDark: '#8A6630', second: '#3B2F26', ink: '#3B2F26', symbol, subtitle });
  if (/navid|christmas|noel/.test(c)) return { ...minimal('', 'snowflake'), family: 'dorado' };
  if (/bautiz|confirmaci/.test(c)) return minimal('Un detalle que ilumina su día especial', 'cross');
  if (/boda|matrimon|aniversar|compromis/.test(c)) return minimal('Un detalle que ilumina su amor', 'heart');
  if (/misa/.test(c)) return tierno('#B8914F', '#8E6A30', '#3E2412', ['#FCF8F1', '#EFE3CF'], ['#FFFFFF', '#F1E2C2', '#E7D3A6', '#FFF8EA'], 'cross');
  if (/comuni|primera/.test(c)) return tierno('#B57A26', '#8A5A17', '#3E2412', ['#FCF7EF', '#F0DFC6'], ['#FFFFFF', '#F3DFB8', '#EBCB8E', '#FFF6E6'], 'cross');
  if (/gradu/.test(c)) return tierno('#C93A63', '#8E1F40', '#3A0F1E', ['#FCF3EE', '#F1D8C8'], ['#FFFFFF', '#F7C6CF', '#F2D6A8', '#FBE3E6'], 'star');
  if (/quince/.test(c)) return tierno('#E07087', '#B83F5B', '#9E2548', ['#FFF6F5', '#F9DCE0'], ['#FFFFFF', '#F8C3CF', '#FBE0E5', '#F4B2C2'], 'heart');
  if (/revelaci|genero|sexo/.test(c)) return tierno('#DD8F98', '#B8646F', '#4F9DBF', ['#FFF8F5', '#F2E7EC'], ['#FFFFFF', '#F7CDD3', '#CFE6F2', '#FBE4E8'], 'heart');
  if (/baby|bebe/.test(c)) return tierno('#5E7FA0', '#41607F', '#C49A4E', ['#F7F9FC', '#E1E9F1'], ['#FFFFFF', '#CFDDEA', '#F1E3C4', '#E7EEF6'], 'heart');
  if (/hallow|difunt|terror/.test(c)) return tierno('#E8650F', '#A8440A', '#3A1A0A', ['#FDF3E6', '#F1D2AA'], ['#FFFFFF', '#FFC98A', '#F6A95B', '#FFE5C2'], 'star');
  if (/personaje|animad|infantil/.test(c)) return tierno('#D2637E', '#A63D58', '#8E1127', ['#FFF7F7', '#F9DFE5'], ['#FFFFFF', '#F8C6D2', '#FBE3E8', '#F2B3C3'], 'heart');
  if (/cumple|fiesta/.test(c)) return tierno('#3F8CC4', '#28679A', '#1D4E7A', ['#FBF8F2', '#E2EDF6'], ['#FFFFFF', '#CFE3F2', '#F6E7C8', '#E6F1FA'], 'star');
  if (/animal/.test(c)) return tierno('#6F7FC9', '#4C5AA3', '#2E2F5E', ['#F7F8FD', '#DFE4F6'], ['#FFFFFF', '#D6DCF4', '#EEF1FB', '#C9D2F0'], 'heart');
  return { ...minimal('', 'sparkle'), family: 'dorado' };
}

// ---------- Familia "dorado": paleta por ocasión ----------

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

/** Paleta dorada por ocasión (familia "dorado"); lo que no se reconoce va en dorado, como los afiches de VELAMIA. */
export function themeFor(category: string): TemplateTheme {
  const c = plainText(category);
  if (/navid|christmas|noel/.test(c)) return { ...GOLD, sky: ['#F7E7C8', '#C99A55'], lights: ['#FFD27A', '#F2B040', '#FFF3D1', '#E39A2E'], ornament: 'snowflake' };
  if (/hallow|difunt|terror/.test(c)) return { sky: ['#2B1B3A', '#120B1C'], lights: ['#FF8A2B', '#FFB347', '#8E44AD', '#FFD27A'], metal: ['#FFC15E', '#F07B1D', '#A8430C'], accent: ['#F07B1D', '#8E3B0A'], ink: '#FFF4E6', ornament: 'star' };
  if (/baby|bebe|revelaci|genero/.test(c)) return { sky: ['#F4F8FC', '#DDE8F2'], lights: ['#BFD6EA', '#F3D9E4', '#FFFFFF', '#E9C98F'], metal: ['#8FB1CF', '#5C82A6', '#3E5E7E'], accent: ['#C9A45C', '#8C6A2C'], ink: '#34506B', ornament: 'heart' };
  return GOLD;
}

// ---------- Medidas de texto (aprox. de Montserrat, en "em") ----------

const WIDE = 'MW';
const NARROW = 'IJ1.,:;\'!|';
/** Ancho aproximado de un texto con Montserrat del peso indicado (em). */
export function textWidth(text: string, weight = 900): number {
  const base = weight >= 900 ? 0.78 : weight >= 800 ? 0.74 : weight >= 600 ? 0.7 : 0.66;
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
  // Una línea con solo un número o una palabra de 1-2 letras ("1", "DE") se ve suelta: no se permite.
  const lonely = (line: string) => words.length > 1 && line.length <= 2;
  for (let n = Math.max(1, least); n <= Math.min(maxLines, words.length); n++) for (const lines of splits(0, n)) {
    if (lines.some(lonely)) continue;
    const widest = Math.max(...lines.map(l => textWidth(l, weight)));
    const size = Math.min(maxSize, boxW / widest, boxH / (lines.length * lineHeight));
    const bestWidest = Math.max(...best.lines.map(l => textWidth(l, weight)));
    if (size > best.size + 0.5 || (Math.abs(size - best.size) <= 0.5 && lines.length === best.lines.length && widest < bestWidest)) best = { lines, size };
  }
  return { lines: best.lines, size: Math.floor(best.size) };
}

/** Título con "VELA" en su propia línea (como en los afiches): el resto se reparte y todo va del mismo tamaño. */
export function fitTitle(name: string, boxW: number, boxH: number, maxSize: number, maxRest = 3): { lines: string[]; size: number } {
  const clean = name.replace(/\s+[-–—]\s+/g, ' ').trim();
  const match = clean.match(/^(VELAS?)\s+(.+)$/i);
  if (!match) return fitLines(clean, boxW, boxH, maxSize, maxRest + 1, 900, 0.96);
  const rest = fitLines(match[2], boxW, boxH, maxSize, maxRest, 900, 0.96);
  let best = { lines: [match[1], ...rest.lines], size: 0 };
  for (let n = 1; n <= maxRest; n++) {
    const candidate = fitLines(match[2], boxW, boxH * n / (n + 1), maxSize, n, 900, 0.96, n);
    if (candidate.lines.length !== n) continue;
    const size = Math.floor(Math.min(candidate.size, boxW / textWidth(match[1], 900), boxH / ((n + 1) * 0.96)));
    if (size > best.size) best = { lines: [match[1], ...candidate.lines], size };
  }
  return best;
}

/** ¿Color oscuro? (luminancia baja) */
const isDark = (hex: string) => { const n = parseInt(hex.slice(1), 16); return (0.299 * (n >> 16) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) < 110; };

const esc = (s: string) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const money = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(2));
const n0 = (v: number) => v.toFixed(0);

// ---------- Íconos (trazos, caja de 48×48) ----------

const ICONS: Record<string, string> = {
  gift: '<rect x="9" y="20" width="30" height="20" rx="2"/><rect x="7" y="13" width="34" height="8" rx="2"/><path d="M24 13v27M17 13c-5-6 3-10 7 0M31 13c5-6-3-10-7 0"/>',
  heart: '<path d="M24 39s-14-8.5-14-18a7.5 7.5 0 0 1 14-4 7.5 7.5 0 0 1 14 4c0 9.5-14 18-14 18z"/>',
  calendar: '<rect x="8" y="11" width="30" height="27" rx="3"/><path d="M8 19h30M15 7v7M31 7v7M14 26h3M21 26h3M28 26h3M14 32h3M21 32h3"/>',
  lock: '<rect x="9" y="21" width="30" height="21" rx="4"/><path d="M15 21v-5a9 9 0 0 1 18 0v5"/><path d="M24 36s-5.5-3.3-5.5-6.8a2.9 2.9 0 0 1 5.5-1.4 2.9 2.9 0 0 1 5.5 1.4c0 3.5-5.5 6.8-5.5 6.8z" fill="currentColor"/>',
  candle: '<rect x="17" y="20" width="14" height="21" rx="2"/><path d="M24 20v-3M24 6c-3 4-4 6-2 9 1 1.5 3 1.5 4 0 2-3 1-5-2-9z"/>',
  snowflake: '<path d="M24 6v36M8.4 15l31.2 18M8.4 33l31.2-18M24 6l-4 4M24 6l4 4M24 42l-4-4M24 42l4-4"/>',
  sparkle: '<path d="M24 6c1.5 9 4 11.5 13 13-9 1.5-11.5 4-13 13-1.5-9-4-11.5-13-13 9-1.5 11.5-4 13-13z" fill="currentColor"/>',
  star: '<path d="M24 7l5 11 12 1.2-9 8 2.7 11.8L24 33l-10.7 6 2.7-11.8-9-8L19 18z" fill="currentColor"/>',
  cross: '<path d="M24 6v36M14 17h20" stroke-width="5"/>'
};
const FEATURE_ICONS = ['gift', 'heart', 'calendar', 'sparkle'];
const MINIMAL_ICONS = ['candle', 'heart', 'gift'];

function icon(name: string, x: number, y: number, size: number, color = '#fff', stroke = 2.6): string {
  const s = size / 48;
  return `<g transform="translate(${n0(x)} ${n0(y)}) scale(${s.toFixed(3)})" fill="none" stroke="${color}" stroke-width="${stroke}" stroke-linecap="round" stroke-linejoin="round" color="${color}">${ICONS[name] || ICONS.sparkle}</g>`;
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

interface Box { x: number; y: number; w: number; h: number }

/**
 * La vela en su lugar. Con fondo blanco (lo normal en los PDF) va sobre un halo de luz y el blanco de la foto se funde
 * con él: se ve la vela sola, sin recortes que borren partes claras. Con fondo de escenario, la foto llena la zona de la
 * derecha y se funde con el fondo por el borde izquierdo.
 */
function productLayer(product: Buffer, box: Box): string {
  const raw = decodeImage(product);
  if (whiteBackground(raw)) {
    const clean = whiten(raw);
    const area = trimWhite(clean);
    const scale = Math.min(box.w / area.w, box.h / area.h);
    const pw = area.w * scale, ph = area.h * scale;
    const px = box.x + (box.w - pw) / 2, py = box.y + box.h - ph;
    const ix = px - area.x * scale, iy = py - area.y * scale;
    const cx = px + pw / 2, cy = py + ph / 2, r = Math.max(pw, ph) * 0.62 + 40;
    return `<ellipse cx="${n0(cx)}" cy="${n0(cy)}" rx="${n0(r)}" ry="${n0(r)}" fill="url(#halo)"/>`
      + `<ellipse cx="${n0(cx)}" cy="${n0(py + ph - 4)}" rx="${n0(pw * 0.4)}" ry="16" fill="#000" opacity="0.18" filter="url(#blurSmall)"/>`
      + `<mask id="area"><rect x="${n0(px - 4)}" y="${n0(py - 4)}" width="${n0(pw + 8)}" height="${n0(ph + 8)}" fill="#fff" filter="url(#blurMask)"/></mask>`
      + `<image href="${pngDataUrl(clean)}" x="${n0(ix)}" y="${n0(iy)}" width="${n0(clean.width * scale)}" height="${n0(clean.height * scale)}" mask="url(#area)" style="mix-blend-mode:multiply"/>`;
  }
  const x0 = Math.max(0, box.x - 110), w = SIZE - x0;
  return `<mask id="scene"><rect x="${x0}" y="0" width="${w}" height="${BAND_Y}" fill="url(#sceneFade)"/></mask>`
    + `<image href="${pngDataUrl(raw)}" x="${x0}" y="0" width="${w}" height="${BAND_Y}" preserveAspectRatio="xMidYMid slice" mask="url(#scene)"/>`;
}

/** Fondo: luces difuminadas con la paleta de la categoría (o el fondo propio de la empresa). */
function backgroundLayer(colors: [string, string], lights: string[], custom?: Buffer | null): string {
  let out = `<rect width="${SIZE}" height="${SIZE}" fill="url(#sky)"/>`;
  if (custom) return out + `<image href="${pngDataUrl(decodeImage(custom))}" x="0" y="0" width="${SIZE}" height="${SIZE}" preserveAspectRatio="xMidYMid slice"/>`;
  let seed = 7;
  const rnd = () => { seed = (seed * 9301 + 49297) % 233280; return seed / 233280; };
  const light = (count: number, rMin: number, rMax: number, oMin: number, oMax: number) => Array.from({ length: count }, (_, i) => {
    const x = 380 + rnd() * 760, y = rnd() * 980, r = rMin + rnd() * (rMax - rMin);
    return `<circle cx="${n0(x)}" cy="${n0(y)}" r="${n0(r)}" fill="${lights[i % lights.length]}" opacity="${(oMin + rnd() * (oMax - oMin)).toFixed(2)}"/>`;
  }).join('');
  return out + `<g filter="url(#blur)">${light(28, 40, 90, 0.35, 0.7)}</g><g filter="url(#blurSoft)">${light(40, 8, 22, 0.5, 0.95)}</g>`;
}

/** Definiciones comunes (degradados, filtros) con los colores de la categoría. */
function defs(sky: [string, string], veilColor: string, veilOpacity: [number, number], extra = ''): string {
  return `<defs>
  <linearGradient id="sky" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${sky[0]}"/><stop offset="1" stop-color="${sky[1]}"/></linearGradient>
  <linearGradient id="veil" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="${veilColor}" stop-opacity="${veilOpacity[0]}"/><stop offset="0.48" stop-color="${veilColor}" stop-opacity="${veilOpacity[1]}"/><stop offset="0.62" stop-color="${veilColor}" stop-opacity="0"/></linearGradient>
  <linearGradient id="sceneFade" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#fff" stop-opacity="0"/><stop offset="0.28" stop-color="#fff" stop-opacity="1"/></linearGradient>
  <radialGradient id="halo"><stop offset="0" stop-color="#fff"/><stop offset="0.62" stop-color="#fff"/><stop offset="0.8" stop-color="#fff" stop-opacity="0.55"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></radialGradient>
  <filter id="blur" x="-20%" y="-20%" width="140%" height="140%"><feGaussianBlur stdDeviation="16"/></filter>
  <filter id="blurSoft" x="-20%" y="-20%" width="140%" height="140%"><feGaussianBlur stdDeviation="5"/></filter>
  <filter id="blurMask" x="-10%" y="-10%" width="120%" height="120%"><feGaussianBlur stdDeviation="6"/></filter>
  <filter id="blurSmall" x="-20%" y="-50%" width="140%" height="200%"><feGaussianBlur stdDeviation="10"/></filter>
  <filter id="shadow" x="-10%" y="-10%" width="120%" height="130%"><feDropShadow dx="0" dy="4" stdDeviation="5" flood-color="#000" flood-opacity="0.22"/></filter>
  ${extra}
</defs>`;
}

const svgOpen = `<svg xmlns="http://www.w3.org/2000/svg" width="${SIZE}" height="${SIZE}" viewBox="0 0 ${SIZE} ${SIZE}" font-family="Montserrat">`;

// ---------- El afiche ----------

export interface TemplateInput {
  /** Foto del proveedor (JPG o PNG). */
  product: Buffer;
  texts: PosterTexts;
  category: string;
  /** Nombre de la marca para la franja (familia "tierno"). */
  brand?: string;
  /** Fondo propio de la empresa para esa categoría (opcional). */
  background?: Buffer | null;
}

/** Arma el SVG del afiche con la familia de su categoría (se exporta para las pruebas). */
export function posterSvg(input: TemplateInput): string {
  const style = styleFor(input.category);
  if (style.family === 'minimal') return minimalSvg(input, style);
  if (style.family === 'tierno') return tiernoSvg(input, style);
  return doradoSvg(input);
}

// ---------- Familia "dorado" (Navidad) ----------

function doradoSvg(input: TemplateInput): string {
  const t = input.texts;
  const th = themeFor(input.category);
  const dark = isDark(th.sky[0]);
  const L = 40, W = 520, CX = L + W / 2;

  const title = fitLines(t.title.replace(/\s+[-–—]\s+/g, ' '), W, 250, 132, 3, 900);
  const lh = title.size * 0.98;
  const ribbonFit = fitLines(t.ribbon, 400, 72, 34, 2, 800, 1.1);
  const ribbonH = Math.max(64, ribbonFit.lines.length * ribbonFit.size * 1.1 + 18);
  const priceH = t.unitPrice > 0 ? 262 : 232;
  const featuresH = Math.min(3, t.features.length) * 96;
  const block = title.lines.length * lh + 14 + ribbonH + 16 + priceH + 22 + featuresH;
  const titleTop = 76 + Math.max(0, (BAND_Y - 12 - 76 - block) / 2);
  const titleSvg = title.lines.map((line, i) => {
    const y = titleTop + title.size * 0.8 + i * lh;
    return `<text x="${CX}" y="${n0(y)}" font-size="${title.size}" font-weight="900" text-anchor="middle" fill="url(#metal)" stroke="#fff" stroke-width="3" paint-order="stroke" filter="url(#shadow)">${esc(line)}</text>`;
  }).join('');
  const afterTitle = titleTop + title.lines.length * lh + 14;

  const accentIcon = (name: string, x: number, y: number, size: number) => icon(name, x, y, size, th.accent[0]);
  const top = `<path d="M${CX - 150} 48H${CX - 34}M${CX + 34} 48H${CX + 150}" stroke="${th.accent[0]}" stroke-width="2.5"/>${accentIcon('sparkle', CX - 22, 26, 44)}`;

  const ribbon = ribbonFit;
  const rY = afterTitle, rH = ribbonH;
  const ribbonSvg = `<path d="M${CX - 225} ${n0(rY)}H${CX + 225}L${CX + 250} ${n0(rY + rH / 2)}L${CX + 225} ${n0(rY + rH)}H${CX - 225}L${CX - 250} ${n0(rY + rH / 2)}Z" fill="url(#accent)"/>`
    + ribbon.lines.map((line, i) => `<text x="${CX}" y="${n0(rY + rH / 2 - (ribbon.lines.length - 1) * ribbon.size * 0.55 + i * ribbon.size * 1.1 + ribbon.size * 0.36)}" font-size="${ribbon.size}" font-weight="800" text-anchor="middle" fill="#fff">${esc(line)}</text>`).join('')
    + accentIcon('sparkle', CX - 300, rY + rH / 2 - 18, 36) + accentIcon('sparkle', CX + 264, rY + rH / 2 - 18, 36);

  const pY = rY + rH + 16, pH = priceH;
  const price = `$${money(t.price)}`;
  const priceSize = Math.min(170, Math.floor(430 / textWidth(price, 900)));
  const unit = fitLines(t.unit, 380, 56, 56, 1, 800);
  const priceSvg = `<rect x="${L + 10}" y="${n0(pY)}" width="${W - 20}" height="${pH}" rx="26" fill="#fff" fill-opacity="0.94" stroke="${th.accent[0]}" stroke-width="3"/>`
    + `<text x="${CX}" y="${n0(pY + priceSize * 0.86)}" font-size="${priceSize}" font-weight="900" text-anchor="middle" fill="url(#metal)">${esc(price)}</text>`
    + `<rect x="${L + 40}" y="${n0(pY + priceSize * 0.95)}" width="${W - 80}" height="70" rx="18" fill="url(#accent)"/>`
    + `<text x="${CX}" y="${n0(pY + priceSize * 0.95 + 35 + unit.size * 0.36)}" font-size="${unit.size}" font-weight="800" text-anchor="middle" fill="#fff" letter-spacing="3">${esc(unit.lines[0])}</text>`
    + (t.unitPrice > 0 ? `<text x="${CX}" y="${n0(pY + pH - 12)}" font-size="26" font-weight="800" text-anchor="middle" fill="${th.accent[1]}">UNIDAD $${money(t.unitPrice)}</text>` : '');

  const fY = pY + pH + 22;
  const rows = t.features.slice(0, 3);
  const rowH = Math.min(96, (BAND_Y - 14 - fY) / Math.max(1, rows.length));
  const featuresSvg = rows.map((text, i) => {
    const y = fY + i * rowH;
    const r = Math.min(40, rowH * 0.42);
    const f = fitLines(text, 330, rowH - 14, 34, 2, 800, 1.08, 2);
    const textY = y + rowH / 2 - (f.lines.length - 1) * f.size * 0.54 + f.size * 0.36;
    return `<circle cx="${L + 58}" cy="${n0(y + rowH / 2)}" r="${n0(r)}" fill="url(#accent)"/>`
      + icon(FEATURE_ICONS[i], L + 58 - r * 0.62, y + rowH / 2 - r * 0.62, r * 1.24)
      + f.lines.map((line, j) => `<text x="${L + 120}" y="${n0(textY + j * f.size * 1.08)}" font-size="${f.size}" font-weight="800" fill="${dark ? '#FFF4E6' : th.ink}">${esc(line)}</text>`).join('')
      + (i < rows.length - 1 ? `<path d="M${L + 118} ${n0(y + rowH)}H${L + W - 30}" stroke="${th.accent[0]}" stroke-width="1.5" opacity="0.7"/>` : '');
  }).join('');

  const band = t.band ? fitLines(t.band, 560, 44, 44, 1, 800) : null;
  const small = t.bandSmall ? fitLines(t.bandSmall, 560, 28, 26, 1, 600) : null;
  const textW = Math.max(band ? textWidth(band.lines[0], 800) * band.size : 0, small ? textWidth(small.lines[0], 600) * small.size * 0.92 : 0);
  const groupW = (band ? 96 : 0) + textW;
  const gx = (SIZE - groupW) / 2;
  const lineL = [120, gx - 30], lineR = [gx + groupW + 30, SIZE - 120];
  const bandSvg = `<rect x="0" y="${BAND_Y}" width="${SIZE}" height="${SIZE - BAND_Y}" fill="url(#accentH)"/>`
    + (band
      ? icon('lock', gx, BAND_Y + 24, 62) + `<path d="M${n0(gx + 80)} ${BAND_Y + 22}V${SIZE - 22}" stroke="#fff" stroke-width="2"/>`
        + `<text x="${n0(gx + 96)}" y="${BAND_Y + (small ? 54 : 70)}" font-size="${band.size}" font-weight="800" fill="#fff">${esc(band.lines[0])}</text>`
        + (small ? `<text x="${n0(gx + 96)}" y="${BAND_Y + 90}" font-size="${small.size}" font-weight="600" fill="#fff">${esc(small.lines[0])}</text>` : '')
      : small ? `<text x="${SIZE / 2}" y="${BAND_Y + 64}" font-size="${small.size}" font-weight="700" text-anchor="middle" fill="#fff">${esc(small.lines[0])}</text>` : '')
    + icon(th.ornament, 44, BAND_Y + 30, 50) + icon(th.ornament, SIZE - 94, BAND_Y + 30, 50)
    + (lineL[1] - lineL[0] > 40 ? `<path d="M${lineL[0]} ${BAND_Y + 56}H${n0(lineL[1])}M${n0(lineR[0])} ${BAND_Y + 56}H${lineR[1]}" stroke="#fff" stroke-width="2" opacity="0.8"/>` : '');

  const productSvg = productLayer(input.product, { x: 585, y: 120, w: 450, h: 800 });
  const extra = `<linearGradient id="metal" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${th.metal[0]}"/><stop offset="0.55" stop-color="${th.metal[1]}"/><stop offset="1" stop-color="${th.metal[2]}"/></linearGradient>
  <linearGradient id="accent" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${th.accent[0]}"/><stop offset="1" stop-color="${th.accent[1]}"/></linearGradient>
  <linearGradient id="accentH" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="${th.accent[1]}"/><stop offset="0.5" stop-color="${th.accent[0]}"/><stop offset="1" stop-color="${th.accent[1]}"/></linearGradient>`;
  return `${svgOpen}${defs(th.sky, dark ? '#000' : '#fff', dark ? [0.45, 0.3] : [0.82, 0.55], extra)}
${backgroundLayer(th.sky, th.lights, input.background)}<rect width="${SIZE}" height="${SIZE}" fill="url(#veil)"/>${productSvg}${top}${titleSvg}${ribbonSvg}${priceSvg}${featuresSvg}${bandSvg}
</svg>`;
}

// ---------- Familia "tierno" (Misa, Comunión, Graduación, Cumpleaños, Halloween…) ----------

function tiernoSvg(input: TemplateInput, st: CategoryStyle): string {
  const t = input.texts;
  const L = 40, W = 500;

  // Alto de cada bloque para repartir la columna izquierda sin huecos.
  const rows = t.features.slice(0, 3);
  const rowH = 92;
  const priceH = t.unitPrice > 0 ? 222 : 196;
  const titleMaxH = BAND_Y - 40 - rows.length * rowH - priceH - 60;
  const title = fitTitle(t.title, W, Math.min(360, titleMaxH), 128);
  const lh = title.size * 0.96;
  const block = title.lines.length * lh + 22 + rows.length * rowH + 16 + priceH;
  const top = 36 + Math.max(0, (BAND_Y - 24 - 36 - block) / 2);

  // Título en dos colores: "VELA" y las líneas impares con el color principal, las pares con el segundo.
  const titleSvg = title.lines.map((line, i) => `<text x="${L}" y="${n0(top + title.size * 0.8 + i * lh)}" font-size="${title.size}" font-weight="900" fill="${i % 2 === 0 ? st.accent : st.second}" stroke="#fff" stroke-width="5" paint-order="stroke">${esc(line)}</text>`).join('');

  const fY = top + title.lines.length * lh + 22;
  const featuresSvg = rows.map((text, i) => {
    const y = fY + i * rowH, cy = y + rowH / 2, r = 40;
    const f = fitLines(text, 300, rowH - 12, 28, 3, 800, 1.1);
    const textY = cy - (f.lines.length - 1) * f.size * 0.55 + f.size * 0.36;
    return `<circle cx="${L + r}" cy="${n0(cy)}" r="${r}" fill="${st.accent}"/>`
      + icon(FEATURE_ICONS[i], L + r - 25, cy - 25, 50)
      + f.lines.map((line, j) => `<text x="${L + 2 * r + 22}" y="${n0(textY + j * f.size * 1.1)}" font-size="${f.size}" font-weight="800" fill="${st.ink}" stroke="#fff" stroke-width="3" paint-order="stroke">${esc(line)}</text>`).join('');
  }).join('');

  // Precio: recuadro blanco con el borde del color principal, rayitas a los lados y la unidad en una etiqueta.
  const pY = fY + rows.length * rowH + 16, pW = 420, pCX = L + pW / 2;
  const price = money(t.price);
  const priceSize = Math.min(140, Math.floor(280 / textWidth(price, 900)));
  const unit = fitLines(t.unit, 300, 44, 44, 1, 800);
  const rays = (x: number, dir: number) => [[-24, -30], [-34, 0], [-24, 30]].map(([dx, dy]) => `<path d="M${n0(x + dir * dx * 0.5)} ${n0(pY + 76 + dy * 0.9)}l${dir * -14} ${dy > 0 ? 8 : dy < 0 ? -8 : 0}" stroke="${st.accent}" stroke-width="5" stroke-linecap="round"/>`).join('');
  const priceSvg = `<rect x="${L}" y="${n0(pY)}" width="${pW}" height="${priceH}" rx="26" fill="#fff" fill-opacity="0.94" stroke="${st.accent}" stroke-width="4"/>`
    + rays(L + 40, 1) + rays(L + pW - 40, -1)
    + `<text x="${pCX}" y="${n0(pY + priceSize * 0.82)}" font-size="${priceSize}" font-weight="900" text-anchor="middle" fill="${st.accent}"><tspan font-size="${n0(priceSize * 0.6)}" dy="-${n0(priceSize * 0.18)}">$</tspan><tspan dy="${n0(priceSize * 0.18)}">${esc(price)}</tspan></text>`
    + `<rect x="${L + 30}" y="${n0(pY + priceSize * 0.9)}" width="${pW - 60}" height="62" rx="16" fill="${st.accent}"/>`
    + `<text x="${pCX}" y="${n0(pY + priceSize * 0.9 + 31 + unit.size * 0.36)}" font-size="${unit.size}" font-weight="800" text-anchor="middle" fill="#fff" letter-spacing="2">${esc(unit.lines[0])}</text>`
    + (t.unitPrice > 0 ? `<text x="${pCX}" y="${n0(pY + priceH - 12)}" font-size="24" font-weight="800" text-anchor="middle" fill="${st.accentDark}">UNIDAD $${money(t.unitPrice)}</text>` : '');

  // Frase a mano arriba a la derecha, como en los afiches.
  const tagline = `<g transform="rotate(-8 880 80)"><text x="880" y="62" font-family="Dancing Script" font-weight="700" font-size="38" text-anchor="middle" fill="${st.second}" stroke="#fff" stroke-width="4" paint-order="stroke">Pequeños detalles,</text><text x="880" y="104" font-family="Dancing Script" font-weight="700" font-size="38" text-anchor="middle" fill="${st.second}" stroke="#fff" stroke-width="4" paint-order="stroke">grandes momentos</text></g>`
    + icon('heart', 1000, 108, 30, st.accent, 3);

  // Franja: calendario en un círculo, "Pedidos bajo reserva" y la marca a la derecha.
  const band = t.band ? fitLines(t.band, 420, 40, 36, 1, 800) : null;
  const small = t.bandSmall ? fitLines(t.bandSmall, 420, 26, 22, 1, 600) : null;
  const brand = String(input.brand || '').trim().toUpperCase();
  const brandW = brand ? Math.min(260, textWidth(brand, 600) * 30 + brand.length * 6) : 0;
  const leftW = SIZE - (brand ? brandW + 80 : 0);
  const textW = Math.max(band ? textWidth(band.lines[0], 800) * band.size : 0, small ? textWidth(small.lines[0], 600) * small.size * 0.92 : 0);
  const gx = Math.max(40, (leftW - (100 + textW)) / 2);
  const bandSvg = `<rect x="0" y="${BAND_Y}" width="${SIZE}" height="${SIZE - BAND_Y}" fill="${st.accent}"/>`
    + `<circle cx="${n0(gx + 38)}" cy="${BAND_Y + 54}" r="38" fill="#fff"/>` + icon('calendar', gx + 38 - 24, BAND_Y + 30, 48, st.accent, 3)
    + `<path d="M${n0(gx + 94)} ${BAND_Y + 22}V${SIZE - 22}" stroke="#fff" stroke-width="2"/>`
    + (band ? `<text x="${n0(gx + 112)}" y="${BAND_Y + (small ? 52 : 66)}" font-size="${band.size}" font-weight="800" fill="#fff">${esc(band.lines[0])}</text>` : '')
    + (small ? `<text x="${n0(gx + 112)}" y="${BAND_Y + 86}" font-size="${small.size}" font-weight="600" fill="#fff">${esc(small.lines[0])}</text>` : '')
    + (brand
      ? `<path d="M${SIZE - 60 - brandW} ${BAND_Y + 36}H${SIZE - 60 - brandW / 2 - 22}M${SIZE - 60 - brandW / 2 + 22} ${BAND_Y + 36}H${SIZE - 60}" stroke="#fff" stroke-width="2"/>`
        + icon('heart', SIZE - 60 - brandW / 2 - 14, BAND_Y + 22, 28, '#fff', 3)
        + `<text x="${SIZE - 60 - brandW / 2}" y="${BAND_Y + 84}" font-size="30" font-weight="600" text-anchor="middle" fill="#fff" letter-spacing="6">${esc(brand)}</text>`
      : '');

  const productSvg = productLayer(input.product, { x: 560, y: 140, w: 480, h: 800 });
  return `${svgOpen}${defs(st.bg, '#fff', [0.85, 0.6])}
${backgroundLayer(st.bg, st.lights, input.background)}<rect width="${SIZE}" height="${SIZE}" fill="url(#veil)"/>${productSvg}${tagline}${titleSvg}${featuresSvg}${priceSvg}${bandSvg}
</svg>`;
}

// ---------- Familia "minimalista" (Bautizo, Matrimonio) ----------

function minimalSvg(input: TemplateInput, st: CategoryStyle): string {
  const t = input.texts;
  const CX = 285, W = 480;
  const clean = t.title.replace(/\s+[-–—]\s+/g, ' ').trim();
  const match = clean.match(/^(VELAS?)\s+(.+)$/i);
  const kicker = match ? match[1].toUpperCase() : 'VELA';
  const name = match ? match[2] : clean;

  const stripTop = 836;
  const title = fitLines(name, W, 190, 118, 3, 800, 1.0);
  const subtitle = st.subtitle ? fitLines(st.subtitle, 380, 70, 28, 2, 500, 1.3, 2) : null;
  const priceH = t.unitPrice > 0 ? 250 : 224, cardH = 104;
  const block = 52 + 16 + title.lines.length * title.size + 60 + (subtitle ? subtitle.lines.length * subtitle.size * 1.3 + 22 : 0) + priceH + 20 + cardH;
  const top = 50 + Math.max(0, (stripTop - 24 - 50 - block) / 2);

  const kickerSvg = `<text x="${CX}" y="${n0(top + 44)}" font-size="46" font-weight="500" text-anchor="middle" fill="${st.ink}" letter-spacing="10">${esc(kicker)}</text>`;
  const tY = top + 52 + 16;
  const titleSvg = title.lines.map((line, i) => `<text x="${CX}" y="${n0(tY + title.size * 0.82 + i * title.size)}" font-size="${title.size}" font-weight="800" text-anchor="middle" fill="${st.accent}">${esc(line)}</text>`).join('');
  const dY = tY + title.lines.length * title.size + 30;
  const divider = `<path d="M${CX - 210} ${n0(dY)}H${CX - 34}M${CX + 34} ${n0(dY)}H${CX + 210}" stroke="${st.accent}" stroke-width="2"/>`
    + icon(st.symbol, CX - 20, dY - 20, 40, st.accent, st.symbol === 'cross' ? 3 : 3.2).replace('<path d="M24 39s', '<path fill="' + st.accent + '" d="M24 39s');
  let y = dY + 34;
  const subtitleSvg = subtitle ? subtitle.lines.map((line, i) => `<text x="${CX}" y="${n0(y + subtitle.size + i * subtitle.size * 1.3)}" font-size="${subtitle.size}" font-weight="500" text-anchor="middle" fill="${st.ink}">${esc(line)}</text>`).join('') : '';
  if (subtitle) y += subtitle.lines.length * subtitle.size * 1.3 + 22;

  // Precio en un bloque de color con la unidad debajo, en blanco.
  const pX = CX - 225, pW = 450;
  const price = `$${money(t.price)}`;
  const priceSize = Math.min(150, Math.floor(380 / textWidth(price, 900)));
  const unit = fitLines(t.unit, 360, 64, 64, 1, 800);
  const priceSvg = `<rect x="${pX}" y="${n0(y)}" width="${pW}" height="${priceH}" rx="28" fill="${st.accent}"/>`
    + `<text x="${CX}" y="${n0(y + 22 + priceSize * 0.78)}" font-size="${priceSize}" font-weight="900" text-anchor="middle" fill="#fff">${esc(price)}</text>`
    + `<text x="${CX}" y="${n0(y + 22 + priceSize * 0.78 + unit.size + 6)}" font-size="${unit.size}" font-weight="800" text-anchor="middle" fill="#fff" letter-spacing="2">${esc(unit.lines[0])}</text>`
    + (t.unitPrice > 0 ? `<text x="${CX}" y="${n0(y + priceH - 16)}" font-size="24" font-weight="700" text-anchor="middle" fill="#fff">UNIDAD $${money(t.unitPrice)}</text>` : '');
  y += priceH + 20;

  // Recuadro "Pedidos / bajo reserva" con el calendario.
  const words = String(t.band || 'PEDIDOS BAJO RESERVA').split(/\s+/);
  const cardSvg = `<rect x="${pX + 12}" y="${n0(y)}" width="${pW - 24}" height="${cardH}" rx="22" fill="#fff" fill-opacity="0.75" stroke="${st.accent}" stroke-width="2.5"/>`
    + icon('calendar', pX + 44, y + cardH / 2 - 32, 64, st.accent, 2.4)
    + `<text x="${pX + 136}" y="${n0(y + cardH / 2 - 6)}" font-size="34" font-weight="800" fill="${st.ink}">${esc(words[0] || '')}</text>`
    + `<text x="${pX + 136}" y="${n0(y + cardH / 2 + 32)}" font-size="30" font-weight="500" fill="${st.ink}">${esc(words.slice(1).join(' '))}</text>`;

  // Fila de tres íconos en una franja clara.
  const cols = t.features.slice(0, 3);
  const colW = SIZE / Math.max(1, cols.length);
  const stripSvg = `<rect x="0" y="${stripTop}" width="${SIZE}" height="${BAND_Y - stripTop}" fill="#fff" fill-opacity="0.82"/>`
    + cols.map((text, i) => {
      const x = i * colW, cy = stripTop + (BAND_Y - stripTop) / 2;
      const f = fitLines(text, colW - 150, 96, 25, 3, 600, 1.2);
      const ty = cy - (f.lines.length - 1) * f.size * 0.6 + f.size * 0.36;
      return `<circle cx="${n0(x + 70)}" cy="${n0(cy)}" r="44" fill="none" stroke="${st.accent}" stroke-width="2.5"/>`
        + icon(MINIMAL_ICONS[i], x + 70 - 24, cy - 24, 48, st.accent, 2.4)
        + f.lines.map((line, j) => `<text x="${n0(x + 132)}" y="${n0(ty + j * f.size * 1.2)}" font-size="${f.size}" font-weight="${j === f.lines.length - 1 ? 700 : 500}" fill="${st.ink}">${esc(line)}</text>`).join('')
        + (i > 0 ? `<path d="M${n0(x)} ${stripTop + 26}V${BAND_Y - 26}" stroke="${st.accent}" stroke-width="1.5" opacity="0.8"/>` : '');
    }).join('');

  // Franja: candado y "Pedidos bajo reserva" centrados.
  const band = t.band ? fitLines(t.band, 560, 40, 36, 1, 800) : null;
  const small = t.bandSmall ? fitLines(t.bandSmall, 560, 26, 24, 1, 500) : null;
  const textW = Math.max(band ? textWidth(band.lines[0], 800) * band.size : 0, small ? textWidth(small.lines[0], 500) * small.size : 0);
  const gx = (SIZE - (70 + textW)) / 2;
  const bandSvg = `<rect x="0" y="${BAND_Y}" width="${SIZE}" height="${SIZE - BAND_Y}" fill="${st.accent}"/>`
    + icon('lock', gx, BAND_Y + 28, 54, '#fff', 3).replace('fill="currentColor"', `fill="${st.accent}"`).replace('<rect x="9" y="21"', '<rect fill="#fff" x="9" y="21"')
    + (band ? `<text x="${n0(gx + 70)}" y="${BAND_Y + (small ? 52 : 66)}" font-size="${band.size}" font-weight="800" fill="#fff">${esc(band.lines[0])}</text>` : '')
    + (small ? `<text x="${n0(gx + 70)}" y="${BAND_Y + 88}" font-size="${small.size}" font-weight="500" fill="#fff">${esc(small.lines[0])}</text>` : '');

  const productSvg = productLayer(input.product, { x: 580, y: 60, w: 460, h: 760 });
  return `${svgOpen}${defs(st.bg, '#fff', [0.85, 0.62])}
${backgroundLayer(st.bg, st.lights, input.background)}<rect width="${SIZE}" height="${SIZE}" fill="url(#veil)"/>${productSvg}${kickerSvg}${titleSvg}${divider}${subtitleSvg}${priceSvg}${cardSvg}${stripSvg}${bandSvg}
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
