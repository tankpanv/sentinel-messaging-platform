import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { createHash } from 'node:crypto';
import { hashPassword, verifyPassword } from './password.js';

test('password hashes are salted and verify without upgrading', async () => {
  const first = await hashPassword('admin');
  const second = await hashPassword('admin');
  assert.notEqual(first, second);
  assert.deepEqual(await verifyPassword('admin', first), { valid: true, needsUpgrade: false });
  assert.equal((await verifyPassword('wrong', first)).valid, false);
});

test('legacy hashes can be upgraded at login', async () => {
  const legacy = createHash('sha256').update('viewer').digest('hex');
  assert.deepEqual(await verifyPassword('viewer', legacy), { valid: true, needsUpgrade: true });
});
