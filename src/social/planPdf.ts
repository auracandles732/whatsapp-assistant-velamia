import axios from 'axios';
import { PNG } from 'pngjs';
import jpeg from 'jpeg-js';
import { PDFDocument, PDFFont, PDFImage, PDFPage, StandardFonts, rgb } from 'pdf-lib';
import { SocialPost, localParts, localDay, isStoryChannel } from './posts';
import { isOwnStorageUrl } from './images';

/**
 * La planificación para aprobar en PDF: portada con la estrategia, y día por día cada tanda con su hora, dónde sale, por
 * qué y las fotos. Se arma en el servidor (sin IA) cada vez que la dueña la pide en el CRM.
 */

export type PlanPdfPost = Pick<SocialPost, 'id' | 'scheduled_at' | 'theme' | 'products' | 'media' | 'channels'> & { reason?: string };
export interface PlanPdfInput { business: string; posts: PlanPdfPost[]; summary: string; tasks: string[]; timeZone: string; now: Date }
/** Descarga una foto (se puede cambiar en las pruebas). null si no se pudo. */
export type ImageLoader = (url: string) => Promise<Buffer | null>;

const W = 595.28;
const H = 841.89;
const M = 40;
const THUMB = 56;
const THUMB_GAP = 6;
const THUMB_PX = 180;

const INK = rgb(0.08, 0.11, 0.23);
const MUTED = rgb(0.42, 0.45, 0.56);
const ACCENT = rgb(0.31, 0.36, 0.84);
const SOFT = rgb(0.953, 0.957, 1);
const LINE = rgb(0.89, 0.906, 0.953);
const WHITE = rgb(1, 1, 1);

const DAYS = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];
const MONTHS = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];

// Las letras estándar del PDF (Helvetica) solo traen el alfabeto latino: los emojis y demás se quitan.
const WIN_ANSI_EXTRA = '€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ';
export function pdfText(value: unknown): string {
  return Array.from(String(value ?? '').normalize('NFC').replace(/\s+/g, ' '))
    .filter(ch => { const c = ch.charCodeAt(0); return (c >= 0x20 && c <= 0x7e) || (c >= 0xa0 && c <= 0xff) || WIN_ANSI_EXTRA.includes(ch); })
    .join('').replace(/\s+/g, ' ').trim();
}

/** Parte el texto en líneas que caben en el ancho (una palabra demasiado larga se corta). */
export function wrapText(text: string, font: PDFFont, size: number, width: number, maxLines = Infinity): string[] {
  const lines: string[] = [];
  let line = '';
  const fits = (t: string) => font.widthOfTextAtSize(t, size) <= width;
  for (let word of pdfText(text).split(' ').filter(Boolean)) {
    while (!fits(word)) {
      let cut = word.length - 1;
      while (cut > 1 && !fits(word.slice(0, cut))) cut--;
      if (line) { lines.push(line); line = ''; }
      lines.push(word.slice(0, cut));
      word = word.slice(cut);
    }
    const next = line ? `${line} ${word}` : word;
    if (fits(next)) line = next;
    else { lines.push(line); line = word; }
  }
  if (line) lines.push(line);
  if (lines.length > maxLines) {
    const kept = lines.slice(0, maxLines);
    let last = kept[maxLines - 1];
    while (last && !fits(`${last}…`)) last = last.slice(0, -1).trimEnd();
    kept[maxLines - 1] = `${last}…`;
    return kept;
  }
  return lines;
}

const dayTitle = (day: string) => {
  const [y, m, d] = day.split('-').map(Number);
  const weekday = new Date(Date.UTC(y, m - 1, d, 12)).getUTCDay();
  return `${DAYS[weekday]} ${d} de ${MONTHS[m - 1]}`;
};
const hourOf = (iso: string, tz: string) => { const p = localParts(new Date(iso), tz); return `${String(p.hour).padStart(2, '0')}:${String(p.minute).padStart(2, '0')}`; };

/** Las fotos (o videos) de la tanda, como se publican. */
function itemsOf(post: PlanPdfPost) {
  if (post.media && post.media.length) return post.media.map(m => ({ url: m.url, video: m.type === 'video', name: '' }));
  return post.products.map(p => ({ url: p.image_url, video: false, name: p.name }));
}

const netsOf = (channels: string[]) => {
  const nets = [channels.some(c => c.startsWith('instagram')) && 'Instagram', channels.some(c => c.startsWith('facebook')) && 'Facebook'].filter(Boolean);
  return nets.join(' y ');
};
const formatOf = (channels: string[]) => channels.every(isStoryChannel) ? 'Historias' : channels.some(isStoryChannel) ? 'Publicación e historias' : 'Publicación';

