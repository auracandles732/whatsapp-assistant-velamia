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
