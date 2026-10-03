import './entorno';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import jpeg from 'jpeg-js';
import { decodeImage, jpegOrientation, toInstagramJpeg } from '../src/social/images';

/** JPG de 2×1 (rojo a la izquierda, azul a la derecha) con la marca de orientación que pone el celular. */
function phoneJpeg(orientation: number | null): Buffer {
  const data = Buffer.from([255, 0, 0, 255, 0, 0, 255, 255]);
  const plainJpg = Buffer.from(jpeg.encode({ width: 2, height: 1, data }, 100).data);
  if (orientation === null) return plainJpg;
  const tiff = Buffer.from([
    0x4d, 0x4d, 0x00, 0x2a, 0x00, 0x00, 0x00, 0x08,
    0x00, 0x01,
    0x01, 0x12, 0x00, 0x03, 0x00, 0x00, 0x00, 0x01, 0x00, orientation, 0x00, 0x00,
    0x00, 0x00, 0x00, 0x00
  ]);
  const app1 = Buffer.concat([Buffer.from([0xff, 0xe1, 0x00, 2 + 6 + tiff.length]), Buffer.from('Exif\0\0', 'latin1'), tiff]);
  return Buffer.concat([plainJpg.subarray(0, 2), app1, plainJpg.subarray(2)]);
}

const isRed = (d: Buffer | Uint8Array, i: number) => d[i * 4] > 150 && d[i * 4 + 2] < 100;
const isBlue = (d: Buffer | Uint8Array, i: number) => d[i * 4 + 2] > 150 && d[i * 4] < 100;

test('lee la orientación que anota el celular (y 1 si no hay)', () => {
  assert.equal(jpegOrientation(phoneJpeg(6)), 6);
  assert.equal(jpegOrientation(phoneJpeg(8)), 8);
  assert.equal(jpegOrientation(phoneJpeg(null)), 1);
  assert.equal(jpegOrientation(Buffer.from('no es una foto')), 1);
});

test('una foto vertical del celular (guardada acostada) se endereza al decodificarla', () => {
  const img = decodeImage(phoneJpeg(6));
  assert.equal(img.width, 1);
  assert.equal(img.height, 2);
  // Girada 90° a la derecha: lo que estaba a la izquierda queda arriba.
  assert.ok(isRed(img.data, 0), 'arriba debe quedar el rojo');
  assert.ok(isBlue(img.data, 1), 'abajo debe quedar el azul');
});

test('orientación 8 (girada a la izquierda) y 3 (de cabeza)', () => {
  const left = decodeImage(phoneJpeg(8));
  assert.equal(left.width, 1);
  assert.ok(isBlue(left.data, 0) && isRed(left.data, 1));
  const upside = decodeImage(phoneJpeg(3));
  assert.equal(upside.width, 2);
  assert.ok(isBlue(upside.data, 0) && isRed(upside.data, 1));
});

test('sin marca de orientación la foto queda igual', () => {
  const img = decodeImage(phoneJpeg(null));
  assert.equal(img.width, 2);
  assert.ok(isRed(img.data, 0) && isBlue(img.data, 1));
});

test('la foto armada para Instagram sale con la foto vertical, no acostada', () => {
  const out = jpeg.decode(toInstagramJpeg(phoneJpeg(6)), { useTArray: true });
  assert.equal(out.width, 1080);
  assert.equal(out.height, 1350);
  // En el centro de la mitad de arriba va el rojo y en la de abajo el azul.
  const at = (x: number, y: number) => (y * out.width + x);
  assert.ok(isRed(out.data, at(540, 400)), 'arriba rojo');
  assert.ok(isBlue(out.data, at(540, 950)), 'abajo azul');
});
