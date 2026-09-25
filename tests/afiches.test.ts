/**
 * Fotos con el diseño de la empresa (afiches) para los modelos de los PDF: textos del afiche, revisión de lo que la IA
 * escribió y elección de las fotos de referencia. Sin llamar a la IA.
 */
import './entorno';

import test from 'node:test';
import assert from 'node:assert/strict';
import { occasionOf, posterTexts, sameText, posterProblem, pickReferences, posterPrompt } from '../src/social/posters';

test('la ocasión sale del nombre del catálogo, sin "moldes" ni años', () => {
  assert.equal(occasionOf('MOLDES NAVIDAD'), 'NAVIDAD');
  assert.equal(occasionOf('HALLOWEEN 2026'), 'HALLOWEEN');
  assert.equal(occasionOf('Catálogo Bautizo'), 'BAUTIZO');
  assert.equal(posterTexts('Vela reno', 35, 'MOLDES NAVIDAD', 'docena').ribbon, 'UN DETALLE ESPECIAL PARA NAVIDAD');
});

test('el afiche pide exactamente el nombre, el precio y la unidad del Catálogo', () => {
  const t = posterTexts('VELA PIÑA NAVIDEÑA', 35, 'MOLDES NAVIDAD', 'docena');
  const prompt = posterPrompt(t, 'NAVIDAD');
  assert.match(prompt, /Title: "VELA PIÑA NAVIDEÑA"/);
  assert.match(prompt, /Price box: "\$35" and under it "DOCENA"/);
  assert.match(prompt, /no second price/);
});

test('la revisión acepta el afiche correcto y rechaza nombre, precio o textos inventados', () => {
  const t = posterTexts('VELA PIÑA NAVIDEÑA', 35, 'MOLDES NAVIDAD', 'docena');
  const ok = { titulo: 'Vela Piña  Navideña', precio: '$ 35', etiquetaPrecio: 'DOCENA', otrosPrecios: [], errores: [] };
  assert.equal(posterProblem(ok, t), '');
  assert.match(posterProblem({ ...ok, titulo: 'VELA PINA NAVIDENA' }, t), /nombre/, 'la Ñ cuenta');
  assert.match(posterProblem({ ...ok, precio: '$38' }, t), /precio/);
  assert.match(posterProblem({ ...ok, otrosPrecios: ['$5'] }, t), /otro precio/);
  assert.match(posterProblem({ ...ok, errores: ['UISIÑGO DECORATIVO'] }, t), /inventados/);
  assert.ok(sameText('VELA NOMO #1', 'vela  nomo #1'));
});

test('las referencias son fotos propias del Catálogo, primero las de la misma ocasión', () => {
  const own = process.env.SUPABASE_URL + '/storage/v1/object/public/product-images/';
  const catalog = [
    { id: 'a', category: 'ANIMALES', image_url: own + 'a.png', created_at: '2026-09-20' },
    { id: 'n1', category: 'NAVIDAD', image_url: own + 'n1.png', created_at: '2026-09-01' },
    { id: 'n2', category: 'NAVIDAD', image_url: own + 'n2.png', created_at: '2026-09-02' },
    { id: 'pdf', category: 'MOLDES NAVIDAD', image_url: own + 'pdf.jpeg', created_at: '2026-09-25' },
    { id: 'ajena', category: 'NAVIDAD', image_url: 'https://otro.sitio/x.png', created_at: '2026-09-25' }
  ];
  assert.deepEqual(pickReferences('MOLDES NAVIDAD', catalog, new Set(['pdf'])), [own + 'n2.png', own + 'n1.png']);
  assert.deepEqual(pickReferences('HALLOWEEN', catalog, new Set(['pdf'])), [own + 'a.png', own + 'n2.png'], 'sin la ocasión, las más recientes');
});

