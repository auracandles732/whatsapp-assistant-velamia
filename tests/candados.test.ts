/**
 * Ningún arreglo sellado se pierde: cada prueba de tests/candados.json tiene que seguir existiendo, y toda prueba nueva
 * tiene que quedar sellada (npm run sellar) antes de publicar.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { currentTestNames, readSeals } from './candados';

test('candados: siguen existiendo todas las pruebas selladas', () => {
  const current = new Set(currentTestNames());
  const missing = readSeals().pruebas.filter(name => !current.has(name));
  assert.deepEqual(missing, [], `Desaparecieron pruebas selladas (un arreglo viejo podría volver). Restáuralas; quitarlas solo con permiso de Aura:\n- ${missing.join('\n- ')}`);
});

test('candados: toda prueba nueva queda sellada', () => {
  const sealed = new Set(readSeals().pruebas);
  const unsealed = currentTestNames().filter(name => !sealed.has(name));
  assert.deepEqual(unsealed, [], `Pruebas sin sellar: corre "npm run sellar" y publica tests/candados.json:\n- ${unsealed.join('\n- ')}`);
});
