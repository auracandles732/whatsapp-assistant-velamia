import './entorno';
import test from 'node:test';
import assert from 'node:assert/strict';
import { FOLLOW_UP_MARKER, isFollowUpMessage, followUpText } from '../src/services/followups';
import { withoutQuotes } from '../src/services/puntuacion';

test('el seguimiento guardado no muestra ningún rótulo, solo una marca invisible', () => {
  const saved = `${FOLLOW_UP_MARKER}Hola, amiga ✨ ¿Pudiste revisar la cotización?`;
  assert.ok(isFollowUpMessage(saved));
  assert.equal(followUpText(saved), 'Hola, amiga ✨ ¿Pudiste revisar la cotización?');
  assert.ok(!/autom|seguimiento|\d\/\d/i.test(saved));
  assert.equal(saved.replace(FOLLOW_UP_MARKER, '').startsWith('Hola'), true);
});
test('los seguimientos viejos con rótulo se siguen reconociendo', () => {
  const old = '📩 Seguimiento automático 1/5\nHola, amiga';
  assert.ok(isFollowUpMessage(old));
  assert.equal(followUpText(old), 'Hola, amiga');
});
test('un mensaje normal no es seguimiento', () => {
  assert.ok(!isFollowUpMessage('Hola, ¿cómo estás?'));
});
test('se quitan las comillas de las respuestas', () => {
  assert.equal(withoutQuotes('Puede ser en "Tela Tul" o “Caja”'), 'Puede ser en Tela Tul o Caja');
});
