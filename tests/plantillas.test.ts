/**
 * Plantillas de WhatsApp: lo que el CRM revisa antes de enviar una nueva a Meta y cómo muestra las que ya existen.
 */
import './entorno';

import test from 'node:test';
import assert from 'node:assert/strict';
import { templateVariables, templateProblem, summarizeTemplate } from '../src/services/whatsapp';

const base = { name: 'aviso_pedido_listo', category: 'UTILITY', language: 'es', body: 'Hola {{1}}, tu pedido ya está listo.', examples: ['María'] };

test('las variables de una plantilla se cuentan y deben ir en orden desde el 1', () => {
  assert.equal(templateVariables('Hola, tu pedido está listo.'), 0);
  assert.equal(templateVariables('Hola {{1}}, tu pedido {{2}} está listo. Gracias {{1}}.'), 2);
  assert.equal(templateVariables('Hola {{2}}, falta la primera.'), -1);
  assert.equal(templateVariables('Hola {{1}} y {{3}}, hay un salto.'), -1);
});

test('una plantilla bien armada pasa la revisión', () => {
  assert.equal(templateProblem(base), '');
  assert.equal(templateProblem({ ...base, body: 'Tu pedido ya está listo.', examples: [] }), '');
});

test('se explica qué corregir antes de enviar la plantilla a Meta', () => {
  assert.match(templateProblem({ ...base, name: 'Aviso Pedido' }), /minúsculas/);
  assert.match(templateProblem({ ...base, category: 'OTRA' }), /tipo/);
  assert.match(templateProblem({ ...base, body: '' }), /texto/);
  assert.match(templateProblem({ ...base, body: 'a'.repeat(1025), examples: [] }), /1024/);
  assert.match(templateProblem({ ...base, body: 'Hola {{2}}, sin la primera.' }), /en orden/);
  assert.match(templateProblem({ ...base, body: '{{1}}, tu pedido está listo.' }), /empiece o termine/);
  assert.match(templateProblem({ ...base, body: 'Tu pedido está listo, {{1}}' }), /empiece o termine/);
  assert.match(templateProblem({ ...base, examples: [] }), /ejemplo/);
  assert.match(templateProblem({ ...base, examples: [''] }), /ejemplo/);
});

test('de cada plantilla de Meta se muestra su estado, su tipo y el texto del cuerpo', () => {
  const resumen = summarizeTemplate({
    name: 'velamia_seguimiento_01', status: 'APPROVED', language: 'es', category: 'MARKETING', rejected_reason: 'NONE',
    components: [{ type: 'HEADER', text: 'Encabezado' }, { type: 'BODY', text: 'Hola {{1}}, ¿seguimos con tu pedido?' }]
  });
  assert.deepEqual(resumen, { name: 'velamia_seguimiento_01', status: 'APPROVED', language: 'es', category: 'MARKETING', text: 'Hola {{1}}, ¿seguimos con tu pedido?', rejectedReason: '' });
  assert.equal(summarizeTemplate({ name: 'x', status: 'REJECTED', rejected_reason: 'INVALID_FORMAT' }).rejectedReason, 'INVALID_FORMAT');
});
