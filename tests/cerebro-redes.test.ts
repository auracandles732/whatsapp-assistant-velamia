/**
 * El agente de redes tiene su propia clave y sus propios modelos: por defecto gpt-5.6-sol para decidir y escribir,
 * gpt-image-2 en calidad media para las fotos. Nunca toma la clave del asistente de mensajes.
 */
import './entorno';

import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeSocialAi, DEFAULT_SOCIAL_AI } from '../src/social/ai';

test('por defecto usa sus propios modelos recomendados y sin clave', () => {
  assert.deepEqual(normalizeSocialAi({}), DEFAULT_SOCIAL_AI);
  assert.equal(DEFAULT_SOCIAL_AI.apiKey, '', 'no hereda ninguna clave');
  assert.equal(DEFAULT_SOCIAL_AI.textModel, 'gpt-5.6-sol');
  assert.equal(DEFAULT_SOCIAL_AI.imageModel, 'gpt-image-2');
  assert.equal(DEFAULT_SOCIAL_AI.imageQuality, 'medium');
});

test('un modelo o una calidad que no están en la lista vuelven al recomendado', () => {
  const s = normalizeSocialAi({ textModel: 'gpt-4', imageModel: 'dall-e-3', imageQuality: 'ultra', apiKey: 'enc:x' });
  assert.equal(s.textModel, 'gpt-5.6-sol');
  assert.equal(s.imageModel, 'gpt-image-2');
  assert.equal(s.imageQuality, 'medium');
  assert.equal(s.apiKey, 'enc:x', 'la clave guardada (cifrada) se conserva');
  assert.equal(normalizeSocialAi({ textModel: 'gpt-5.6-luna' }).textModel, 'gpt-5.6-luna');
});
