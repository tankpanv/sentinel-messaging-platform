import { spawn, spawnSync } from 'node:child_process';
import { strict as assert } from 'node:assert';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { test, expect } from 'playwright/test';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const schema = `sentinel_c3_${randomUUID().replaceAll('-', '')}`;
const database = new URL(process.env.DATABASE_URL || 'postgresql://sentinel:sentinel@127.0.0.1:5432/sentinel');
const isolatedDatabase = new URL(database);
isolatedDatabase.searchParams.set('options', `-csearch_path=${schema}`);
const ports = {
  backend: Number(process.env.C3_BACKEND_PORT || 4510),
  gateway: Number(process.env.C3_GATEWAY_PORT || 4511),
  agent: Number(process.env.C3_AGENT_PORT || 4512),
  frontend: Number(process.env.C3_FRONTEND_PORT || 4513),
};
const state = {
  gateway: `/tmp/${schema}_gateway.json`,
  agent: `/tmp/${schema}_agent.json`,
  media: `/tmp/${schema}_media`,
};
const children = [];
let seeded;

function databaseCommand(connection, statement) {
  const result = spawnSync('psql', [connection.toString(), '-v', 'ON_ERROR_STOP=1', '-c', statement], { encoding: 'utf8' });
  if (result.status) throw new Error(result.stderr || result.stdout);
}

