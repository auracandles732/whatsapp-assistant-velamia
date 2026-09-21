import test from 'node:test';
import assert from 'node:assert/strict';
import { splitPhone } from '../src/services/metaNumbers';

test('un celular de Ecuador se separa en código y número nacional', () => {
  assert.deepEqual(splitPhone('099 123 4567'), { cc: '593', national: '991234567' });
  assert.deepEqual(splitPhone('0991234567'), { cc: '593', national: '991234567' });
  assert.deepEqual(splitPhone('991234567'), { cc: '593', national: '991234567' });
  assert.deepEqual(splitPhone('+593 99 123 4567'), { cc: '593', national: '991234567' });
  assert.deepEqual(splitPhone('593991234567'), { cc: '593', national: '991234567' });
});
test('otro país exige el signo +', () => {
  assert.deepEqual(splitPhone('+57 300 123 4567'), { cc: '57', national: '3001234567' });
  assert.equal(splitPhone('3001234567'), null);
});
test('un número inválido se rechaza', () => {
  assert.equal(splitPhone(''), null);
  assert.equal(splitPhone('123'), null);
});
