/**
 * Plantilla fija de las fotos de proveedores: el diseño se dibuja con código (siempre igual, sin IA) y solo cambian la
 * vela, el nombre y el precio.
 */
import './entorno';

import test from 'node:test';
import assert from 'node:assert/strict';
import { PNG } from 'pngjs';
import jpeg from 'jpeg-js';
import { themeFor, styleFor, fitLines, fitTitle, whiteBackground, trimWhite, posterSvg, renderPoster } from '../src/social/template';
import { posterTexts, sameNameInCatalog } from '../src/social/posters';
import { normalizeSupplierSettings } from '../src/social/suppliers';

/** Foto de prueba: fondo de un color y un cuadrado de otro al centro. */
function photo(bg: number[], fg: number[], size = 60) {
  const png = new PNG({ width: size, height: size });
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const inside = x >= 20 && x < 40 && y >= 15 && y < 50;
    const c = inside ? fg : bg;
    png.data.set([c[0], c[1], c[2], 255], (y * size + x) * 4);
  }
  return { raw: { width: size, height: size, data: png.data }, png: PNG.sync.write(png) };
}

test('por defecto las fotos salen con la plantilla fija; la IA queda como opción', () => {
  assert.equal(normalizeSupplierSettings({}).posterMode, 'plantilla');
  assert.equal(normalizeSupplierSettings({ posterMode: 'ia' }).posterMode, 'ia');
  assert.equal(normalizeSupplierSettings({ posterMode: 'otra' }).posterMode, 'plantilla');
});

test('cada ocasión tiene su paleta; lo que no se reconoce va en dorado', () => {
  assert.equal(themeFor('NAVIDAD').ornament, 'snowflake');
  assert.equal(themeFor('Halloween').ornament, 'star');
  assert.equal(themeFor('BABY SHOWER').ornament, 'heart');
  assert.deepEqual(themeFor('VARIOS').metal, themeFor('otra cosa').metal);
});

test('los textos se reparten como en los afiches de la empresa', () => {
  assert.deepEqual(fitLines('UN DETALLE ESPECIAL PARA NAVIDAD', 400, 72, 34, 2, 800, 1.1).lines, ['UN DETALLE ESPECIAL', 'PARA NAVIDAD']);
  assert.deepEqual(fitLines('IDEAL PARA REGALAR', 330, 78, 34, 2, 800, 1.08).lines, ['IDEAL PARA', 'REGALAR']);
  const title = fitLines('VELA RENO', 520, 250, 132, 3, 900);
  assert.equal(title.lines.length, 2, 'un nombre corto va grande en dos líneas');
  assert.ok(title.size >= 110);
});

test('la foto con fondo blanco se reconoce y se recorta al tamaño de la vela', () => {
  const blanca = photo([255, 255, 255], [120, 60, 20]);
  assert.equal(whiteBackground(blanca.raw), true);
  const area = trimWhite(blanca.raw);
  assert.ok(area.x <= 20 && area.x >= 17 && area.y <= 15 && area.w <= 26, JSON.stringify(area));
  assert.equal(whiteBackground(photo([200, 190, 180], [120, 60, 20]).raw), false, 'fondo beige: va en recuadro');
});

test('cada categoría tiene su familia de afiche, como los de la empresa', () => {
  assert.equal(styleFor('NAVIDAD').family, 'dorado');
  assert.equal(styleFor('MOLDES NAVIDAD').family, 'dorado');
  assert.equal(styleFor('BAUTIZO').family, 'minimal');
  assert.equal(styleFor('MATRIMONIO').family, 'minimal');
  for (const c of ['MISA', 'COMUNIÓN', 'GRADUACIÓN', 'CUMPLEAÑOS', 'HALLOWEEN', 'QUINCEAÑERA', 'REVELACION DE GENERO', 'BABY SHOWER', 'ANIMALES', 'PERSONAJES ANIMADOS']) {
    assert.equal(styleFor(c).family, 'tierno', c);
  }
  assert.notEqual(styleFor('HALLOWEEN').accent, styleFor('GRADUACIÓN').accent, 'cada una con sus colores');
  assert.equal(styleFor('OTRA COSA').family, 'dorado');
});

