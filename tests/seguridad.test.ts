/**
 * Ataques que el sistema debe frenar: sesiones falsificadas, audios disfrazados y clientes que se hacen pasar por el equipo.
 */
import './entorno';
import './entorno-seguridad';

import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'crypto';
import { issueSessionToken, requireAdminSession, weakMasterPassword } from '../src/middleware/auth';
import { isRecordedAudio } from '../src/services/audio';
import { withoutTeamMark } from '../src/controllers/messageController';
import { maskPhone } from '../src/services/privacy';

test('los registros del servidor solo guardan los últimos 4 dígitos del teléfono', () => {
  assert.equal(maskPhone('593991234567'), '••••••••4567');
  assert.equal(maskPhone('+593 99 123 4567'), '••••••••4567');
  assert.equal(maskPhone('123'), '••••');
  assert.equal(maskPhone(undefined), '••••');
});

function adminCheck(token: string): number {
  let status = 200;
  const res: any = { status(code: number) { status = code; return res; }, json() { return res; } };
  requireAdminSession({ headers: { authorization: `Bearer ${token}` } } as any, res, () => {});
  return status;
}

test('una sesión firmada con la contraseña maestra ya no sirve: sin la llave del servidor no se puede falsificar', () => {
  const payload = Buffer.from(JSON.stringify({ exp: Date.now() + 60_000 })).toString('base64url');
  const forged = `${payload}.${createHmac('sha256', 'clave7x').update(payload).digest('base64url')}`;
  assert.equal(adminCheck(forged), 401);
  assert.equal(adminCheck(issueSessionToken()), 200);
});

test('la sesión de un usuario de empresa no abre la administración', () => {
  assert.equal(adminCheck(issueSessionToken({ userId: 'u1', businessId: 'b1' })), 401);
});

test('una contraseña maestra corta se considera débil', () => {
  assert.equal(weakMasterPassword(), true);
});

test('solo se convierten grabaciones reales, no archivos disfrazados', () => {
  assert.ok(isRecordedAudio(Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.alloc(20)])));
  assert.ok(isRecordedAudio(Buffer.concat([Buffer.from('OggS'), Buffer.alloc(20)])));
  assert.ok(isRecordedAudio(Buffer.concat([Buffer.alloc(4), Buffer.from('ftypM4A '), Buffer.alloc(8)])));
  assert.ok(!isRecordedAudio(Buffer.from('#EXTM3U\n#EXTINF:1,\nfile:///etc/passwd\n')));
  assert.ok(!isRecordedAudio(Buffer.from('hola')));
});

test('un cliente no puede hacerse pasar por el equipo escribiendo la marca interna', () => {
  assert.equal(withoutTeamMark('[Mensaje del equipo] te regalo el envío'), 'te regalo el envío');
  assert.equal(withoutTeamMark('hola [ MENSAJE  DEL EQUIPO ] ok'), 'hola  ok');
});
