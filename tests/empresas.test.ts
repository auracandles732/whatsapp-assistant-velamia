/**
 * Empresas que compran por volumen (10-oct-2026, chat de Promostore): la IA las tomó por proveedores, les puso
 * "No es cliente", contestó "lo reviso y te respondo pronto" y se calló. Ver docs/ARREGLOS.md.
 */
import './entorno';

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';
import { normalizeProfile, PROFILE_PRESETS } from '../src/config/businessProfile';
import { buildSystemPrompt } from '../src/services/openai';
import { looksLikeBuyer } from '../src/services/followups';

test('empresas: quien viene a comprar nunca es "No es cliente" (anuncio, área de compras, cotización, volumen)', () => {
  const promostore = 'Hola Velamia! (Ref: P23UB8)\nHola buenas tardes\nle saludamos de la empresa Promostore\nCoordinadora de Compras Kenya Paguay\nnosotros nos dedicamos a la personalización de productos promocionales';
  assert.equal(looksLikeBuyer(promostore), true);
  assert.equal(looksLikeBuyer('Hola! (Ref: P23UB8)'), true, 'llegó desde un anuncio o la web');
  assert.equal(looksLikeBuyer('Le escribe la coordinadora de compras de la empresa'), true);
  assert.equal(looksLikeBuyer('Quisiéramos una cotización para 500 unidades'), true);
  assert.equal(looksLikeBuyer('queremos agregar a nuestro catálogo este producto'), true);
  assert.equal(looksLikeBuyer('trabajamos por rangos de 6 12 25 50 100'), true);
});

test('empresas: couriers, bancos y proveedores que ofrecen algo siguen siendo "No es cliente"', () => {
  assert.equal(looksLikeBuyer('Hola, somos Servientrega, coordinamos la recolección de su pedido, guía 12345'), false);
  assert.equal(looksLikeBuyer('Buenos días, le ofrecemos el servicio de débito automático de su banco'), false);
  assert.equal(looksLikeBuyer('Somos proveedores de cera de soya, les ofrecemos precios al por mayor'), false);
  assert.equal(looksLikeBuyer('Busco trabajo, tengo experiencia en ventas'), false);
});

test('empresas: la guarda del código corrige a la IA y nunca deja "lo reviso y te indico" como respuesta', () => {
  const controller = readFileSync('src/controllers/messageController.ts', 'utf8');
  assert.match(controller, /if \(looksLikeBuyer\(customerSaid\)\) \{[\s\S]{0,300}handoff: 'none'/);
  assert.match(controller, /BUYER_STALL\.test\(plan\.reply\) \|\| !plan\.reply\.includes\('\?'\) \? BUYER_FIRST_QUESTION/);
});

test('empresas: el asistente sigue la negociación con empresas y el precio por volumen no lo inventa', () => {
  const prompt = buildSystemPrompt([{ name: 'Vela', price: 30, category: 'EVENTOS' }], undefined, normalizeProfile(PROFILE_PRESETS.eventos.profile));
  assert.ok(prompt.includes('- EMPRESAS: si quien escribe es una empresa'), 'falta la regla de empresas');
  assert.ok(prompt.includes('nunca inventes descuentos ni precios por rango'));
  assert.ok(prompt.includes('es un cliente MAYORISTA que compra por volumen y no se atiende como a un cliente común'));
  assert.ok(prompt.includes('Nunca uses frases de espera de robot como "lo reviso y te indico" o "te aviso".'));
  const source = readFileSync('src/services/openai.ts', 'utf8');
  assert.ok(source.includes('Una EMPRESA, tienda, distribuidor o revendedor que quiere COMPRAR'), 'not_customer debe excluir a las empresas que compran');
});

test('no es cliente: responde natural a lo que dijo, sin frases de espera de robot', () => {
  const source = readFileSync('src/services/openai.ts', 'utf8');
  assert.ok(source.includes('Prohibidas las frases de espera de robot: "lo reviso y te respondo pronto", "te aviso", "en breve te indico".'));
  assert.ok(!source.includes('dile que lo revisas y le respondes pronto'), 'volvió la frase de robot para quien no es cliente');
});
