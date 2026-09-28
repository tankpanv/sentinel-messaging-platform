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
function testSql(statement) {
  const result = spawnSync('psql', [testDb.toString(), '-v', 'ON_ERROR_STOP=1', '-c', statement], { encoding: 'utf8' });
  if (result.status) throw Error(result.stderr || result.stdout);
}
function launch(service, port, extra = {}) {
  const isFrontend = service === 'frontend';
  const command = isFrontend ? path.join(root, 'frontend', 'node_modules', 'vite', 'bin', 'vite.js') : path.join(root, service, 'dist', 'index.js');
  const child = spawn(process.execPath, [command], { cwd: isFrontend ? path.join(root, 'frontend') : root, env: {
    ...process.env, PORT: String(port), FRONTEND_PORT: String(ports.frontend), DATABASE_URL: testDb.toString(),
    GATEWAY_URL: `http://127.0.0.1:${ports.gateway}`, AGENT_URL: `http://127.0.0.1:${ports.agent}`,
    VITE_BACKEND_URL: `http://127.0.0.1:${ports.backend}`, VITE_GATEWAY_PORT: String(ports.gateway), JWT_SECRET: 'e2e-local-secret',
    GATEWAY_STATE_FILE: files.gateway, AGENT_SESSION_FILE: files.agent, MEDIA_DIR: files.media, ENABLE_GATEWAY_SIMULATION: 'true', ...extra,
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
async function until(task, matches, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await task();
    if (matches(value)) return value;
    await delay(150);
  }
  throw Error('Timed out waiting for expected browser state');
}
let browser;
try {
  sql(`CREATE SCHEMA ${schema}`);
  const migration = spawnSync(process.execPath, [path.join(root, 'backend', 'node_modules', 'tsx', 'dist', 'cli.mjs'), path.join(root, 'backend', 'src', 'infrastructure', 'db', 'migrate.ts')], { env: { ...process.env, DATABASE_URL: testDb.toString() }, encoding: 'utf8' });
  assert.equal(migration.status, 0, migration.stderr);
  launch('gateway-service', ports.gateway); launch('agent-service', ports.agent, { AGENT_PROVIDER: 'mock' });
  await Promise.all([ready(`http://127.0.0.1:${ports.gateway}/health`), ready(`http://127.0.0.1:${ports.agent}/health`)]);
  launch('backend', ports.backend); await ready(`http://127.0.0.1:${ports.backend}/api/health`);
  launch('frontend', ports.frontend); await ready(`http://127.0.0.1:${ports.frontend}`);
  browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || (fs.existsSync('/usr/bin/google-chrome') ? '/usr/bin/google-chrome' : undefined), args: ['--no-sandbox'] });
  const page = await browser.newPage();
  page.setDefaultTimeout(15000);
  await page.addInitScript(() => {
    const NativeWebSocket = window.WebSocket;
    window.__testSockets = [];
    window.WebSocket = new Proxy(NativeWebSocket, { construct(target, args) { const socket = Reflect.construct(target, args); window.__testSockets.push(socket); return socket; } });
  });
  const browserOrigin = `http://127.0.0.1:${ports.frontend}`;
  const crossOriginRequests = [];
  page.on('request', request => {
    const url = new URL(request.url());
    if (['http:', 'https:', 'ws:', 'wss:'].includes(url.protocol) && url.host !== new URL(browserOrigin).host) crossOriginRequests.push(request.url());
  });
  await page.goto(`http://127.0.0.1:${ports.frontend}`);
  await page.getByLabel('用户名').fill('admin'); await page.getByLabel('密码').fill('admin');
  await page.getByRole('button', { name: /登录工作区/ }).click();
  await page.getByRole('heading', { name: '运营概览' }).waitFor();
  await page.getByRole('link', { name: '账号管理' }).click();
  await page.getByRole('heading', { name: '账号管理' }).waitFor();
  for (const id of ['acc-1', 'acc-2', 'acc-3']) {
    const card = page.locator('article').filter({ hasText: id }).first();
    await card.getByRole('button', { name: '连接' }).click();
    await card.getByText('online').waitFor();
  }
  await page.getByRole('link', { name: '创建群组' }).click();
  await page.locator('h1').filter({ hasText: '创建群组' }).waitFor();
  await page.getByLabel('群主').selectOption('acc-1');
  await page.getByRole('checkbox', { name: 'acc-2' }).check();
  await page.getByRole('checkbox', { name: 'acc-3' }).check();
  await page.getByRole('button', { name: '创建群组' }).click();
  await page.locator('.group-card').first().waitFor();
  await page.getByRole('heading', { name: '群组工作台' }).waitFor();
  const groups = await page.evaluate(async () => { const token = JSON.parse(localStorage.getItem('sentinel.auth') || '{}').token; return fetch('/api/groups', { headers: { authorization: `Bearer ${token}` } }).then(response => response.json()); });
  const created = groups[0];
  await page.getByRole('link', { name: '账号管理' }).click();
  await page.locator('article').filter({ hasText: 'acc-4' }).first().getByRole('button', { name: '连接' }).click();
  await page.getByRole('link', { name: '群组与消息' }).click();
  const groupCard = page.locator('.group-card').filter({ hasText: created.id.slice(0, 8) }).first();
  await groupCard.getByRole('button', { name: '展开详情' }).click();
  await groupCard.locator('.group-join-panel select').selectOption('acc-4');
  await groupCard.getByRole('button', { name: '提交入群申请' }).click();
  const requestRow = groupCard.locator('.group-approval-row').filter({ hasText: 'acc-4' }).first();
  await requestRow.getByText('待审批').waitFor();
  await requestRow.getByRole('button', { name: '同意' }).click();
  await requestRow.waitFor({ state: 'detached' });
  await groupCard.locator('.group-detail-members > div').filter({ hasText: 'acc-4' }).waitFor();
  await page.screenshot({ path: '/tmp/group-approval-e2e.png' });
  const fourthMember = groupCard.locator('.group-detail-members > div').filter({ hasText: 'acc-4' });
  await fourthMember.getByRole('button', { name: '设为管理员' }).click();
  await fourthMember.getByText('admin · online').waitFor();
  await groupCard.getByRole('button', { name: '生成邀请链接' }).click();
  await groupCard.locator('.group-invite-result').getByText('邀请链接已生成').waitFor();
  await groupCard.getByRole('button', { name: '开启 Agent' }).click();
  await groupCard.getByRole('button', { name: '关闭 Agent' }).waitFor();
  await groupCard.getByRole('button', { name: '开启自动移除' }).click();
  await groupCard.getByRole('button', { name: '关闭自动移除' }).waitFor();
  page.once('dialog', dialog => void dialog.accept());
  await fourthMember.getByRole('button', { name: '移出' }).click();
  await fourthMember.waitFor({ state: 'detached' });
  await page.getByRole('link', { name: '账号管理' }).click();
  const accountCard = page.locator('article').filter({ hasText: 'acc-4' }).first();
  await accountCard.getByLabel('acc-4 申请群组').selectOption(created.id);
  await accountCard.getByRole('button', { name: '提交入群申请' }).click();
  await accountCard.getByRole('button', { name: /申请 .*待审批/ }).click();
  await groupCard.getByRole('button', { name: '展开详情' }).waitFor({ state: 'hidden' });
  const accountRequest = groupCard.locator('.group-approval-row').filter({ hasText: 'acc-4' }).first();
  await accountRequest.getByText('待审批').waitFor();
  await accountRequest.getByRole('button', { name: '拒绝' }).click();
  await accountRequest.waitFor({ state: 'detached' });
  assert.equal(await groupCard.locator('.group-approval-row').count(), 0, 'rejected requests are not shown in the active approval list');
  await groupCard.locator('.group-join-panel select').selectOption('acc-4');
  await groupCard.getByRole('button', { name: '提交入群申请' }).click();
  const nextRequest = groupCard.locator('.group-approval-row').filter({ hasText: 'acc-4' }).first();
  await nextRequest.getByRole('button', { name: '同意' }).click();
  await nextRequest.waitFor({ state: 'detached' });
  await groupCard.locator('.group-detail-members > div').filter({ hasText: 'acc-4' }).waitFor();
  const rejoinedMember = groupCard.locator('.group-detail-members > div').filter({ hasText: 'acc-4' });
  page.once('dialog', dialog => void dialog.accept());
  await rejoinedMember.getByRole('button', { name: '自行退群' }).click();
  await rejoinedMember.waitFor({ state: 'detached' });
  const token = await page.evaluate(() => JSON.parse(localStorage.getItem('sentinel.auth') || '{}').token);
  const refreshedGroups = await page.evaluate(async () => { const token = JSON.parse(localStorage.getItem('sentinel.auth') || '{}').token; return fetch('/api/groups', { headers: { authorization: `Bearer ${token}` } }).then(response => response.json()); });
  const group = refreshedGroups.find(item => item.agentEnabled);
  assert(group, 'agent-enabled group appears in UI');
  await page.getByRole('link', { name: 'Gateway 消息服务' }).first().click();
  await page.locator('.chat-v2-thread').getByText(`群组 ${group.id.slice(0, 8)}`).waitFor();
  await page.locator('.chat-v2-thread').filter({ hasText: group.id.slice(0, 8) }).click();
  await page.getByText('SSE 已连接').waitFor();
  await page.getByRole('button', { name: '用户', exact: true }).click();
  await page.getByLabel('新用户名称').fill('E2E 用户');
  await page.getByLabel('新用户 ID').fill('external-e2e');
  await page.getByRole('button', { name: '添加用户' }).click();
  const e2eExternal = page.locator('.gateway-external-card').filter({ hasText: 'external-e2e' });
  await e2eExternal.waitFor();
  await e2eExternal.getByLabel('E2E 外部账号 要加入的群').selectOption(group.gatewayGroupId);
  await e2eExternal.getByRole('button', { name: '加入群' }).click();
  await e2eExternal.getByText('已加入 1 个群').waitFor();
  await page.getByRole('button', { name: '会话' }).click();
  await page.locator('.chat-v2-thread').filter({ hasText: group.id.slice(0, 8) }).click();
  await page.getByLabel('Gateway 消息发送用户').selectOption('external-e2e');
  await page.getByLabel('Gateway 消息内容').fill('hello e2e');
  await page.locator('.chat-v2-composer').getByRole('button', { name: '发送' }).click();
  await page.getByText('hello e2e', { exact: true }).waitFor();
  assert(crossOriginRequests.some(url => new URL(url).port === String(ports.gateway)), 'Gateway debug page connects directly to Gateway');
  await page.screenshot({ path: '/tmp/gateway-message-service-e2e.png', fullPage: true });
  const runs = await until(async () => page.evaluate(async ({ id, token }) => fetch(`/api/groups/${id}/agent-runs`, { headers: { authorization: `Bearer ${token}` } }).then(response => response.json()), { id: group.id, token }), value => value.some(run => run.status === 'finished'));
  assert(runs.length > 0, 'simulated Gateway user message triggered platform Agent');
  await page.getByLabel('Gateway 消息发送用户').selectOption('platform-1');
  await page.getByLabel('Gateway 消息内容').fill('service account own message e2e');
  await page.locator('.chat-v2-composer').getByRole('button', { name: '发送' }).click();
  await page.getByText('service account own message e2e', { exact: true }).waitFor();
  await delay(500);
  const runsAfterOwnMessage = await page.evaluate(async ({ id, token }) => fetch(`/api/groups/${id}/agent-runs`, { headers: { authorization: `Bearer ${token}` } }).then(response => response.json()), { id: group.id, token });
  assert.equal(runsAfterOwnMessage.length, runs.length, 'service account message does not trigger another Agent run');
  await page.getByRole('button', { name: '用户', exact: true }).click();
  const externalCrudId = `external-crud-e2e-${Date.now()}`;
  await page.getByLabel('新用户名称').fill('E2E 外部账号');
  await page.getByLabel('新用户 ID').fill(externalCrudId);
  await page.getByRole('button', { name: '添加用户' }).click();
  const externalCard = page.locator('.gateway-external-card').filter({ hasText: externalCrudId });
  await externalCard.waitFor();
  await externalCard.getByRole('button', { name: '详情' }).click();
  await externalCard.getByText(/账号 ID：ext-/).waitFor();
  await externalCard.getByRole('button', { name: '编辑' }).click();
  await externalCard.getByLabel('E2E 外部账号 新名称').fill('E2E 外部账号（已更新）');
  await externalCard.getByRole('button', { name: '保存' }).click();
  await externalCard.getByText('E2E 外部账号（已更新）').waitFor();
  await externalCard.getByLabel('E2E 外部账号（已更新） 要加入的群').selectOption(group.gatewayGroupId);
  await externalCard.getByRole('button', { name: '加入群' }).click();
  await externalCard.getByText(`已加入 1 个群`).waitFor();
  await externalCard.getByRole('button', { name: '退群' }).click();
  await externalCard.getByText('尚未入群').waitFor();
  page.once('dialog', dialog => void dialog.accept());
  await externalCard.getByRole('button', { name: '删除' }).click();
  await externalCard.waitFor({ state: 'detached' });
  await page.getByRole('link', { name: '群组与消息' }).click();
  const agentGroupCard = page.locator('.group-card').filter({ hasText: group.id.slice(0, 8) }).first();
  const groupDetailsToggle = agentGroupCard.locator('.group-card-footer').getByRole('button', { name: /展开详情|收起详情/ });
  if ((await groupDetailsToggle.innerText()) === '展开详情') await groupDetailsToggle.click();
  await agentGroupCard.getByRole('button', { name: '刷新运行' }).click();
  await agentGroupCard.locator('.group-agent-runs .run-title').first().waitFor();
  if (!(await agentGroupCard.locator('.group-agent-runs .trace-id').first().count())) await agentGroupCard.locator('.group-agent-runs .run-title').first().click();
  await agentGroupCard.locator('.group-agent-runs .steps').getByText(/kind：/).first().waitFor();
  await agentGroupCard.locator('.group-agent-runs .steps').getByText(/工具名：/).first().waitFor();
  await agentGroupCard.locator('.group-agent-runs .steps').getByText(/结果摘要：/).first().waitFor();
  await page.screenshot({ path: '/tmp/group-agent-runs-e2e.png', fullPage: true });
  await page.getByRole('link', { name: '自动化序列' }).click();
  await page.getByRole('heading', { name: '序列模板' }).waitFor();
  await page.getByRole('button', { name: /创建序列模板/ }).click();
  await page.getByRole('heading', { name: '创建序列模板' }).waitFor();
  assert(page.url().includes('#sequence/create'), 'create page uses an explicit route');
  await page.getByRole('button', { name: '保存模板', exact: true }).click();
  await page.getByRole('status').filter({ hasText: '序列模板已创建' }).waitFor();
  assert(page.url().includes('#sequence/edit/'), 'saved template has an explicit edit route');
  await page.getByRole('button', { name: /返回模板列表/ }).click();
  await page.getByText('活动提醒').waitFor();
  await page.getByRole('button', { name: '编辑模板', exact: true }).click();
  await page.getByRole('heading', { name: '编辑序列模板' }).waitFor();
  await page.getByLabel('序列名称').fill('活动提醒（已编辑）');
  await page.getByRole('button', { name: '保存修改', exact: true }).first().click();
  await page.getByRole('status').filter({ hasText: '序列模板已更新' }).waitFor();
  const firstTemplateId = page.url().split('/').at(-1);
  await page.getByRole('button', { name: /返回模板列表/ }).click();
  await page.getByText('活动提醒（已编辑）').waitFor();
  await page.getByRole('button', { name: /创建序列模板/ }).click();
  await page.getByRole('heading', { name: '创建序列模板' }).waitFor();
  await page.getByLabel('序列名称').fill('结束提醒');
  await page.getByLabel('第 1 步默认发送成员 ID').fill('acc-1');
  await page.getByRole('button', { name: '保存模板', exact: true }).click();
  await page.getByRole('status').filter({ hasText: '序列模板已创建' }).waitFor();
  const secondTemplateId = page.url().split('/').at(-1);
  await page.getByRole('button', { name: /返回模板列表/ }).click();
  const secondTemplate = page.locator('.sequence-template-card').filter({ hasText: '结束提醒' });
  await secondTemplate.getByRole('button', { name: /运行序列/ }).click();
  await page.getByRole('heading', { name: '运行序列' }).waitFor();
  assert(page.url().includes('#sequence/run/'), 'run page contains the selected sequence id');
  assert.equal(page.url().split('/').at(-1), secondTemplateId, 'run route uses the clicked template id');
  assert.equal(await page.getByLabel('执行模板').locator('option:checked').textContent(), '结束提醒');
  await page.goto(`${browserOrigin}/#sequence/run/${firstTemplateId}`);
  await page.getByRole('heading', { name: /运行序列 · 活动提醒（已编辑）/ }).waitFor();
  assert.equal(await page.getByLabel('执行模板').inputValue(), firstTemplateId, 'a different run route loads a different template');
  await page.goto(`${browserOrigin}/#sequence/run/${secondTemplateId}`);
  await page.getByRole('heading', { name: /运行序列 · 结束提醒/ }).waitFor();
  assert.equal(await page.getByLabel('执行模板').inputValue(), secondTemplateId, 'navigating back restores the second template by id');
  await page.reload();
  await page.getByRole('heading', { name: /运行序列 · 结束提醒/ }).waitFor();
  assert.equal(await page.getByLabel('执行模板').locator('option:checked').textContent(), '结束提醒');
  await page.getByLabel('目标群组').waitFor();
  assert.equal(await page.locator('.sequence-run-plan-step').count(), 2, 'run page displays every template step before launch');
  assert.equal(await page.getByLabel('第 1 步指定发送成员 ID').inputValue(), 'acc-1', 'template default sender is visible in the run page');
  await page.getByLabel('第 1 步指定发送成员 ID').fill('acc-not-member');
  await page.getByRole('button', { name: '预检变量与消息', exact: true }).click();
  await page.getByText(/指定的账号 acc-not-member 不是当前群组成员/).waitFor();
  await page.getByLabel('第 1 步指定发送成员 ID').fill('acc-2');
  await page.getByRole('button', { name: '预检变量与消息', exact: true }).click();
  const previewDialog = page.getByRole('dialog', { name: '序列预检结果' });
  await previewDialog.getByText('发送账号：acc-2').waitFor();
  await previewDialog.getByText('event = 演示活动 · 来源：default').first().waitFor();
  await previewDialog.getByText('location = 共享盘 · 来源：default').first().waitFor();
  await previewDialog.getByRole('button', { name: '确认启动' }).click();
  await page.locator('.sequence-current-run .sequence-history-card').waitFor();
  assert.equal(await page.locator('.sequence-current-run .sequence-history-step').count(), 2, 'current run shows every step');
  await page.getByLabel('执行模板').selectOption(firstTemplateId);
  await page.locator('.sequence-active-warning').waitFor();
  assert.equal(await page.getByRole('button', { name: '启动序列', exact: true }).isDisabled(), true, 'group-wide active run disables another template');
  assert.equal(await page.getByRole('button', { name: '预检变量与消息' }).isDisabled(), true, 'precheck is disabled while the group has a running sequence');
  await page.getByLabel('执行模板').selectOption(secondTemplateId);
  await page.locator('.sequence-current-run .sequence-history-card').waitFor();
  await page.locator('.sequence-active-warning').waitFor({ state: 'detached', timeout: 20000 });
  await page.locator('.sequence-history .sequence-history-card').first().waitFor();
  assert.equal(await page.locator('.sequence-history .sequence-history-step-meta').first().getByText('实际账号：acc-2').count(), 1, 'chosen service account sent the selected step');
  assert.equal(await page.locator('.sequence-history .sequence-history-step-meta').nth(1).getByText('实际账号：acc-3').count(), 1, 'blank sender keeps member role selection');
  assert.equal(await page.locator('.sequence-history .sequence-history-step').first().getByText(/延迟：/).count(), 1, 'history shows step timing');
  await page.screenshot({ path: '/tmp/sequence-run-history-e2e.png', fullPage: true });
  await page.setViewportSize({ width: 1920, height: 1080 });
  const backButtonBounds = await page.getByRole('button', { name: /返回模板列表/ }).boundingBox();
  const monitorBounds = await page.locator('.sequence-run-monitor').boundingBox();
  const configurationBounds = await page.locator('.sequence-run-configuration').boundingBox();
  assert(backButtonBounds && backButtonBounds.width < 200, 'back button keeps a natural text width');
  assert(monitorBounds && configurationBounds && monitorBounds.x > configurationBounds.x, 'wide run page shows setup and monitoring side by side');
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: '/tmp/sequence-run-history-wide-e2e.png' });
  const seedHistory = spawnSync('psql', [testDb.toString(), '-v', 'ON_ERROR_STOP=1', '-c', `
    INSERT INTO sequence_runs(group_id,sequence_id,status,current_step_index,steps,vars,created_at)
    SELECT '${created.id}'::uuid,'${secondTemplateId}'::uuid,'finished',1,
      '[{"index":1,"status":"sent","text":"分页记录","accountRole":"admin","delaySeconds":0,"accountId":"acc-1","scheduledAt":null,"sentAt":"2026-09-27T00:00:00.000Z","clientMsgId":null,"resolvedVars":{},"varSources":{}}]'::jsonb,
      '{}'::jsonb, date_trunc('milliseconds', now())+n*interval '1 microsecond'
    FROM generate_series(1,9) AS n
  `], { encoding: 'utf8' });
  assert.equal(seedHistory.status, 0, seedHistory.stderr);
  await page.getByRole('button', { name: '刷新', exact: true }).last().click();
  await page.getByRole('button', { name: '加载更早运行' }).waitFor();
  assert.equal(await page.locator('.sequence-history .sequence-history-card').count(), 8, 'history first page is bounded');
  const firstPageIds = await page.locator('.sequence-history .sequence-history-card').evaluateAll(cards => cards.map(card => card.getAttribute('data-run-id')));
  await page.getByRole('button', { name: '加载更早运行' }).click();
  await page.waitForFunction(() => document.querySelectorAll('.sequence-history .sequence-history-card').length > 8);
  const allHistoryIds = await page.locator('.sequence-history .sequence-history-card').evaluateAll(cards => cards.map(card => card.getAttribute('data-run-id')));
  assert.equal(allHistoryIds.length, 10, 'all runs are reachable across the microsecond cursor boundary');
  assert.equal(new Set(allHistoryIds).size, allHistoryIds.length, 'history pagination has no duplicate runs');
  assert(firstPageIds.every(id => allHistoryIds.includes(id)), 'loading older runs preserves the first page');
  const viewer = await browser.newPage();
  await viewer.goto(`http://127.0.0.1:${ports.frontend}`);
  await viewer.getByLabel('用户名').fill('viewer'); await viewer.getByLabel('密码').fill('viewer');
  await viewer.getByRole('button', { name: /登录工作区/ }).click();
  await viewer.getByRole('heading', { name: '运营概览' }).waitFor();
  assert.equal(await viewer.getByRole('button', { name: '创建群组' }).count(), 0);
  await viewer.getByRole('link', { name: 'Gateway 消息服务' }).first().click();
  await viewer.locator('.chat-v2-thread').first().click();
  assert.equal(await viewer.getByRole('button', { name: '群管理' }).count(), 1);
  await viewer.getByRole('button', { name: '群管理' }).click();
  assert.equal(await viewer.getByRole('button', { name: '外部成员发消息' }).count(), 0, 'viewer sees no Gateway write controls');
  assert(crossOriginRequests.every(url => new URL(url).port === String(ports.gateway)), 'the only browser cross-origin service is Gateway');
  console.log('Playwright simulated-service E2E passed: platform lifecycle, direct simulator debug page, mock Agent steps in group details, sequence UI, viewer permissions. Real external gateway users and real LLM were not tested.');
} finally {
  if (browser) await browser.close();
  for (const child of children) child.kill('SIGKILL');
  await Promise.all(children.map(child => child.exitCode === null && child.signalCode === null ? new Promise(resolve => child.once('exit', resolve)) : Promise.resolve()));
  sql(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
  for (const filename of [files.gateway, files.agent]) { try { fs.unlinkSync(filename); } catch { /* Not written. */ } }
  fs.rmSync(files.media, { recursive: true, force: true });
}
