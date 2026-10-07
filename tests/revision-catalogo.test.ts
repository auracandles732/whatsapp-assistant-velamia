/**
 * Revisión del catálogo (supervisor): solo acepta correcciones de escritura (nunca otro sentido), encuentra nombres y
 * fotos repetidas sin IA y convierte lo que vio la IA en las fotos en cosas para revisar.
 */
import './entorno';

import test from 'node:test';
import assert from 'node:assert/strict';
import { acceptCorrection, editDistance, plainFindings, photoFindings, textPrint, photoPrint, wordFixes, applyWordFixes, propagatedFindings, alwaysFix } from '../src/services/catalogReview';

test('las tildes, ñ y ü se marcan como "solo tildes"; un error de letras se acepta pero se pregunta', () => {
  assert.deepEqual(acceptCorrection('VELA LEON SONRIENTE', 'VELA LEÓN SONRIENTE'), { text: 'VELA LEÓN SONRIENTE', accentsOnly: true });
  assert.deepEqual(acceptCorrection('PINGUINO EN EMPAQUE AZUL', 'Pingüino en empaque azul'), { text: 'PINGÜINO EN EMPAQUE AZUL', accentsOnly: true }, 'respeta las mayúsculas');
  assert.deepEqual(acceptCorrection('NINA ERES UNICA', 'NIÑA ERES ÚNICA'), { text: 'NIÑA ERES ÚNICA', accentsOnly: true });
  assert.deepEqual(acceptCorrection('VELA CALABERA', 'VELA CALAVERA'), { text: 'VELA CALAVERA', accentsOnly: false });
  assert.deepEqual(acceptCorrection('Paloma en cajita con mono', 'Paloma en cajita con moño'), { text: 'Paloma en cajita con moño', accentsOnly: true });
});

test('nunca acepta otro sentido, otros números ni lo que no cambia', () => {
  assert.equal(acceptCorrection('VELA FANTASMA 1', 'VELA FANTASMA 2'), null, 'otro número de modelo');
  assert.equal(acceptCorrection('VELA CALAVERA #1', 'VELA CALAVERA'), null, 'quitar el número');
  assert.equal(acceptCorrection('VELA REGAN', 'VELA EXORCISTA'), null, 'otro nombre');
  assert.equal(acceptCorrection('Boy or Girl Osito Bicolor', 'Niño o Niña Osito Bicolor'), null, 'traducir');
  assert.equal(acceptCorrection('VELA BUHO', 'VELA BUHO'), null);
  assert.equal(acceptCorrection('Osito en Nube con Corazon', ''), null);
  assert.equal(editDistance('calabera', 'calavera'), 1);
});

test('sin IA: nombres repetidos, la misma foto en dos productos y productos sin foto', () => {
  const list = [
    { id: '1', name: 'VELA FANTASMA 2', price: 30, category: 'HALLOWEEN', image_url: 'https://x/a.jpg' },
    { id: '2', name: 'Vela Fantasma 2', price: 35, category: 'HALLOWEEN', image_url: 'https://x/b.jpg' },
    { id: '3', name: 'VELA POLLITO', price: 38, category: 'ANIMALES', image_url: 'https://x/b.jpg' },
    { id: '4', name: 'VELA SIN FOTO', price: 30, category: 'ANIMALES', image_url: '' }
  ];
  const out = plainFindings(list);
  assert.equal(out.filter(f => f.kind === 'nombre_repetido').length, 2);
  assert.deepEqual(out.filter(f => f.kind === 'foto_repetida').map(f => f.productId).sort(), ['2', '3']);
  assert.deepEqual(out.filter(f => f.kind === 'sin_foto').map(f => f.productId), ['4']);
});

