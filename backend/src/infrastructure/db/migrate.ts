import { SCHEMA_VERSION } from './version.js';
import { Pool } from 'pg';
import fs from 'node:fs';
import path from 'node:path';
import { hashPassword } from '../../domains/auth/password.js';

const pool = new Pool({ connectionString: process.env.DATABASE_URL || 'postgresql://sentinel:sentinel@localhost:5432/sentinel' });
const schema = fs.readFileSync(path.join(import.meta.dirname, 'schema.sql'), 'utf8');
try {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(829451913)');
    await client.query('CREATE EXTENSION IF NOT EXISTS pgcrypto');
    await client.query(schema);
    for (let index = 1; index <= 5; index++) {
      await client.query("INSERT INTO accounts(id,status) VALUES($1,'idle') ON CONFLICT DO NOTHING", [`acc-${index}`]);
    }
    for (const [username, role] of [['admin', 'admin'], ['viewer', 'viewer']]) {
      await client.query('INSERT INTO users(username,password_hash,role) VALUES($1,$2,$3) ON CONFLICT DO NOTHING', [username, await hashPassword(username), role]);
    }
    await client.query('INSERT INTO schema_migrations(version) VALUES($1) ON CONFLICT DO NOTHING',[SCHEMA_VERSION]);
    await client.query('COMMIT');
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
  console.log('migration complete');
} finally { await pool.end(); }
