/**
 * Mensajes escritos desde el CRM pasadas las 24 horas: WhatsApp los aceptaba y después los descartaba sin avisar.
 * Ahora se reconoce el plazo, se explica cada "no entregado" y lo guardado sale cuando la clienta responde.
 */
import './entorno';

import test from 'node:test';
import assert from 'node:assert/strict';
import { windowFrom, deliveryProblem, reopenTemplateBody, holdNotice, WINDOW_MS } from '../src/services/delivery';
import { isOutsideWindowError } from '../src/services/whatsapp';

const metaError = (error: Record<string, unknown>) => ({ response: { data: { error } } });

test('el plazo de 24 horas se cierra unos minutos antes, para no enviar justo al límite', () => {
  const now = Date.parse('2026-10-05T03:20:00Z');
  assert.equal(windowFrom(new Date(now - 60 * 60 * 1000), now).open, true);
  assert.equal(windowFrom(new Date(now - 23 * 60 * 60 * 1000 - 58 * 60 * 1000), now).open, false);
  assert.equal(windowFrom(new Date(now - 8 * 86_400_000), now).open, false);
  assert.ok(WINDOW_MS < 24 * 60 * 60 * 1000);
});

test('quien nunca escribió por WhatsApp no tiene el plazo abierto', () => {
  const window = windowFrom(null);
  assert.equal(window.open, false);
  assert.equal(window.lastCustomerAt, null);
});

test('cada "no entregado" de WhatsApp se explica en palabras simples', () => {
  assert.match(deliveryProblem(131047), /24 horas/);
  assert.match(deliveryProblem(131049), /saturar/);
  assert.match(deliveryProblem(131026), /no puede recibir/);
  assert.match(deliveryProblem(131042), /pago/);
  assert.match(deliveryProblem(999999, 'Something odd'), /código 999999: Something odd/);
});

test('el rechazo por plazo se reconoce en WhatsApp, Instagram y Messenger', () => {
  assert.equal(isOutsideWindowError(metaError({ code: 131047 })), true);
  assert.equal(isOutsideWindowError(metaError({ code: 10, error_subcode: 2534022 })), true);
  assert.equal(isOutsideWindowError(metaError({ code: 10, error_subcode: 2018278 })), true);
  assert.equal(isOutsideWindowError(metaError({ code: 100, message: 'This message is sent outside of allowed window.' })), true);
  // Código 10 sin el subcódigo es falta de permisos, no el plazo.
  assert.equal(isOutsideWindowError(metaError({ code: 10, message: 'Application does not have permission' })), false);
  assert.equal(isOutsideWindowError(new Error('timeout')), false);
});

test('la plantilla para retomar lleva el nombre de la empresa, sin variables ni formato raro', () => {
  const body = reopenTemplateBody('VELAMIA *Velas*');
  assert.match(body, /de VELAMIA Velas para continuar con tu consulta/);
  assert.doesNotMatch(body, /\{\{/);
  assert.match(reopenTemplateBody(''), /^Hola 👋 Te escribimos para continuar/);
});

test('el aviso al guardar explica qué pasa con la clienta', () => {
  const sent = holdNotice({ at: new Date().toISOString(), status: 'sent' }, false);
  assert.match(sent, /quedó guardado/);
  assert.match(sent, /Ya le llegó un aviso/);
  assert.match(holdNotice({ at: '', status: 'template_pending' }, false), /revisión de Meta/);
  const social = holdNotice(null, true);
  assert.match(social, /vuelva a escribir/);
  assert.doesNotMatch(social, /aviso/);
});
