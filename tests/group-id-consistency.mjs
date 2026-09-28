import assert from 'node:assert/strict';
import { chromium } from 'playwright';

const frontend = process.env.FRONTEND_URL || 'http://127.0.0.1:25173';
const gatewayOrigin = process.env.GATEWAY_BROWSER_URL || new URL(frontend).origin.replace(/:\d+$/, `:${process.env.GATEWAY_PORT || 28081}`);
const gatewayGroups = await (await fetch(`${gatewayOrigin}/groups`)).json();
const existing = new Set(gatewayGroups.map(group => group.id));
const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome', args: ['--no-sandbox'] });
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
try {
  await page.goto(`${frontend}/#groups`);
  await page.getByLabel('用户名').fill('admin');
  await page.getByLabel('密码').fill('admin');
  await page.getByRole('button', { name: '登录工作区' }).click();
  await page.locator('.group-card').first().waitFor();
  const workspace = await page.locator('.group-card').evaluateAll(cards => cards.map(card => ({
    title: card.querySelector('.group-card-title h3')?.textContent?.trim() || '',
    gatewayId: card.querySelector('.group-card-title small')?.textContent?.trim() || '',
  })));
  const mapped = workspace.filter(item => existing.has(item.gatewayId));
  assert(mapped.length > 0, 'expected at least one platform group that exists in Gateway');
  for (const item of mapped) assert.equal(item.title, `群组 ${item.gatewayId.replace(/^gw-/, '').slice(0, 8)}`);
  await page.getByRole('link', { name: 'Gateway 消息服务' }).first().click();
  await page.locator('.chat-v2-thread').first().waitFor();
  const gatewayTitles = await page.locator('.chat-v2-thread strong').allTextContents();
  for (const item of mapped) assert(gatewayTitles.includes(item.title), `${item.title} should be identical on both pages`);
  await page.screenshot({ path: '/tmp/group-id-consistency.png', fullPage: true });
  console.log(JSON.stringify({ ok: true, compared: mapped.length, titles: mapped.map(item => item.title), screenshot: '/tmp/group-id-consistency.png' }));
} finally { await browser.close(); }
