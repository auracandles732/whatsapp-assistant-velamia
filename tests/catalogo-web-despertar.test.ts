/**
 * El catálogo no llegaba a la web desde el 7-oct-2026: Render no despierta el panel gratis dormido cuando lo llama el
 * servidor del CRM (502 "no-deploy" al instante), pero sí cuando la llamada viene de internet. Ver docs/ARREGLOS.md.
 */
import './entorno';

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';
import { needsPush, WebSettings } from '../src/services/webCatalog';

const base: WebSettings = { url: 'https://panel.onrender.com', key: 'x', enabled: true, lastSyncAt: '', lastError: '', lastCount: 0, pendingSince: '' };

test('catálogo web: solo se manda si hay cambios sin llegar (cada envío despierta el panel y gasta horas gratis)', () => {
  assert.equal(needsPush(base), false);
  assert.equal(needsPush({ ...base, pendingSince: '2026-10-10T20:00:00Z' }), true);
  assert.equal(needsPush({ ...base, pendingSince: '2026-10-10T20:00:00Z', enabled: false }), false);
  assert.equal(needsPush({ ...base, pendingSince: '2026-10-10T20:00:00Z', url: '' }), false);
  const source = readFileSync('src/services/webCatalog.ts', 'utf8');
  assert.match(source, /const pushIfPending = async \(\) => \{\s*if \(needsPush\(await readSettings\(\)\)\) await pushToWeb\(\);/, 'la vuelta de cada hora solo manda lo pendiente');
  assert.match(source, /lastCount: list\.length, pendingSince: '' \}/, 'un envío que llegó deja de estar pendiente');
  assert.match(source, /pendingSince: now\.pendingSince \|\| new Date\(\)\.toISOString\(\)/, 'un envío que falló sigue pendiente');
  assert.match(source, /export function scheduleWebPush[\s\S]{0,300}markPending\(\)/, 'cada cambio del catálogo queda pendiente');
});

test('catálogo web: el CRM abierto en el navegador despierta el panel dormido y pide el envío', () => {
  const html = readFileSync('dashboard/index.html', 'utf8');
  assert.ok(html.includes("const web = await api('/api/web-catalog/pending');"));
  assert.ok(html.includes("fetch(web.url + '/api/sync/productos', { mode: 'no-cors', cache: 'no-store' })"));
  assert.ok(html.includes("if (awake) await api('/api/web-catalog/sync', { method: 'POST', body: '{}' });"));
  assert.ok(readFileSync('src/services/webCatalogRoutes.ts', 'utf8').includes("router.get('/api/web-catalog/pending'"));
  assert.ok(readFileSync('src/index.ts', 'utf8').includes("`connect-src 'self' https://unpkg.com ${STORAGE_ORIGIN} ${webOriginsForCsp()}`"), 'la protección del CRM debe dejar llamar al panel conectado');
});
