import { spawn, spawnSync } from 'node:child_process';
import { strict as assert } from 'node:assert';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const schema = `sentinel_migration_${randomUUID().replaceAll('-', '')}`;
const admin = new URL(process.env.DATABASE_URL || 'postgresql://sentinel:sentinel@127.0.0.1:5432/sentinel');
const isolated = new URL(admin);
isolated.searchParams.set('options', `-csearch_path=${schema}`);
const env = { ...process.env, DATABASE_URL: isolated.toString(), PORT: '4499' };
function sql(connection, statement) {
  const result = spawnSync('psql', [connection.toString(), '-v', 'ON_ERROR_STOP=1', '-c', statement], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout;
}
function migrate() {
  const result = spawnSync(process.execPath, [path.join(root, 'backend/node_modules/tsx/dist/cli.mjs'), path.join(root, 'backend/src/infrastructure/db/migrate.ts')], { env, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || result.stdout);
}
try {
  sql(admin, `CREATE SCHEMA ${schema}`);
  migrate();
  migrate();
  assert.match(sql(isolated, 'SELECT count(*) FROM accounts'), /\b5\b/, 'repeat migration does not duplicate seeded accounts');
  assert.match(sql(isolated, "SELECT version FROM schema_migrations WHERE version='1.7.0'"), /1\.7\.0/);
  sql(isolated, "DELETE FROM schema_migrations WHERE version='1.7.0'");
  const child = spawn(process.execPath, [path.join(root, 'backend/dist/index.js')], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.on('data', chunk => { output += chunk; });
  const exitCode = await Promise.race([
    new Promise(resolve => child.once('exit', resolve)),
    new Promise((_, reject) => setTimeout(() => reject(new Error('backend accepted an outdated schema')), 5000)),
  ]).finally(() => { if (child.exitCode === null) child.kill('SIGKILL'); });
  assert.notEqual(exitCode, 0);
  assert.match(output, /schema is behind code/);
  console.log('Migration cases passed: repeatable migrations, seed idempotence, outdated schema startup refusal.');
} finally {
  sql(admin, `DROP SCHEMA IF EXISTS ${schema} CASCADE`);
}
