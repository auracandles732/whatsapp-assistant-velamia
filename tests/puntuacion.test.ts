import test from 'node:test';
import assert from 'node:assert/strict';
import { addOpeningQuestionMarks as fix } from '../src/services/puntuacion';

test('agrega el signo de apertura a una pregunta que no lo trae', () => {
  assert.equal(fix('Cuéntame cómo te gustaría la conejita?'), '¿Cuéntame cómo te gustaría la conejita?');
  assert.equal(fix('Cuál te gusta más?'), '¿Cuál te gusta más?');
});
test('no toca preguntas que ya lo tienen', () => {
  assert.equal(fix('¿Para qué fecha la necesitas?'), '¿Para qué fecha la necesitas?');
  assert.equal(fix('Hola, ¿cómo estás?'), 'Hola, ¿cómo estás?');
});
test('después de una interjección abre en la pregunta', () => {
  assert.equal(fix('Hola, cómo estás?'), 'Hola, ¿cómo estás?');
});
test('respeta emojis, negritas y viñetas al inicio y la frase anterior', () => {
  assert.equal(fix('Te queda en $28.00 la docena 🤍 Para qué fecha la necesitas?'), 'Te queda en $28.00 la docena 🤍 ¿Para qué fecha la necesitas?');
  assert.equal(fix('🎀 *Cuántas docenas necesitas?* ✨'), '🎀 *¿Cuántas docenas necesitas?* ✨');
});
test('no cambia textos sin preguntas ni enlaces', () => {
  assert.equal(fix('Total: $116.00 con envío a Guayaquil'), 'Total: $116.00 con envío a Guayaquil');
  assert.equal(fix('Mira https://a.com/x?y=1'), 'Mira https://a.com/x?y=1');
});
test('varias líneas: cada pregunta se corrige', () => {
  assert.equal(fix('Listo\nQué color prefieres?\nY la fecha?'), 'Listo\n¿Qué color prefieres?\n¿Y la fecha?');
});
