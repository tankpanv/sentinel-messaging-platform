import { spawn, spawnSync } from 'node:child_process';
import { strict as assert } from 'node:assert';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from 'playwright';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const schema = `sentinel_e2e_${randomUUID().replaceAll('-', '')}`;
const db = new URL(process.env.DATABASE_URL || 'postgresql://sentinel:sentinel@127.0.0.1:5432/sentinel');
const testDb = new URL(db); testDb.searchParams.set('options', `-csearch_path=${schema}`);
const files = { gateway: `/tmp/${schema}_gateway.json`, agent: `/tmp/${schema}_agent.json`, media: `/tmp/${schema}_media` };
const ports = { backend: 4410, gateway: 4411, agent: 4412, frontend: 4413 };
const children = [];
function sql(statement) {
  const result = spawnSync('psql', [db.toString(), '-v', 'ON_ERROR_STOP=1', '-c', statement], { encoding: 'utf8' });
  if (result.status) throw Error(result.stderr || result.stdout);
}
function launch(service, port, extra = {}) {
  const isFrontend = service === 'frontend';
  const command = isFrontend ? path.join(root, 'frontend', 'node_modules', 'vite', 'bin', 'vite.js') : path.join(root, service, 'dist', 'index.js');
  const child = spawn(process.execPath, [command], { cwd: isFrontend ? path.join(root, 'frontend') : root, env: {
    ...process.env, PORT: String(port), FRONTEND_PORT: String(ports.frontend), DATABASE_URL: testDb.toString(),
    GATEWAY_URL: `http://127.0.0.1:${ports.gateway}`, AGENT_URL: `http://127.0.0.1:${ports.agent}`,
    VITE_BACKEND_URL: `http://127.0.0.1:${ports.backend}`, JWT_SECRET: 'e2e-local-secret',
    GATEWAY_STATE_FILE: files.gateway, AGENT_SESSION_FILE: files.agent, MEDIA_DIR: files.media, ...extra,
  }, stdio: ['ignore', 'pipe', 'pipe'] });
  children.push(child);
  child.stdout.on('data', chunk => { for (const line of String(chunk).split('\n')) if (line && !line.includes('"event":"http_request"')) process.stdout.write(`[${service}] ${line}\n`); });
  child.stderr.on('data', chunk => process.stderr.write(`[${service}] ${chunk}`));
}
async function ready(url) {
  for (let attempt = 0; attempt < 100; attempt++) {
    try { if ((await fetch(url)).ok) return; } catch { /* Starting. */ }
    await delay(100);
  }
  throw Error(`Service not ready: ${url}`);
}
let browser;
try {
  sql(`CREATE SCHEMA ${schema}`);
  const migration = spawnSync(process.execPath, [path.join(root, 'backend', 'node_modules', 'tsx', 'dist', 'cli.mjs'), path.join(root, 'backend', 'src', 'infrastructure', 'db', 'migrate.ts')], { env: { ...process.env, DATABASE_URL: testDb.toString() }, encoding: 'utf8' });
  assert.equal(migration.status, 0, migration.stderr);
  launch('gateway-service', ports.gateway); launch('agent-service', ports.agent);
  await Promise.all([ready(`http://127.0.0.1:${ports.gateway}/health`), ready(`http://127.0.0.1:${ports.agent}/health`)]);
  launch('backend', ports.backend); await ready(`http://127.0.0.1:${ports.backend}/api/health`);
  launch('frontend', ports.frontend); await ready(`http://127.0.0.1:${ports.frontend}`);
  browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || (fs.existsSync('/usr/bin/google-chrome') ? '/usr/bin/google-chrome' : undefined), args: ['--no-sandbox'] });
  const page = await browser.newPage();
  page.setDefaultTimeout(15000);
  await page.goto(`http://127.0.0.1:${ports.frontend}`);
  await page.getByLabel('用户名').fill('admin'); await page.getByLabel('密码').fill('admin');
  await page.getByRole('button', { name: '登录' }).click();
  await page.getByRole('heading', { name: '消息控制台' }).waitFor();
  for (const id of ['acc-1', 'acc-2', 'acc-3']) {
    const card = page.locator('article').filter({ hasText: id }).first();
    await card.getByRole('button', { name: '连接' }).click();
    await card.getByText('online').waitFor();
  }
  await page.getByLabel('群主').selectOption('acc-1');
  await page.getByRole('checkbox', { name: 'acc-2' }).check();
  await page.getByRole('checkbox', { name: 'acc-3' }).check();
  await page.getByRole('button', { name: '创建', exact: true }).click();
  await page.locator('.group-row').first().waitFor();
  await page.locator('.group-row').first().click();
  await page.getByRole('heading', { name: /群详情/ }).waitFor();
  await page.getByText('acc-2 · admin').waitFor();
  await page.getByRole('button', { name: '切换 Agent' }).click();
  await page.getByText('Agent：开启').waitFor();
  const groups = await page.evaluate(async () => { const token = JSON.parse(localStorage.getItem('sentinel.auth') || '{}').token; return fetch('/api/groups', { headers: { authorization: `Bearer ${token}` } }).then(response => response.json()); });
  const group = groups.find(item => item.agentEnabled);
  assert(group, 'agent-enabled group appears in UI');
  const posted = await fetch(`http://127.0.0.1:${ports.gateway}/groups/${group.gatewayGroupId}/external-message`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ senderPlatformUserId: 'outside-e2e', text: 'hello e2e' }) });
  assert(posted.ok);
  await page.getByText('hello e2e').waitFor();
  await page.locator('.run-title').filter({ hasText: 'finished' }).first().waitFor();
  await page.locator('.run-title').first().click();
  await page.getByText('get_recent_messages').waitFor();
  const viewer = await browser.newPage();
  await viewer.goto(`http://127.0.0.1:${ports.frontend}`);
  await viewer.getByLabel('用户名').fill('viewer'); await viewer.getByLabel('密码').fill('viewer');
  await viewer.getByRole('button', { name: '登录' }).click();
  await viewer.getByRole('heading', { name: '消息控制台' }).waitFor();
  assert.equal(await viewer.getByRole('button', { name: '创建', exact: true }).count(), 0);
  console.log('Playwright E2E passed: admin login, account connection, group creation, agent steps, viewer permissions.');
} finally {
  if (browser) await browser.close();
  for (const child of children) child.kill('SIGKILL');
  await Promise.all(children.map(child => child.exitCode === null && child.signalCode === null ? new Promise(resolve => child.once('exit', resolve)) : Promise.resolve()));
  sql(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
  for (const filename of [files.gateway, files.agent]) { try { fs.unlinkSync(filename); } catch { /* Not written. */ } }
  fs.rmSync(files.media, { recursive: true, force: true });
}
