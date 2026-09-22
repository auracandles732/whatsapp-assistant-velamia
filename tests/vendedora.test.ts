/**
 * El asistente vende como una vendedora con experiencia: pide la venta, rebate objeciones y no deja morir el chat.
 */
import './entorno';

import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSystemPrompt } from '../src/services/openai';
import { normalizeProfile, PROFILE_PRESETS } from '../src/config/businessProfile';

const perfil = normalizeProfile(PROFILE_PRESETS.eventos.profile);
const catalogo = [{ name: 'Osito', price: 30, category: 'BABY SHOWER' }];

test('las instrucciones piden la venta, rebaten objeciones y retoman chats fríos', () => {
  const prompt = buildSystemPrompt(catalogo, undefined, perfil);
  assert.ok(prompt.includes('VENDE COMO UNA VENDEDORA CON EXPERIENCIA'));
  assert.ok(/pide la venta sin rodeos y varía la forma/.test(prompt));
  assert.ok(/nunca termines tu mensaje con un "no se puede"/.test(prompt));
  assert.ok(/no dejes morir el chat/.test(prompt));
  assert.ok(/como máximo UNA vez por conversación/.test(prompt));
});

test('nunca inventa escasez ni descuentos', () => {
  const prompt = buildSystemPrompt(catalogo, undefined, perfil);
  assert.ok(/Nunca inventes escasez/.test(prompt));
});

test('primer mensaje sin detalles: saluda y presenta sin preguntar, el sistema manda las fotos', () => {
  const prompt = buildSystemPrompt(catalogo, undefined, perfil);
  assert.ok(prompt.includes('PRIMER MENSAJE SIN DETALLES'));
  assert.ok(/NO hagas preguntas y deja show_products vacío/.test(prompt));
});

test('convierte invitados en unidades de venta redondeando hacia arriba', () => {
  const prompt = buildSystemPrompt(catalogo, undefined, perfil);
  if (perfil.sales.piecesPerUnit > 1) assert.ok(/cuántos invitados o personas son/.test(prompt));
});
