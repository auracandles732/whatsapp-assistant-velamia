/**
 * Protección de datos personales (LOPDP de Ecuador): pedidos de la clienta sobre sus datos, plazo de conservación,
 * política de privacidad y condiciones de venta públicas, y los datos del responsable en el perfil.
 */
import './entorno';

import test from 'node:test';
import assert from 'node:assert/strict';
import { privacyRequest } from '../src/services/privacy';
import { expiredConversations } from '../src/services/retention';
import { privacyPolicyHtml, salesTermsHtml } from '../src/services/legalPages';
import { normalizeProfile, VELAMIA_PROFILE } from '../src/config/businessProfile';

test('se reconoce cuando la clienta pide ver o borrar sus datos, o que no le escriban más', () => {
  assert.equal(privacyRequest('Por favor borren mis datos'), 'datos');
  assert.equal(privacyRequest('quiero que eliminen mi número de su lista'), 'datos');
  assert.equal(privacyRequest('¿Qué datos míos tienen guardados?'), 'datos');
  assert.equal(privacyRequest('Necesito una copia de mis datos'), 'datos');
  assert.equal(privacyRequest('No me escriban más'), 'no_contactar');
  assert.equal(privacyRequest('dejen de enviarme mensajes'), 'no_contactar');
  assert.equal(privacyRequest('no quiero recibir más publicidad'), 'no_contactar');
});

test('lo que no es un pedido sobre sus datos no se confunde', () => {
  assert.equal(privacyRequest('Borra mi pedido de 2 docenas'), null);
  assert.equal(privacyRequest('Mis datos para la factura son: Ana Pérez, RUC 0912345678001'), null);
  assert.equal(privacyRequest('¿Qué datos necesitan para el envío?'), null);
  assert.equal(privacyRequest('Elimina la vela angelito de la cotización'), null);
  assert.equal(privacyRequest('Hola, precio de la vela reno?'), null);
});

test('plazo de conservación: solo los chats sin pedidos que pasaron el plazo, y nada si está apagado', () => {
  const now = new Date('2026-09-26T12:00:00Z');
  const conversations = [
    { id: 'viejo', last_message_time: '2024-01-10T10:00:00' },
    { id: 'viejo-con-pedido', last_message_time: '2023-05-10T10:00:00' },
    { id: 'reciente', last_message_time: '2026-08-01T10:00:00' },
    { id: 'sin-fecha', created_at: '2024-02-01T10:00:00' }
  ];
  assert.deepEqual(expiredConversations(conversations, new Set(['viejo-con-pedido']), 24, now), ['viejo', 'sin-fecha']);
  assert.deepEqual(expiredConversations(conversations, new Set(), 0, now), [], 'apagado por defecto');
});

test('la política de privacidad dice quién responde, qué datos, para qué, con quién, cuánto tiempo y cómo ejercer los derechos', () => {
  const p = normalizeProfile({ ...VELAMIA_PROFILE, privacy: { legalName: 'Velas <Mía> S.A.S.', ruc: '0912345678001', email: 'datos@velamia.ec', address: 'Guayaquil', firstReplyNotice: true, retentionMonths: 24 } }, VELAMIA_PROFILE);
  const html = privacyPolicyHtml(p);
  assert.match(html, /Velas &lt;Mía&gt; S\.A\.S\./, 'los datos del perfil se escapan');
  assert.match(html, /RUC 0912345678001/);
  assert.match(html, /mailto:datos@velamia\.ec/);
  assert.match(html, /Ley Orgánica de Protección de Datos Personales/);
  assert.match(html, /OpenAI/);
  assert.match(html, /transferencia internacional/);
  assert.match(html, /después de 24 meses sin mensajes/);
  assert.match(html, /15 días/);
  assert.match(html, /spdp\.gob\.ec/);
  assert.match(html, /5 días/, 'aviso de vulneraciones a la Superintendencia');
  assert.match(html, /respondiendo <b>NO<\/b>/, 'los seguimientos se pueden cortar');
});

test('las condiciones de venta salen del perfil: pago, anticipo, entrega y devoluciones', () => {
  const html = salesTermsHtml(VELAMIA_PROFILE);
  assert.match(html, /Ley Orgánica de Defensa del Consumidor/);
  assert.match(html, /anticipo del \d+%/);
  assert.match(html, /3 días/);
  assert.match(html, /privacidad/);
});

test('el perfil guarda los datos del responsable y los valida', () => {
  const p = normalizeProfile({ privacy: { ruc: '0912345678001-x', email: 'no-es-correo', retentionMonths: 7, firstReplyNotice: false } });
  assert.equal(p.privacy.ruc, '0912345678001');
  assert.equal(p.privacy.email, '', 'un correo inválido no se guarda');
  assert.equal(p.privacy.retentionMonths, 0, 'solo plazos de la lista');
  assert.equal(p.privacy.firstReplyNotice, false);
  assert.equal(normalizeProfile({}).privacy.firstReplyNotice, true, 'el aviso de privacidad va encendido por defecto');
});