/** Dónde sale todo, en una frase ("Historias de Instagram y Facebook"). */
export function wherePhrase(posts: Pick<PlanPdfPost, 'channels'>[]): string {
  const all = [...new Set(posts.flatMap(p => p.channels))];
  const stories = all.filter(isStoryChannel);
  const feed = all.filter(c => !isStoryChannel(c));
  return [stories.length && `Historias de ${netsOf(stories)}`, feed.length && `Publicaciones en ${netsOf(feed)}`].filter(Boolean).join(' · ');
}

const STORAGE_PUBLIC = '/storage/v1/object/public/';

/** La foto ya achicada por Supabase (las del catálogo pesan casi 2 MB: achicarlas aquí tomaría medio minuto). */
export function smallImageUrl(url: string): string | null {
  if (!url.includes(STORAGE_PUBLIC)) return null;
  const [base] = url.split('?');
  return `${base.replace(STORAGE_PUBLIC, '/storage/v1/render/image/public/')}?width=${THUMB_PX}&height=${THUMB_PX}&resize=cover`;
}

const get = async (url: string, maxBytes: number) => {
  try {
    const { data } = await axios.get(url, { responseType: 'arraybuffer', timeout: 20_000, maxContentLength: maxBytes, headers: { Accept: 'image/png,image/jpeg,image/gif' } });
    return Buffer.from(data);
  } catch {
    return null;
  }
};
const defaultLoader: ImageLoader = async url => {
  // Solo fotos del almacenamiento propio: el servidor nunca descarga una dirección cualquiera.
  if (!isOwnStorageUrl(url)) return null;
  const small = smallImageUrl(url);
  return (small && await get(small, 2 * 1024 * 1024)) || get(url, 3 * 1024 * 1024);
};

// Las miniaturas ya hechas se guardan un rato: rehacer o volver a bajar el PDF sale al instante.
const THUMB_CACHE = new Map<string, Buffer>();
const THUMB_CACHE_MAX = 800;

function imageType(bytes: Buffer): string | null {
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return 'image/jpeg';
  if (bytes.slice(0, 4).toString('hex') === '89504e47') return 'image/png';
  if (bytes.slice(0, 3).toString() === 'GIF') return 'image/gif';
  if (bytes.slice(0, 4).toString() === 'RIFF' && bytes.slice(8, 12).toString() === 'WEBP') return 'image/webp';
  return null;
}

/** Miniatura cuadrada (recortada al centro) en JPG liviano: así el PDF pesa poco aunque lleve muchas fotos. */
export function thumbnail(bytes: Buffer): Buffer | null {
  const type = imageType(bytes);
  if (!type) return null;
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { Resvg } = require('@resvg/resvg-js');
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${THUMB_PX}" height="${THUMB_PX}">`
      + `<rect width="100%" height="100%" fill="#fff"/><image width="${THUMB_PX}" height="${THUMB_PX}" preserveAspectRatio="xMidYMid slice" `
      + `xlink:href="data:${type};base64,${bytes.toString('base64')}"/></svg>`;
    const png = PNG.sync.read(new Resvg(svg, { fitTo: { mode: 'original' }, font: { loadSystemFonts: false } }).render().asPng());
    return Buffer.from(jpeg.encode({ width: png.width, height: png.height, data: png.data }, 78).data);
  } catch {
    return null;
  }
}

/** Descarga y achica las fotos de a pocas a la vez (sin trabar al bot mientras tanto). */
async function loadThumbs(urls: string[], load: ImageLoader, cache: boolean): Promise<Map<string, Buffer>> {
  const out = new Map<string, Buffer>();
  const queue = [...new Set(urls.filter(Boolean))];
  const worker = async () => {
    for (let url = queue.shift(); url; url = queue.shift()) {
      const known = cache ? THUMB_CACHE.get(url) : undefined;
      if (known) { out.set(url, known); continue; }
      const bytes = await load(url).catch(() => null);
      await new Promise(resolve => setImmediate(resolve));
      const small = bytes ? thumbnail(bytes) : null;
      if (!small) continue;
      out.set(url, small);
      if (cache) {
        THUMB_CACHE.set(url, small);
        if (THUMB_CACHE.size > THUMB_CACHE_MAX) THUMB_CACHE.delete(THUMB_CACHE.keys().next().value!);
      }
    }
  };
  await Promise.all(Array.from({ length: 10 }, worker));
  return out;
}