test('para saber si ya lo tienes se compara con la misma ocasión y con nombres parecidos, nunca con el mismo PDF', () => {
  const { duplicateCandidates } = require('../src/social/posters') as typeof import('../src/social/posters');
  const catalog = [
    { id: 'gnomo', name: 'VELA GNOMO NAVIDEÑO', category: 'NAVIDAD', image_url: 'https://x/g.png' },
    { id: 'reno', name: 'VELA RENO TIERNO', category: 'ANIMALES', image_url: 'https://x/r.png' },
    { id: 'osito', name: 'OSITO NUBE', category: 'BABY SHOWER', image_url: 'https://x/o.png' },
    { id: 'pdf', name: 'VELA RENO', category: 'MOLDES NAVIDAD', image_url: 'https://x/p.png' },
    { id: 'sinfoto', name: 'VELA RENO GRANDE', category: 'NAVIDAD', image_url: null }
  ];
  const found = duplicateCandidates({ name: 'VELA RENO' }, 'MOLDES NAVIDAD', catalog, new Set(['pdf'])).map(p => p.id);
  assert.deepEqual(found, ['reno', 'gnomo'], 'primero el mismo nombre, luego la misma ocasión; sin el del PDF ni los sin foto');
  assert.deepEqual(duplicateCandidates({ name: 'VELA ESTRELLA' }, 'VARIOS', catalog, new Set()), [], 'sin nada parecido no se gasta en comparar');
});

test('el afiche nuevo dice lo mismo que el afiche de referencia de la empresa, con la ocasión del catálogo', () => {
  const { ribbonFor } = require('../src/social/posters') as typeof import('../src/social/posters');
  assert.equal(ribbonFor('UN DETALLE ESPECIAL PARA NAVIDAD', 'NAVIDAD', 'NAVIDAD'), 'UN DETALLE ESPECIAL PARA NAVIDAD');
  assert.equal(ribbonFor('Un detalle especial para Navidad', 'NAVIDAD', 'HALLOWEEN'), 'UN DETALLE ESPECIAL PARA HALLOWEEN');
  assert.equal(ribbonFor('', '', 'BAUTIZO'), 'UN DETALLE ESPECIAL PARA BAUTIZO');
  const ref = { cinta: 'Un recuerdo tierno para momentos especiales', iconos: ['Con aroma', 'Ideal para baby shower'], franja: 'Pedidos bajo reserva', franjaPequena: 'Asegura tu pedido', etiquetaPrecio: 'por docena', occasion: 'ANIMALES' };
  const t = posterTexts('Vela osito', 38, 'ANIMALES', 'docena', ref, 3.5);
  assert.equal(t.ribbon, 'UN RECUERDO TIERNO PARA MOMENTOS ESPECIALES');
  assert.deepEqual(t.features, ['CON AROMA', 'IDEAL PARA BABY SHOWER']);
  assert.equal(t.unit, 'POR DOCENA');
  assert.equal(t.band, 'PEDIDOS BAJO RESERVA');
  assert.match(posterPrompt(t, 'ANIMALES'), /UNIDAD \$3\.50/);
  assert.doesNotMatch(posterPrompt(posterTexts('Vela osito', 38, 'ANIMALES', 'docena'), 'ANIMALES'), /UNIDAD \$/);
});

test('la revisión rechaza el afiche si no sigue el diseño, si cambia la vela o si el precio por unidad no cuadra', () => {
  const t = posterTexts('VELA RENO', 35, 'NAVIDAD', 'docena', {}, 5);
  const ok = { titulo: 'VELA RENO', precio: '$35', etiquetaPrecio: 'DOCENA', precioUnidad: '$5', otrosPrecios: ['$5'], errores: [], disenoIgual: true, velaIgual: true };
  assert.equal(posterProblem(ok, t), '');
  assert.match(posterProblem({ ...ok, disenoIgual: false, diferenciasDiseno: 'sin franja inferior' }, t), /diseño.*sin franja/);
  assert.match(posterProblem({ ...ok, velaIgual: false, diferenciasVela: 'le puso gorro' }, t), /vela.*gorro/);
  assert.match(posterProblem({ ...ok, precioUnidad: '$4' }, t), /unidad/);
  const noUnit = posterTexts('VELA RENO', 35, 'NAVIDAD', 'docena');
  assert.match(posterProblem({ ...ok, otrosPrecios: [] }, noUnit), /unidad que no va/);
});