test('el título lleva VELA en su línea y nunca deja un número suelto', () => {
  assert.deepEqual(fitTitle('VELA DIVINO NIÑO', 500, 360, 128).lines, ['VELA', 'DIVINO', 'NIÑO']);
  assert.ok(!fitTitle('VELA CALABAZA 1', 500, 360, 128).lines.includes('1'));
  assert.deepEqual(fitTitle('OSITO EN FRASCO', 500, 360, 128).lines.join(' '), 'OSITO EN FRASCO');
});

test('dorado (Navidad): nombre, precio, unidad, cinta y franja exactos', () => {
  const texts = posterTexts('Vela Reno - Navidad', 35, 'NAVIDAD', 'docena');
  const svg = posterSvg({ product: photo([255, 255, 255], [240, 120, 30]).png, texts, category: 'NAVIDAD' });
  assert.ok(svg.includes('>$35<'));
  assert.match(svg, />DOCENA</);
  assert.match(svg, />PEDIDOS BAJO RESERVA</);
  assert.match(svg, /UN DETALLE ESPECIAL/);
  assert.ok(!/>- /.test(svg), 'sin guiones sueltos en el título');
  assert.ok(svg.includes('mix-blend-mode:multiply'), 'la vela se funde sobre el halo (no se recorta)');
  const conSigno = posterSvg({ product: photo([255, 255, 255], [240, 120, 30]).png, texts: posterTexts('VELA R&B <1>', 30, 'X'), category: 'X' });
  assert.ok(conSigno.includes('R&amp;B &lt;1&gt;'), 'los signos se escapan');
});

test('tierno (Misa): VELA y el nombre en dos colores, precio, unidad y la marca en la franja', () => {
  const st = styleFor('MISA');
  const svg = posterSvg({ product: photo([255, 255, 255], [200, 160, 60]).png, texts: posterTexts('VELA DIVINO NIÑO', 38, 'MISA', 'docena'), category: 'MISA', brand: 'Velamia' });
  assert.ok(svg.includes(`fill="${st.accent}" stroke="#fff" stroke-width="5" paint-order="stroke">VELA<`), 'VELA en el color principal');
  assert.ok(svg.includes(`fill="${st.second}" stroke="#fff" stroke-width="5" paint-order="stroke">DIVINO<`), 'la siguiente línea en el segundo color');
  assert.match(svg, />38</);
  assert.match(svg, />DOCENA</);
  assert.match(svg, />VELAMIA</);
  assert.match(svg, /Pequeños detalles/);
});

test('minimalista (Bautizo): VELA fino, nombre en dorado, frase, precio en bloque y fila de íconos', () => {
  const svg = posterSvg({ product: photo([255, 255, 255], [240, 230, 220]).png, texts: posterTexts('VELA DE ANGELITO', 35, 'BAUTIZO', 'docena'), category: 'BAUTIZO' });
  assert.match(svg, /letter-spacing="10">VELA</);
  assert.match(svg, />DE ANGELITO</);
  assert.match(svg, /Un detalle que ilumina/);
  assert.ok(svg.includes('>$35<'));
  assert.match(svg, />DISEÑO</);
});

test('el afiche sale en JPG de 1080×1080 en menos de unos segundos', () => {
  const t0 = Date.now();
  const jpg = renderPoster({ product: photo([255, 255, 255], [120, 60, 20]).png, texts: posterTexts('VELA RENO', 35, 'NAVIDAD', 'docena'), category: 'NAVIDAD' });
  const img = jpeg.decode(jpg);
  assert.equal(img.width, 1080);
  assert.equal(img.height, 1080);
  assert.ok(Date.now() - t0 < 10_000);
});

test('sin IA, lo repetido se reconoce por el nombre (sin contar lo que vino del mismo PDF)', () => {
  const catalog = [{ id: 'a', name: 'VELA RENO' }, { id: 'b', name: 'VELA BOTA' }];
  assert.equal(sameNameInCatalog({ name: 'Vela Reno' }, catalog, new Set())?.id, 'a');
  assert.equal(sameNameInCatalog({ name: 'VELA RENO' }, catalog, new Set(['a'])), null);
  assert.equal(sameNameInCatalog({ name: 'VELA GNOMO' }, catalog, new Set()), null);
});