function launch(service, port, extraEnvironment = {}) {
  const frontend = service === 'frontend';
  const command = frontend
    ? path.join(root, 'frontend/node_modules/vite/bin/vite.js')
    : path.join(root, service, 'dist/index.js');
  const child = spawn(process.execPath, [command], {
    cwd: frontend ? path.join(root, 'frontend') : root,
    env: {
      ...process.env,
      PORT: String(port),
      FRONTEND_PORT: String(ports.frontend),
      DATABASE_URL: isolatedDatabase.toString(),
      GATEWAY_URL: `http://127.0.0.1:${ports.gateway}`,
      AGENT_URL: `http://127.0.0.1:${ports.agent}`,
      VITE_BACKEND_URL: `http://127.0.0.1:${ports.backend}`,
      VITE_GATEWAY_PORT: String(ports.gateway),
      JWT_SECRET: 'c3-e2e-secret',
      GATEWAY_STATE_FILE: state.gateway,
      AGENT_SESSION_FILE: state.agent,
      MEDIA_DIR: state.media,
      ENABLE_GATEWAY_SIMULATION: 'true',
      ...extraEnvironment,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.push(child);
  child.stdout.on('data', chunk => {
    for (const line of String(chunk).split('\n')) {
      if (line && !line.includes('"event":"http_request"')) process.stdout.write(`[c3:${service}] ${line}\n`);
    }
  });
  child.stderr.on('data', chunk => process.stderr.write(`[c3:${service}] ${chunk}`));
}

async function waitFor(task, predicate, description, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  let lastValue;
  while (Date.now() < deadline) {
    try {
      lastValue = await task();
      if (predicate(lastValue)) return lastValue;
    } catch (error) {
      lastValue = error;
    }
    await delay(150);
  }
  throw new Error(`等待超时：${description}；最后结果：${String(lastValue)}`);
}

async function ready(url) {
  await waitFor(
    async () => fetch(url),
    response => response.ok,
    `${url} 就绪`,
  );
}

async function api(pathname, { token, method = 'GET', body } = {}) {
  const response = await fetch(`http://127.0.0.1:${ports.backend}${pathname}`, {
    method,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`${method} ${pathname} -> ${response.status}: ${JSON.stringify(data)}`);
  return data;
}

async function seedAgentRun() {
  const login = await api('/api/auth/login', { method: 'POST', body: { username: 'admin', password: 'admin' } });
  const token = login.accessToken;
  await api('/api/accounts/acc-1/connect', { token, method: 'POST' });
  await api('/api/accounts/acc-2/connect', { token, method: 'POST' });
  const created = await api('/api/groups', {
    token,
    method: 'POST',
    body: { creatorAccountId: 'acc-1', memberAccountIds: ['acc-2'] },
  });
  await waitFor(
    () => api(`/api/jobs/${created.jobId}`, { token }),
    job => job.status === 'finished',
    '模拟 Gateway 完成建群作业',
  );
  const groups = await api('/api/groups', { token });
  const group = groups.find(item => item.creatorAccountId === 'acc-1');
  assert(group, 'C3 fixture group was not created');
  await api(`/api/groups/${group.id}`, { token, method: 'PATCH', body: { agentEnabled: true } });
  await api(`/api/groups/${group.id}/agent-simulation/messages`, {
    token,
    method: 'POST',
    body: { senderPlatformUserId: 'external-c3-browser', text: 'C3 browser agent run' },
  });
  const runs = await waitFor(
    () => api(`/api/groups/${group.id}/agent-runs`, { token }),
    items => items.some(item => item.status === 'finished' && item.steps?.length > 0),
    'mock Agent run 完成并写入步骤',
  );
  return { group, run: runs.find(item => item.status === 'finished' && item.steps?.length > 0) };
}

test.beforeAll(async () => {
  databaseCommand(database, `CREATE SCHEMA ${schema}`);
  const migration = spawnSync(
    process.execPath,
    [path.join(root, 'backend/node_modules/tsx/dist/cli.mjs'), path.join(root, 'backend/src/infrastructure/db/migrate.ts')],
    { env: { ...process.env, DATABASE_URL: isolatedDatabase.toString() }, encoding: 'utf8' },
  );
  assert.equal(migration.status, 0, migration.stderr || migration.stdout);
  launch('gateway-service', ports.gateway);
  launch('agent-service', ports.agent, { AGENT_PROVIDER: 'mock' });
  await Promise.all([
    ready(`http://127.0.0.1:${ports.gateway}/health`),
    ready(`http://127.0.0.1:${ports.agent}/health`),
  ]);
  launch('backend', ports.backend);
  await ready(`http://127.0.0.1:${ports.backend}/api/health`);
  launch('frontend', ports.frontend);
  await ready(`http://127.0.0.1:${ports.frontend}`);
  seeded = await seedAgentRun();
});

test.afterAll(async () => {
  for (const child of children) child.kill('SIGKILL');
  await Promise.all(children.map(child => child.exitCode === null && child.signalCode === null
    ? new Promise(resolve => child.once('exit', resolve))
    : Promise.resolve()));
  databaseCommand(database, `DROP SCHEMA IF EXISTS ${schema} CASCADE`);
  for (const filename of [state.gateway, state.agent]) {
    try { fs.unlinkSync(filename); } catch { /* State file was not created. */ }
  }
  fs.rmSync(state.media, { recursive: true, force: true });
});

test('C3 登录后打开群组并查看 Agent Run 步骤', async ({ page }, testInfo) => {
  testInfo.annotations.push(
    { type: 'environment', description: `Backend http://127.0.0.1:${ports.backend}; repository Gateway simulator http://127.0.0.1:${ports.gateway}` },
    { type: 'agent-provider', description: 'mock' },
    { type: 'message-source', description: '模拟外部用户 external-c3-browser，经 Backend 测试端点注入模拟 Gateway' },
    { type: 'not-covered', description: '未验证真实外部消息平台用户、真实 Gateway 或真实 LLM' },
  );

  await test.step('登录控制台', async () => {
    await page.goto('/');
    await page.getByLabel('用户名').fill('admin');
    await page.getByLabel('密码').fill('admin');
    await page.getByRole('button', { name: /登录工作区/ }).click();
    await expect(page.getByRole('heading', { name: '运营概览' })).toBeVisible();
  });

  const card = page.locator('.group-card').filter({ hasText: seeded.group.gatewayGroupId });
  await test.step('打开目标群组', async () => {
    await page.getByRole('link', { name: '群组与消息' }).click();
    await expect(page.getByRole('heading', { name: '群组与消息' })).toBeVisible();
    await expect(card).toHaveCount(1);
    await card.getByRole('button', { name: '展开详情' }).click();
    await expect(card.getByText('Agent 已启用', { exact: true })).toBeVisible();
    await card.getByRole('button', { name: '刷新运行' }).click();
  });

  await test.step('查看 Agent Run 步骤和结果', async () => {
    const run = card.locator('.group-agent-runs .run').filter({ hasText: seeded.run.id.slice(0, 8) });
    await expect(run.getByRole('button', { name: new RegExp(`${seeded.run.id.slice(0, 8)}.*finished`) })).toBeVisible();
    const detail = run.locator('.steps');
    await expect(detail).toBeVisible();
    await expect(detail.locator('.trace-id')).toContainText(seeded.run.traceId);
    await expect(detail.locator('article')).toHaveCount(seeded.run.steps.length);
    for (const [index, step] of seeded.run.steps.entries()) {
      const article = detail.locator('article').nth(index);
      await expect(article.getByText(`步骤 ${index + 1}`, { exact: true })).toBeVisible();
      await expect(article.getByText(`kind：${step.kind}`, { exact: true })).toBeVisible();
      await expect(article.getByText(`工具名：${step.name || '—'}`, { exact: true })).toBeVisible();
      await expect(article.getByText('结果摘要：', { exact: false })).toBeVisible();
      await expect(article.getByText('审计结论：', { exact: false })).toBeVisible();
      await expect(article.getByText('错误码：', { exact: false })).toBeVisible();
    }
  });

  const screenshot = testInfo.outputPath('c3-agent-run-steps.png');
  await page.screenshot({ path: screenshot, fullPage: true });
  await testInfo.attach('C3 Agent Run 步骤页面', { path: screenshot, contentType: 'image/png' });
});
