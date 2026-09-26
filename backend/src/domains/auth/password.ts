import { createHash, randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCallback);
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const derived = await scrypt(password, salt, 64) as Buffer;
  return `scrypt$${salt.toString('hex')}$${derived.toString('hex')}`;
}
export async function verifyPassword(password: string, stored: string): Promise<{ valid: boolean; needsUpgrade: boolean }> {
  const parts = stored.split('$');
  if (parts.length === 3 && parts[0] === 'scrypt') {
    const salt = Buffer.from(parts[1], 'hex');
    const expected = Buffer.from(parts[2], 'hex');
    if (salt.length !== 16 || expected.length !== 64) return { valid: false, needsUpgrade: false };
    const actual = await scrypt(password, salt, expected.length) as Buffer;
    return { valid: timingSafeEqual(actual, expected), needsUpgrade: false };
  }
  const legacy = createHash('sha256').update(password).digest('hex');
  const valid = stored.length === legacy.length && timingSafeEqual(Buffer.from(stored), Buffer.from(legacy));
  return { valid, needsUpgrade: valid };
}