export async function buildPlanPdf(input: PlanPdfInput, load: ImageLoader = defaultLoader): Promise<Buffer> {
  const { timeZone: tz } = input;
  const posts = [...input.posts].sort((a, b) => a.scheduled_at.localeCompare(b.scheduled_at));
  const doc = await PDFDocument.create();
  doc.setTitle('Planificación de contenido');
  doc.setAuthor(pdfText(input.business) || 'Agente de redes');
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);

  const thumbs = await loadThumbs(posts.flatMap(p => itemsOf(p).filter(i => !i.video).slice(0, 7).map(i => i.url)), load, load === defaultLoader);
  const images = new Map<string, PDFImage>();
  // Copia propia: un Buffer de Node puede compartir memoria con otros y pdf-lib lo leería desde el inicio equivocado.
  for (const [url, bytes] of thumbs) images.set(url, await doc.embedJpg(new Uint8Array(bytes)));

  const text = (page: PDFPage, value: string, x: number, y: number, size: number, f = font, color = INK) =>
    page.drawText(pdfText(value), { x, y, size, font: f, color });
  const right = (page: PDFPage, value: string, xRight: number, y: number, size: number, f = font, color = MUTED) =>
    text(page, value, xRight - f.widthOfTextAtSize(pdfText(value), size), y, size, f, color);

  const byDay = new Map<string, PlanPdfPost[]>();
  for (const post of posts) {
    const day = localDay(post.scheduled_at, tz);
    byDay.set(day, [...(byDay.get(day) || []), post]);
  }
  const days = [...byDay.keys()];
  const photos = posts.reduce((n, p) => n + itemsOf(p).length, 0);
  const now = localParts(input.now, tz);

  // ---------- Portada ----------
  let page = doc.addPage([W, H]);
  page.drawRectangle({ x: 0, y: H - 118, width: W, height: 118, color: ACCENT });
  text(page, pdfText(input.business).toUpperCase() || 'AGENTE DE REDES', M, H - 36, 10, bold, WHITE);
  right(page, `Generada el ${String(now.day).padStart(2, '0')}/${String(now.month).padStart(2, '0')}/${now.year} ${String(now.hour).padStart(2, '0')}:${String(now.minute).padStart(2, '0')}`, W - M, H - 36, 9, font, WHITE);
  text(page, 'Planificación de contenido', M, H - 72, 26, bold, WHITE);
  const range = days.length === 0 ? 'Sin tandas por aprobar'
    : days.length === 1 ? `Para el ${dayTitle(days[0])}` : `Del ${dayTitle(days[0])} al ${dayTitle(days[days.length - 1])}`;
  text(page, range, M, H - 98, 12, font, WHITE);

  let y = H - 118 - 24;
  const boxW = (W - 2 * M - 2 * 12) / 3;
  [[String(posts.length), posts.length === 1 ? 'tanda' : 'tandas'], [String(photos), photos === 1 ? 'foto' : 'fotos'], [String(days.length), days.length === 1 ? 'día con contenido' : 'días con contenido']]
    .forEach(([value, label], i) => {
      const x = M + i * (boxW + 12);
      page.drawRectangle({ x, y: y - 58, width: boxW, height: 58, color: SOFT, borderColor: LINE, borderWidth: 1 });
      text(page, value, x + 14, y - 32, 22, bold, ACCENT);
      text(page, label, x + 14, y - 48, 9.5, font, MUTED);
    });
  y -= 58 + 22;
  const where = wherePhrase(posts);
  if (where) {
    text(page, 'Dónde se publica:', M, y, 10.5, bold);
    text(page, where, M + bold.widthOfTextAtSize('Dónde se publica: ', 10.5), y, 10.5);
    y -= 26;
  }
  const summary = wrapText(input.summary, font, 10.5, W - 2 * M - 28, 12);
  if (summary.length) {
    const boxH = 34 + summary.length * 15;
    page.drawRectangle({ x: M, y: y - boxH, width: W - 2 * M, height: boxH, color: SOFT, borderColor: LINE, borderWidth: 1 });
    text(page, 'Por qué esta planificación', M + 14, y - 20, 11.5, bold, ACCENT);
    summary.forEach((line, i) => text(page, line, M + 14, y - 38 - i * 15, 10.5));
    y -= boxH + 16;
  }
  const how = wrapText('Para aprobarla: en el CRM > Publicaciones aplasta "Aceptar" y cada tanda sale sola a su hora. Si la rechazas o no la aceptas, no se publica nada. Tus publicaciones ya programadas no se tocan.', font, 10, W - 2 * M - 28);
  const howH = 20 + how.length * 14;
  page.drawRectangle({ x: M, y: y - howH, width: W - 2 * M, height: howH, borderColor: ACCENT, borderWidth: 1 });
  how.forEach((line, i) => text(page, line, M + 14, y - 18 - i * 14, 10));
  y -= howH + 22;

  const newPage = () => {
    page = doc.addPage([W, H]);
    text(page, 'Planificación de contenido (continuación)', M, H - 34, 9, font, MUTED);
    y = H - 56;
  };
  const room = (needed: number) => { if (y - needed < 52) newPage(); };

  // ---------- Día por día ----------
  const x2 = M + 74;
  const infoW = W - M - x2;
  const perRow = Math.floor((infoW + THUMB_GAP) / (THUMB + THUMB_GAP));
  const rowOf = (post: PlanPdfPost) => {
    const items = itemsOf(post);
    const reason = wrapText(post.reason || '', font, 9, infoW, 3);
    const names = items.some(i => i.name) ? wrapText(`Fotos: ${items.map(i => i.name).filter(Boolean).join(', ')}`, font, 8.5, infoW, 2) : [];
    return { items, reason, names, height: 20 + reason.length * 12 + names.length * 11 + 10 + THUMB + 16 };
  };
  for (const day of days) {
    const list = byDay.get(day)!;
    const rows = list.map(rowOf);
    room(36 + rows[0].height);
    page.drawRectangle({ x: M, y: y - 26, width: W - 2 * M, height: 26, color: SOFT });
    text(page, dayTitle(day).toUpperCase(), M + 10, y - 17, 10.5, bold, ACCENT);
    const dayPhotos = rows.reduce((n, r) => n + r.items.length, 0);
    right(page, `${list.length} ${list.length === 1 ? 'tanda' : 'tandas'} · ${dayPhotos} ${dayPhotos === 1 ? 'foto' : 'fotos'}`, W - M - 10, y - 17, 9);
    y -= 36;
    list.forEach((post, i) => {
      const row = rows[i];
      room(row.height);
      const top = y;
      text(page, hourOf(post.scheduled_at, tz), M + 4, top - 16, 16, bold);
      text(page, formatOf(post.channels), M + 4, top - 30, 8.5, font, MUTED);
      const title = `${post.theme || 'Nuestros productos'} · ${row.items.length} ${row.items.length === 1 ? 'foto' : 'fotos'}`;
      text(page, wrapText(title, bold, 11.5, infoW - 120, 1)[0] || '', x2, top - 14, 11.5, bold);
      right(page, netsOf(post.channels), W - M, top - 14, 9);
      let ty = top - 14 - 16;
      for (const line of row.reason) { text(page, line, x2, ty, 9, font, MUTED); ty -= 12; }
      for (const line of row.names) { text(page, line, x2, ty, 8.5, font, INK); ty -= 11; }
      const shown = row.items.length > perRow ? row.items.slice(0, perRow - 1) : row.items;
      const ty2 = ty + 4 - THUMB;
      shown.forEach((item, k) => {
        const x = x2 + k * (THUMB + THUMB_GAP);
        const image = item.video ? null : images.get(item.url);
        if (image) page.drawImage(image, { x, y: ty2, width: THUMB, height: THUMB });
        else {
          page.drawRectangle({ x, y: ty2, width: THUMB, height: THUMB, color: item.video ? INK : SOFT });
          const label = item.video ? 'VIDEO' : 'FOTO';
          text(page, label, x + (THUMB - bold.widthOfTextAtSize(label, 8)) / 2, ty2 + THUMB / 2 - 3, 8, bold, item.video ? WHITE : MUTED);
        }
        page.drawRectangle({ x, y: ty2, width: THUMB, height: THUMB, borderColor: LINE, borderWidth: 0.8 });
      });
      if (shown.length < row.items.length) {
        const x = x2 + shown.length * (THUMB + THUMB_GAP);
        const more = `+${row.items.length - shown.length}`;
        page.drawRectangle({ x, y: ty2, width: THUMB, height: THUMB, color: SOFT, borderColor: LINE, borderWidth: 0.8 });
        text(page, more, x + (THUMB - bold.widthOfTextAtSize(more, 13)) / 2, ty2 + THUMB / 2 - 5, 13, bold, ACCENT);
      }
      y = top - row.height;
      page.drawLine({ start: { x: M, y: y + 6 }, end: { x: W - M, y: y + 6 }, thickness: 0.6, color: LINE });
    });
    y -= 10;
  }

  // ---------- Para ti ----------
  const tasks = input.tasks.map(t => wrapText(`• ${t}`, font, 10, W - 2 * M - 28, 3)).filter(l => l.length);
  if (tasks.length) {
    const lines = tasks.reduce((n, t) => n + t.length, 0);
    room(40 + lines * 14);
    text(page, 'Para ti', M, y - 12, 12, bold, ACCENT);
    y -= 30;
    for (const task of tasks) for (const line of task) { text(page, line, M + 6, y, 10); y -= 14; }
    y -= 12;
  }

  const pages = doc.getPages();
  pages.forEach((p, i) => {
    text(p, `${pdfText(input.business) || 'Agente de redes'} · Planificación de contenido`, M, 24, 8, font, MUTED);
    right(p, `Página ${i + 1} de ${pages.length}`, W - M, 24, 8);
  });
  return Buffer.from(await doc.save());
}
