/**
 * Canales de cada empresa: qué muestra el CRM de su WhatsApp, Instagram y Facebook, y qué cuenta de WhatsApp se toma de
 * la ventana de Meta.
 */
import './entorno';

import test from 'node:test';
import assert from 'node:assert/strict';
import { channelsSummary } from '../src/services/supabase';
import { sharedWabaIds } from '../src/services/whatsappSignup';
import { encryptSecret } from '../src/services/tenant';

test('sin nada conectado, los tres canales salen sin conectar', () => {
  assert.deepEqual(channelsSummary({ whatsapp: false, phone: '593991112233', socialConnection: '' }), {
    whatsapp: { connected: false, detail: '' },
    instagram: { connected: false, detail: '' },
    facebook: { connected: false, detail: '' }
  });
});

test('con la página conectada se muestran su nombre y el Instagram enlazado', () => {
  const conexion = encryptSecret(JSON.stringify({ pageId: '1', pageName: 'Velas Ana', pageToken: 'x', instagramId: '2', instagramUsername: 'velas.ana' }));
  const canales = channelsSummary({ whatsapp: true, phone: '593991112233', socialConnection: conexion });
  assert.deepEqual(canales.whatsapp, { connected: true, detail: '593991112233' });
  assert.deepEqual(canales.facebook, { connected: true, detail: 'Velas Ana' });
  assert.deepEqual(canales.instagram, { connected: true, detail: '@velas.ana' });
});

test('una página sin Instagram profesional deja Instagram sin conectar', () => {
  const conexion = encryptSecret(JSON.stringify({ pageId: '1', pageName: 'Velas Ana', pageToken: 'x', instagramId: '' }));
  const canales = channelsSummary({ whatsapp: false, phone: '', socialConnection: conexion });
  assert.equal(canales.facebook.connected, true);
  assert.equal(canales.instagram.connected, false);
});

test('una conexión guardada que no se puede leer no rompe la tarjeta', () => {
  assert.equal(channelsSummary({ whatsapp: false, phone: '', socialConnection: 'enc:v1:basura' }).facebook.connected, false);
});

test('de la ventana de WhatsApp se toman las cuentas compartidas, sin repetir', () => {
  assert.deepEqual(sharedWabaIds([
    { scope: 'business_management' },
    { scope: 'whatsapp_business_management', target_ids: ['111', '222'] },
    { scope: 'whatsapp_business_messaging', target_ids: ['111'] }
  ]), ['111', '222']);
  assert.deepEqual(sharedWabaIds([{ scope: 'pages_show_list', target_ids: ['9'] }]), []);
});
