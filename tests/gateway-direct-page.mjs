import assert from 'node:assert/strict';
import { chromium } from 'playwright';

const frontend = process.env.FRONTEND_URL || `http://127.0.0.1:${process.env.FRONTEND_PORT || 25173}`;
const gateway = process.env.GATEWAY_BROWSER_URL || new URL(frontend).origin.replace(/:\d+$/, `:${process.env.GATEWAY_PORT || 28081}`);
const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome', args: ['--no-sandbox'] });
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
const pageErrors = [];
const requests = [];
let createdGroupId;
let createdUserId;
page.on('pageerror', error => pageErrors.push(error.message));
page.on('request', request => requests.push({ url: request.url(), method: request.method() }));
try {
  await page.goto(`${frontend}/#message-service`);
  await page.getByLabel('用户名').fill('admin');
  await page.getByLabel('密码').fill('admin');
  await page.getByRole('button', { name: '登录工作区' }).click();
  await page.locator('.chat-v2-thread').first().waitFor();
  await page.getByText('SSE 已连接').waitFor();
  assert.equal(await page.locator('.chat-v2-intro h2').textContent(), 'Gateway 消息服务');
  assert.equal(await page.locator('.chat-v2-intro p').count(), 0, 'debug endpoint copy is not shown in the Gateway UI');
  assert.equal(await page.getByRole('button', { name: '账号状态' }).count(), 0, 'account status view is removed');

  await page.getByRole('button', { name: '会话' }).click();
  const createResponse = page.waitForResponse(response => response.url().startsWith(`${gateway}/users/`) && response.url().endsWith('/groups') && response.request().method() === 'POST');
  await page.getByRole('button', { name: '新建群' }).click();
  const groupId = (await (await createResponse).json()).groupId;
  createdGroupId = groupId;
  assert.match(groupId, /^gw-/);
  await page.getByRole('button', { name: '会话' }).click();
  await page.locator('.chat-v2-header small').getByText(groupId, { exact: false }).waitFor();

  const unique = `gateway-direct-${Date.now()}`;
  await page.getByLabel('Gateway 消息发送用户').selectOption('platform-1');
  await page.getByLabel('Gateway 消息内容').fill(unique);
  await page.locator('.chat-v2-composer').getByRole('button', { name: '发送', exact: true }).click();
  await page.getByText(unique, { exact: true }).waitFor();
  await page.getByRole('button', { name: '群管理' }).click();
  await page.getByRole('button', { name: '邀请', exact: true }).click();
  await page.waitForFunction(() => {
    const input = document.querySelector('input[aria-label="Gateway 邀请链接"]');
    return input instanceof HTMLInputElement && input.value.startsWith('invite-');
  });
  await page.getByLabel('Gateway 入群用户').selectOption('acc-2');
  await page.getByRole('button', { name: '直接提交入群' }).click();
  await page.locator('.gateway-member').getByText('acc-2 · platform-2').waitFor();
  await page.getByLabel('Gateway 目标成员').selectOption('acc-2');
  await page.getByRole('button', { name: '提升', exact: true }).click();
  await page.locator('.gateway-member').getByText('acc-2 · platform-2 · 管理员').waitFor();
  await page.getByRole('button', { name: '踢出', exact: true }).click();
  await page.locator('.gateway-member').getByText('acc-2 · platform-2 · 管理员').waitFor({ state: 'detached' });

  const external = `external-direct-${Date.now()}`;
  await page.getByRole('button', { name: '用户', exact: true }).click();
  await page.getByLabel('新用户名称').fill('Gateway 直接页测试用户');
  await page.getByLabel('新用户 ID').fill(external);
  const userResponse = page.waitForResponse(response => response.url() === `${gateway}/users` && response.request().method() === 'POST');
  await page.getByRole('button', { name: '添加用户' }).click();
  createdUserId = (await (await userResponse).json()).id;
  const externalCard = page.locator('.gateway-user-card').filter({ hasText: external });
  await externalCard.waitFor();
  await page.screenshot({ path: '/tmp/gateway-users-unified.png', fullPage: true });
  await externalCard.getByLabel('Gateway 直接页测试用户 要加入的群').selectOption(groupId);
  await externalCard.getByRole('button', { name: '加入群' }).click();
  await externalCard.getByText('已加入 1 个群').waitFor();
  await page.getByRole('button', { name: '会话' }).click();
  await page.locator('.chat-v2-thread').filter({ hasText: groupId.slice(3, 11) }).click();
  await page.getByLabel('Gateway 消息发送用户').selectOption(external);
  await page.getByLabel('Gateway 消息内容').fill(`来自 ${external}`);
  await page.locator('.chat-v2-composer').getByRole('button', { name: '发送' }).click();
  await page.getByText(`来自 ${external}`, { exact: true }).waitFor();

  const gatewayMessages = await (await fetch(`${gateway}/groups/${groupId}/messages`)).json();
  assert(gatewayMessages.some(message => message.text === unique && message.clientMsgId));
  assert(gatewayMessages.some(message => message.text === `来自 ${external}` && !message.clientMsgId));
  assert(requests.some(request => request.url.startsWith(gateway) && request.url.includes('/events?since=')));
  assert(requests.some(request => request.url === `${gateway}/users`));
  assert.equal(requests.filter(request => request.url.startsWith(`${gateway}/accounts`) || request.url.startsWith(`${gateway}/external-accounts`)).length, 0, 'Gateway page only uses the unified user resource');
  const platformRequests = requests.filter(request => request.url.startsWith(frontend) && new URL(request.url).pathname.startsWith('/api/'));
  assert.deepEqual(platformRequests.map(request => new URL(request.url).pathname), ['/api/auth/login']);
  assert.deepEqual(pageErrors, []);
  await page.screenshot({ path: '/tmp/gateway-direct-e2e.png', fullPage: true });
  console.log(JSON.stringify({ ok: true, groupId, gatewayRequests: requests.filter(request => request.url.startsWith(gateway)).length, platformRequests: platformRequests.length, screenshots: ['/tmp/gateway-users-unified.png', '/tmp/gateway-direct-e2e.png'] }));
} finally {
  await browser.close();
  if (createdGroupId) await fetch(`${gateway}/admin/groups/${encodeURIComponent(createdGroupId)}`, { method: 'DELETE' }).catch(() => {});
  if (createdUserId) await fetch(`${gateway}/users/${encodeURIComponent(createdUserId)}`, { method: 'DELETE' }).catch(() => {});
}
