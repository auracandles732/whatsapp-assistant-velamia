import test from 'node:test';
import assert from 'node:assert/strict';
import { newCode, findUsable } from '../src/services/signupCodes';

const future = new Date(Date.now() + 86_400_000).toISOString();
const past = new Date(Date.now() - 86_400_000).toISOString();

test('el código nuevo tiene el formato NX-XXXX-XXXX', () => {
  assert.match(newCode(), /^NX-[A-Z2-9]{4}-[A-Z2-9]{4}$/);
});
test('un código vigente y sin usar sirve, escrito con o sin guiones y en minúsculas', () => {
  const list = [{ code: 'NX-ABCD-EF23', expiresAt: future }];
  assert.ok(findUsable(list, 'NX-ABCD-EF23'));
  assert.ok(findUsable(list, 'nx abcd ef23'));
});
test('un código vencido, usado o inexistente no sirve', () => {
  assert.equal(findUsable([{ code: 'NX-ABCD-EF23', expiresAt: past }], 'NX-ABCD-EF23'), null);
  assert.equal(findUsable([{ code: 'NX-ABCD-EF23', expiresAt: future, usedAt: new Date().toISOString() }], 'NX-ABCD-EF23'), null);
  assert.equal(findUsable([{ code: 'NX-ABCD-EF23', expiresAt: future }], 'NX-ZZZZ-ZZZZ'), null);
  assert.equal(findUsable([], ''), null);
});