test('lo que vio la IA en las fotos: otra cosa en la foto o el precio de la foto distinto al del catálogo', () => {
  const batch = [
    { id: 'a', name: 'VELA FANTASMA', price: 35, image_url: 'https://x/a.jpg' },
    { id: 'b', name: 'VELA LEONCITO', price: 30, image_url: 'https://x/b.jpg' },
    { id: 'c', name: 'VELA OSITO', price: 32, image_url: 'https://x/c.jpg' }
  ];
  const out = photoFindings(batch, [
    { n: 1, coincide: false, precio_en_foto: 38, muestra: 'pollito saliendo del cascarón', problema: 'La foto muestra un pollito, no un fantasma.' },
    { n: 2, coincide: true, precio_en_foto: 30, muestra: 'leoncito', problema: '' },
    { n: 3, coincide: true, precio_en_foto: null, muestra: 'osito', problema: '' }
  ]);
  assert.deepEqual(out.map(f => `${f.productId}:${f.kind}`), ['a:foto', 'a:precio_foto']);
  assert.match(out[1].detail, /La foto dice \$38 y el catálogo cobra \$35/);
});

test('las huellas cambian solo cuando cambia lo que se revisa', () => {
  const p = { name: 'VELA', web: { name: 'Vela', description: 'x' }, image_url: 'https://x/a.jpg', price: 30, category: 'A' };
  assert.equal(textPrint(p), textPrint({ ...p, price: 99 }), 'el precio no cambia la escritura');
  assert.notEqual(photoPrint(p), photoPrint({ ...p, price: 99 }), 'el precio sí cambia lo que se mira en la foto');
  assert.notEqual(textPrint(p), textPrint({ ...p, web: { ...p.web, name: 'Velita' } }));
});

test('protecciones: los diminutivos no llevan tilde y nunca se cambia masculino por femenino', () => {
  assert.equal(acceptCorrection('VELA ANGELITO CORAZÓN', 'VELA ÁNGELITO CORAZÓN'), null);
  assert.equal(acceptCorrection('VELA GRADUADO EN ARCO', 'VELA GRADUADA EN ARCO'), null);
  assert.equal(acceptCorrection('VELA CRUZ CON NIÑO', 'VELA CRUZ CON NIÑA'), null);
  assert.deepEqual(acceptCorrection('VELA PAREJA ABRAZADAS CON ROSAS', 'VELA PAREJA ABRAZADA CON ROSAS'), { text: 'VELA PAREJA ABRAZADA CON ROSAS', accentsOnly: false }, 'el plural sí se puede corregir');
  assert.deepEqual(acceptCorrection('VELA ANGEL CON CRUZ', 'VELA ÁNGEL CON CRUZ'), { text: 'VELA ÁNGEL CON CRUZ', accentsOnly: true });
});

test('una palabra corregida se corrige igual en todo el catálogo (palabra completa, con sus mayúsculas)', () => {
  const words = wordFixes([{ current: 'OSITO EN NUBE CON CORAZON', suggested: 'OSITO EN NUBE CON CORAZÓN' }, { current: 'Vela angel', suggested: 'Vela ángel' }, { current: 'como nuevo', suggested: 'cómo nuevo' }]);
  assert.deepEqual(words, { corazon: 'corazón', angel: 'ángel' }, '"como" no se aprende: depende de la frase');
  assert.equal(applyWordFixes('VELA DE ANGELITO CON CORAZON EN MEDIO', words), 'VELA DE ANGELITO CON CORAZÓN EN MEDIO', 'angelito no se toca');
  assert.equal(applyWordFixes('Angel con corazon - En bolsa', words), 'Ángel con corazón - En bolsa');
  const out = propagatedFindings([
    { id: '1', name: 'OSITO GRANDE CORAZON', image_url: '', web: { name: 'Osito Rosa', description: 'Con corazon' } },
    { id: '2', name: 'VELA ANGELITO', image_url: '', web: null }
  ], words);
  assert.deepEqual(out.map(f => `${f.productId}:${f.field}:${f.suggested}`), ['1:name:OSITO GRANDE CORAZÓN', '1:web.description:Con corazón']);
});

test('las palabras que siempre llevan tilde se corrigen aunque la IA las pase por alto', () => {
  assert.equal(applyWordFixes('Vela leon con numero para cumpleanos', {}), 'Vela león con número para cumpleaños');
  assert.equal(applyWordFixes('COLECCION UNICA', {}), 'COLECCIÓN ÚNICA');
  assert.equal(applyWordFixes('Mono de tela para papa', {}), 'Mono de tela para papa', 'mono y papa dependen de la frase');
  assert.equal(alwaysFix('canciones'), '', 'el plural de -ción no lleva tilde');
});
