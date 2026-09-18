/**
 * Permisos del CRM y firma del webhook. "Solo consulta" solo mira, el encargado atiende y edita,
 * y borrar un chat completo es solo del dueño. El webhook acepta la firma de cualquier app de Meta configurada.
 */
import './entorno';

process.env.META_APP_SECRET = 'secreto-principal';
process.env.META_APP_SECRETS = ' secreto-de-otra-app , ';

import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'crypto';

type Middleware = (req: any, res: any, next: () => void) => void;

function run(middleware: Middleware, req: any) {
  let status = 200;
  let nextCalled = false;
  const res = { status(code: number) { status = code; return res; }, json() { return res; }, send() { return res; } };
  middleware(req, res, () => { nextCalled = true; });
  return { status, nextCalled };
}

const asRole = (role: string) => ({ crmSession: { role } });

// El módulo se carga después de fijar las variables de entorno: lee los secretos al importarse.
async function auth() {
  const mod: any = await import('../src/middleware/auth');
  return mod.requireEditorRole ? mod : mod.default;
}

test('solo consulta no puede cambiar nada; encargado y dueño sí', async () => {
  const { requireEditorRole } = await auth();
  assert.equal(run(requireEditorRole, asRole('staff')).status, 403);
  assert.equal(run(requireEditorRole, asRole('manager')).nextCalled, true);
  assert.equal(run(requireEditorRole, asRole('owner')).nextCalled, true);
  assert.equal(run(requireEditorRole, asRole('admin')).nextCalled, true);
  assert.equal(run(requireEditorRole, {}).status, 403);
});

test('borrar un chat o cambiar la configuración es solo del dueño', async () => {
  const { requireOwnerRole } = await auth();
  assert.equal(run(requireOwnerRole, asRole('staff')).status, 403);
  assert.equal(run(requireOwnerRole, asRole('manager')).status, 403);
  assert.equal(run(requireOwnerRole, asRole('owner')).nextCalled, true);
  assert.equal(run(requireOwnerRole, asRole('admin')).nextCalled, true);
});

const signed = (secret: string, body: string) => ({
  headers: { 'x-hub-signature-256': 'sha256=' + createHmac('sha256', secret).update(body).digest('hex') },
  rawBody: Buffer.from(body)
});

test('el webhook acepta la firma de la app principal y la de otra app configurada', async () => {
  const { verifyWebhookSignature } = await auth();
  const body = '{"object":"whatsapp_business_account"}';
  assert.equal(run(verifyWebhookSignature, signed('secreto-principal', body)).nextCalled, true);
  assert.equal(run(verifyWebhookSignature, signed('secreto-de-otra-app', body)).nextCalled, true);
});

test('el webhook rechaza una firma falsa o ausente', async () => {
  const { verifyWebhookSignature } = await auth();
  const body = '{"object":"whatsapp_business_account"}';
  assert.equal(run(verifyWebhookSignature, signed('secreto-inventado', body)).status, 401);
  assert.equal(run(verifyWebhookSignature, { headers: {}, rawBody: Buffer.from(body) }).status, 401);
  const tampered = { ...signed('secreto-principal', body), rawBody: Buffer.from(body + ' ') };
  assert.equal(run(verifyWebhookSignature, tampered).status, 401);
});
