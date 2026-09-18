/**
 * Pruebas de los avisos del CRM: qué se le muestra a quien atiende un chat.
 * Se ejecutan con `npm test`, sin base de datos ni internet.
 */
import './entorno';

import test from 'node:test';
import assert from 'node:assert/strict';

import { buildAlerts } from '../src/services/crmOverview';

const hace = (ms: number) => new Date(Date.now() - ms).toISOString().replace('Z', '');
const MIN = 60 * 1000;
const HORA = 60 * MIN;
const msg = (sender: string, type: string, content: string, ms: number) => ({ sender, type, content, timestamp: hace(ms) });
const titulos = (alertas: Array<{ title: string }>) => alertas.map(a => a.title);

const pausado = { bot_paused_until: '2100-01-01T00:00:00Z' };
const activo = { bot_paused_until: null };

test('avisa cuando el cliente espera y el bot está en pausa', () => {
  const alertas = buildAlerts(pausado, [msg('customer', 'text', 'Hola?', 30 * MIN)], []);
  assert.deepEqual(titulos(alertas), ['Cliente esperando respuesta']);
});

test('no avisa si el bot está atendiendo o el mensaje es muy reciente', () => {
  assert.deepEqual(buildAlerts(activo, [msg('customer', 'text', 'Hola?', 30 * MIN)], []), []);
  assert.deepEqual(buildAlerts(pausado, [msg('customer', 'text', 'Hola?', 2 * MIN)], []), []);
});

test('alta intención de compra necesita al menos dos temas', () => {
  const dos = buildAlerts(activo, [msg('customer', 'text', '¿Cuánto cuesta?', HORA), msg('customer', 'text', '¿Hacen envíos a Quito?', HORA)], []);
  assert.deepEqual(titulos(dos), ['Alta intención de compra']);
  assert.match(dos[0].text, /precios, envíos/);

  const uno = buildAlerts(activo, [msg('customer', 'text', '¿Cuánto cuesta?', HORA)], []);
  assert.deepEqual(uno, []);
});

test('una cotización sin confirmar por más de un día genera aviso; una vencida no', () => {
  const sinConfirmar = { status: 'pending', total_amount: 150, created_at: hace(30 * HORA), expires_at: null };
  assert.deepEqual(titulos(buildAlerts(activo, [], [sinConfirmar])), ['Cotización sin respuesta']);

  const vencida = { ...sinConfirmar, expires_at: hace(2 * HORA) };
  assert.deepEqual(buildAlerts(activo, [], [vencida]), []);

  const reciente = { ...sinConfirmar, created_at: hace(3 * HORA) };
  assert.deepEqual(buildAlerts(activo, [], [reciente]), []);
});

test('una imagen del cliente después de los datos bancarios se avisa como posible comprobante', () => {
  const chat = [
    msg('bot', 'text', '🏦 Datos para transferencia\n\nBanco X', 3 * HORA),
    msg('customer', 'image', 'https://ejemplo.com/foto.jpg', 2 * HORA)
  ];
  assert.deepEqual(titulos(buildAlerts(activo, chat, [])), ['Posible comprobante de pago']);

  const antes = [
    msg('customer', 'image', 'https://ejemplo.com/foto.jpg', 3 * HORA),
    msg('bot', 'text', '🏦 Datos para transferencia\n\nBanco X', 2 * HORA)
  ];
  assert.deepEqual(buildAlerts(activo, antes, []), []);
});

test('nunca muestra más de tres avisos', () => {
  const chat = [
    msg('bot', 'text', '🏦 Datos para transferencia', 5 * HORA),
    msg('customer', 'image', 'https://ejemplo.com/foto.jpg', 4 * HORA),
    msg('customer', 'text', 'precio y envío por favor, hay disponibilidad?', 30 * MIN)
  ];
  const cotizacion = { status: 'pending', total_amount: 50, created_at: hace(40 * HORA), expires_at: null };
  assert.equal(buildAlerts(pausado, chat, [cotizacion]).length, 3);
});
