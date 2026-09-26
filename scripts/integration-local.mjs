import { spawn, spawnSync } from 'node:child_process';
import { strict as assert } from 'node:assert';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ports = { backend: 4310, gateway: 4311, agent: 4312 };
const processes = [];
const base = `http://127.0.0.1:${ports.backend}`;
const gateway = `http://127.0.0.1:${ports.gateway}`;
const schemaName = `sentinel_it_${randomUUID().replaceAll('-', '')}`;
const gatewayStateFile = `/tmp/${schemaName}_gateway.json`;
const agentSessionFile = `/tmp/${schemaName}_agent.json`;
const mediaDirectory = `/tmp/${schemaName}_media`;
const adminUrl = new URL(process.env.DATABASE_URL || 'postgresql://sentinel:sentinel@127.0.0.1:5432/sentinel');
const testUrl = new URL(adminUrl);
testUrl.searchParams.set('options', `-csearch_path=${schemaName}`);
function databaseCommand(sql) {
  const result = spawnSync('psql', [adminUrl.toString(), '-v', 'ON_ERROR_STOP=1', '-c', sql], { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(result.stderr || result.stdout);
}
let token = '';
function launch(service, port, extra = {}) {
  const child = spawn(process.execPath, [path.join(root, service, 'dist/index.js')], {
    cwd: root,
    env: { ...process.env, PORT: String(port), DATABASE_URL: testUrl.toString(), GATEWAY_URL: gateway, AGENT_URL: `http://127.0.0.1:${ports.agent}`, JWT_SECRET: 'integration-secret', MEDIA_DIR: mediaDirectory, ...extra },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  processes.push(child);
  child.stdout.on('data', chunk => { for (const line of String(chunk).split('\n')) if (line && !line.includes('"event":"http_request"')) process.stdout.write(`[${service}] ${line}\n`); });
  child.stderr.on('data', chunk => process.stderr.write(`[${service}] ${chunk}`));
  return child;
}
async function stop(child) { if (child.exitCode !== null || child.signalCode !== null) return; child.kill('SIGKILL'); await new Promise(resolve => child.once('exit', resolve)); }
async function waitFor(url) {
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(url)).ok) return; } catch { /* Service starting. */ }
    await delay(100);
  }
  throw new Error(`Service did not become ready: ${url}`);
}
async function request(pathname, method = 'GET', body, origin = base, options = {}) {
  const response = await fetch(`${origin}${pathname}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...(options.headers || {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const data = await response.json().catch(() => ({}));
  return { response, data };
}
async function expectOk(pathname, method = 'GET', body, origin = base) {
  const { response, data } = await request(pathname, method, body, origin);
  assert(response.ok, `${method} ${pathname}: ${response.status} ${JSON.stringify(data)}`);
  return data;
}
async function until(task, match, maxMs = 10000) {
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) { const value = await task(); if (match(value)) return value; await delay(150); }
  throw new Error('Timed out waiting for expected state');
}
async function websocketUntil(sinceSeq, match, maxMs = 3000) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`ws://127.0.0.1:${ports.backend}/ws`);
    const frames = [];
    const timer = setTimeout(() => { socket.close(); reject(new Error('WebSocket replay timed out')); }, maxMs);
    socket.onopen = () => socket.send(JSON.stringify({ type: 'auth', accessToken: token, sinceSeq }));
    socket.onmessage = event => {
      const frame = JSON.parse(event.data);
      if (frame.seq) frames.push(frame);
      if (match(frame)) { clearTimeout(timer); socket.close(); resolve(frames); }
    };
    socket.onerror = error => { clearTimeout(timer); reject(error); };
  });
}
try {
  databaseCommand(`CREATE SCHEMA ${schemaName}`);
  const migration = spawnSync(process.execPath, [path.join(root, 'backend', 'node_modules', 'tsx', 'dist', 'cli.mjs'), path.join(root, 'backend', 'src', 'infrastructure', 'db', 'migrate.ts')], { env: { ...process.env, DATABASE_URL: testUrl.toString() }, encoding: 'utf8' });
  assert.equal(migration.status, 0, migration.stderr);
  let gatewayProcess = launch('gateway-service', ports.gateway, { GATEWAY_STATE_FILE: gatewayStateFile, INVITE_READY_AFTER_MS: '500' });
  launch('agent-service', ports.agent, { AGENT_SESSION_FILE: agentSessionFile, ENABLE_FAULT_INJECTION: 'true', AGENT_TURN_DELAY_MS: '500' });
  await Promise.all([waitFor(`${gateway}/health`), waitFor(`http://127.0.0.1:${ports.agent}/health`)]);
  let backendProcess = launch('backend', ports.backend);
  await waitFor(`${base}/api/health`);

  const login = await expectOk('/api/auth/login', 'POST', { username: 'admin', password: 'admin' }); token = login.accessToken;
  const secondLogin = await request('/api/auth/login', 'POST', { username: 'admin', password: 'admin' });
  const oldCookie = secondLogin.response.headers.get('set-cookie')?.split(';')[0];
  assert(oldCookie);
  const rotated = await request('/api/auth/refresh', 'POST', undefined, base, { headers: { cookie: oldCookie } });
  assert.equal(rotated.response.status, 200);
  const replayed = await request('/api/auth/refresh', 'POST', undefined, base, { headers: { cookie: oldCookie } });
  assert.equal(replayed.response.status, 401);
  const revokedAccess = await request('/api/accounts', 'GET', undefined, base, { headers: { authorization: `Bearer ${rotated.data.accessToken}` } });
  assert.equal(revokedAccess.response.status, 401);
  const logoutLogin = await expectOk('/api/auth/login', 'POST', { username: 'viewer', password: 'viewer' });
  const loggedOut = await request('/api/auth/logout', 'POST', undefined, base, { headers: { authorization: `Bearer ${logoutLogin.accessToken}` } });
  assert.equal(loggedOut.response.status, 200);
  const afterLogout = await request('/api/accounts', 'GET', undefined, base, { headers: { authorization: `Bearer ${logoutLogin.accessToken}` } });
  assert.equal(afterLogout.response.status, 401);
  const viewer = await expectOk('/api/auth/login', 'POST', { username: 'viewer', password: 'viewer' });
  const { response: forbidden } = await request('/api/accounts/acc-1/connect', 'POST', undefined, base, { headers: { authorization: `Bearer ${viewer.accessToken}` } });
  assert.equal(forbidden.status, 403);
  for (const id of ['acc-1', 'acc-2', 'acc-3']) await expectOk(`/api/accounts/${id}/connect`, 'POST');

  const { jobId } = await expectOk('/api/groups', 'POST', { creatorAccountId: 'acc-1', memberAccountIds: ['acc-2', 'acc-3'] });
  await until(() => expectOk(`/api/jobs/${jobId}`), job => job.status === 'finished');
  const group = (await expectOk('/api/groups')).find(g => g.members?.some(m => m.accountId === 'acc-3') && g.status === 'active');
  assert(group, 'created group appears in list');
  const detail = await expectOk(`/api/groups/${group.id}`);
  assert.equal(detail.members.find(m => m.accountId === 'acc-2').role, 'admin');
  await expectOk('/api/accounts/acc-4/connect', 'POST');
  const interrupted = await expectOk('/api/groups', 'POST', { creatorAccountId: 'acc-1', memberAccountIds: ['acc-4'] });
  await delay(100);
  await stop(backendProcess);
  backendProcess = launch('backend', ports.backend);
  await waitFor(`${base}/api/health`);
  await until(() => expectOk(`/api/jobs/${interrupted.jobId}`), job => job.status === 'finished');

  const { clientMsgId } = await expectOk(`/api/groups/${group.id}/send`, 'POST', { accountId: 'acc-2', text: 'outbound integration message' });
  const sent = await until(() => expectOk(`/api/groups/${group.id}/messages`), page => page.items.some(m => m.clientMsgId === clientMsgId && m.deliveryStatus === 'sent'));
  assert.equal(sent.items.filter(m => m.clientMsgId === clientMsgId).length, 1);
  assert.equal(sent.items.find(m => m.clientMsgId === clientMsgId).isOwn, true);

  const replay = await websocketUntil(0, frame => frame.type === 'message' && frame.payload.msgId === sent.items.find(item => item.clientMsgId === clientMsgId).msgId);
  assert(replay.every((frame, index) => index === 0 || frame.seq > replay[index - 1].seq));
  const lastSeq = replay.at(-1).seq;
  const offlineMessage = await expectOk(`/groups/${group.gatewayGroupId}/external-message`, 'POST', { senderPlatformUserId: 'outside-replay', text: 'while websocket offline' }, gateway);
  const resumed = await websocketUntil(lastSeq, frame => frame.type === 'message' && frame.payload.msgId === offlineMessage.msgId);
  assert(resumed.every(frame => frame.seq > lastSeq));
  await until(() => expectOk(`/api/groups/${group.id}/messages`), page => page.items.some(item => item.msgId === offlineMessage.msgId));
  const duplicateEvent = (await expectOk(`/admin/events?msgId=${offlineMessage.msgId}`, 'GET', undefined, gateway)).find(event => event.type === 'message');
  assert(duplicateEvent, 'gateway retained the message event');
  await expectOk(`/admin/events/${duplicateEvent.eventId}/replay`, 'POST', {}, gateway);
  await delay(250);
  assert.equal((await expectOk(`/api/groups/${group.id}/messages`)).items.filter(item => item.msgId === offlineMessage.msgId).length, 1);

  await expectOk('/admin/send-fault', 'POST', { accountId: 'acc-2', code: 'NETWORK_TIMEOUT', accept: true }, gateway);
  const acceptedTimeout = await expectOk(`/api/groups/${group.id}/send`, 'POST', { accountId: 'acc-2', text: 'timeout but accepted' });
  await until(() => expectOk(`/api/groups/${group.id}/messages`), page => page.items.some(item => item.clientMsgId === acceptedTimeout.clientMsgId && item.deliveryStatus === 'unknown'));
  await until(() => expectOk(`/api/groups/${group.id}/messages`), page => page.items.some(item => item.clientMsgId === acceptedTimeout.clientMsgId && item.deliveryStatus === 'sent'), 8000);
  assert.equal((await expectOk(`/admin/groups/${group.gatewayGroupId}/messages`, 'GET', undefined, gateway)).filter(item => item.clientMsgId === acceptedTimeout.clientMsgId).length, 1);

  await expectOk('/admin/send-fault', 'POST', { accountId: 'acc-2', code: 'NETWORK_TIMEOUT', accept: false }, gateway);
  const rejectedTimeout = await expectOk(`/api/groups/${group.id}/send`, 'POST', { accountId: 'acc-2', text: 'timeout and retry' });
  await until(() => expectOk(`/api/groups/${group.id}/messages`), page => page.items.some(item => item.clientMsgId === rejectedTimeout.clientMsgId && item.deliveryStatus === 'unknown'));
  await until(() => expectOk(`/api/groups/${group.id}/messages`), page => page.items.some(item => item.clientMsgId === rejectedTimeout.clientMsgId && item.deliveryStatus === 'sent'), 8000);
  assert.equal((await expectOk(`/admin/groups/${group.gatewayGroupId}/messages`, 'GET', undefined, gateway)).filter(item => item.clientMsgId === rejectedTimeout.clientMsgId).length, 1);

  const media = await expectOk('/media', 'POST', { base64: Buffer.from('real media bytes').toString('base64'), contentType: 'text/plain' }, gateway);
  const attachment = await expectOk(`/groups/${group.gatewayGroupId}/external-message`, 'POST', { senderPlatformUserId: 'outside-media', text: 'attachment', mediaUrl: media.mediaUrl }, gateway);
  const mediaPage = await until(() => expectOk(`/api/groups/${group.id}/messages`), page => page.items.some(item => item.msgId === attachment.msgId && item.localFilePath), 8000);
  const mediaMessage = mediaPage.items.find(item => item.msgId === attachment.msgId);
  const downloaded = await fetch(`${base}/api/media/${mediaMessage.id}`, { headers: { authorization: `Bearer ${token}` } });
  assert(downloaded.ok); assert.equal(await downloaded.text(), 'real media bytes');

  await expectOk(`/api/groups/${group.id}`, 'PATCH', { agentEnabled: true });
  const agentTrigger = await expectOk(`/groups/${group.gatewayGroupId}/external-message`, 'POST', { senderPlatformUserId: 'outside-user', text: 'hello agent' }, gateway);
  const runningAgent = await until(() => expectOk(`/api/groups/${group.id}/agent-runs`), list => list.some(run => run.status === 'running'));
  await stop(backendProcess);
  backendProcess = launch('backend', ports.backend);
  await waitFor(`${base}/api/health`);
  const runs = await until(() => expectOk(`/api/groups/${group.id}/agent-runs`), list => list.some(run => run.id === runningAgent[0].id && run.status === 'finished'));
  assert(runs[0].steps.length > 0);
  const triggerEvent = (await expectOk(`/admin/events?msgId=${agentTrigger.msgId}`, 'GET', undefined, gateway)).find(event => event.type === 'message');
  await expectOk(`/admin/events/${triggerEvent.eventId}/replay`, 'POST', {}, gateway);
  await delay(300);
  assert.equal((await expectOk(`/api/groups/${group.id}/agent-runs`)).length, runs.length, 'duplicate gateway event must not trigger another agent run');

  const sequence = await expectOk('/api/sequences', 'POST', { name: 'integration', steps: [{ index: 1, accountRole: 'admin', text: 'Event {event}', delaySeconds: 0 }, { index: 2, accountRole: 'member', text: 'At {location}', delaySeconds: 0 }] });
  const { response: unresolved, data: unresolvedBody } = await request(`/api/groups/${group.id}/sequence-runs`, 'POST', { sequenceId: sequence.id, vars: { event: 'demo' } });
  assert.equal(unresolved.status, 422); assert.equal(unresolvedBody.error.code, 'UNRESOLVED_PLACEHOLDER');
  const { runId } = await expectOk(`/api/groups/${group.id}/sequence-runs`, 'POST', { sequenceId: sequence.id, vars: { event: 'demo' }, stepVars: { '2': { location: 'shared drive' } } });
  const finished = await until(() => expectOk(`/api/sequence-runs/${runId}`), run => run.status === 'finished');
  assert.equal(finished.steps[1].resolvedVars.location, 'shared drive');
  assert.equal(finished.steps[1].varSources.location, 'step:2');
  assert(finished.steps.every(step => step.status === 'sent'));
  const slowSequence = await expectOk('/api/sequences', 'POST', { name: 'concurrent', steps: [{ index: 1, accountRole: 'admin', text: 'concurrent', delaySeconds: 1 }] });
  const concurrent = await Promise.all([request(`/api/groups/${group.id}/sequence-runs`, 'POST', { sequenceId: slowSequence.id, vars: {} }), request(`/api/groups/${group.id}/sequence-runs`, 'POST', { sequenceId: slowSequence.id, vars: {} })]);
  assert.deepEqual(concurrent.map(item => item.response.status).sort(), [201, 409]);
  await until(() => expectOk(`/api/sequence-runs/${concurrent.find(item => item.response.status === 201).data.runId}`), item => item.status === 'finished');

  await expectOk('/accounts/acc-2/rate-limit', 'POST', { retryAfterSeconds: 2 }, gateway);
  const limited = await expectOk(`/api/groups/${group.id}/send`, 'POST', { accountId: 'acc-2', text: 'rate limited then sent' });
  await until(() => expectOk('/api/accounts'), accounts => accounts.find(item => item.id === 'acc-2').status === 'rate_limited');
  await until(() => expectOk(`/api/groups/${group.id}/messages`), page => page.items.some(item => item.clientMsgId === limited.clientMsgId && item.deliveryStatus === 'sent'), 8000);
  await expectOk('/accounts/acc-3/rate-limit', 'POST', { retryAfterSeconds: 5 }, gateway);
  const terminalMessage = await expectOk(`/api/groups/${group.id}/send`, 'POST', { accountId: 'acc-3', text: 'cancel on suspension' });
  await until(() => expectOk('/api/accounts'), accounts => accounts.find(item => item.id === 'acc-3').status === 'rate_limited');
  await expectOk('/accounts/acc-3/status', 'POST', { status: 'suspended' }, gateway);
  await until(() => expectOk('/api/accounts'), accounts => accounts.find(item => item.id === 'acc-3').status === 'suspended');
  await until(() => expectOk(`/api/groups/${group.id}/messages`), page => page.items.some(item => item.clientMsgId === terminalMessage.clientMsgId && item.deliveryStatus === 'cancelled' && item.failCode === 'ACCOUNT_TERMINAL'));
  assert(!(await expectOk(`/api/groups/${group.id}`)).members.some(member => member.accountId === 'acc-3'));

  await stop(gatewayProcess);
  gatewayProcess = launch('gateway-service', ports.gateway, { GATEWAY_STATE_FILE: gatewayStateFile, INVITE_READY_AFTER_MS: '500' });
  await waitFor(`${gateway}/health`);
  const runsBeforeRestart = await expectOk(`/api/groups/${group.id}/agent-runs`);
  await expectOk(`/groups/${group.gatewayGroupId}/external-message`, 'POST', { senderPlatformUserId: 'outside-restart', text: 'gateway restarted' }, gateway);
  await until(() => expectOk(`/api/groups/${group.id}/agent-runs`), items => items.length > runsBeforeRestart.length && items[0].status === 'finished');

  await stop(backendProcess);
  await expectOk(`/groups/${group.gatewayGroupId}/external-message`, 'POST', { senderPlatformUserId: 'outside-offline', text: 'backend was offline' }, gateway);
  backendProcess = launch('backend', ports.backend);
  await waitFor(`${base}/api/health`);
  await until(() => expectOk(`/api/groups/${group.id}/messages`), page => page.items.some(item => item.text === 'backend was offline'));

  const leave = await expectOk(`/api/groups/${group.id}/leave-all`, 'POST');
  await until(() => expectOk(`/api/jobs/${leave.jobId}`), job => job.status === 'finished');
  assert.equal((await expectOk(`/api/groups/${group.id}`)).members.length, 0);
  assert.equal((await expectOk(`/groups/${group.gatewayGroupId}/members`, 'GET', undefined, gateway)).length, 0);
  console.log('Integration scenarios passed: RBAC, group jobs, event dedupe, timeout reconciliation, outbox, media, agent, sequence concurrency, rate limit, restart recovery, leave-all.');
} finally {
  for (const child of processes.reverse()) child.kill('SIGKILL');
  await Promise.all(processes.map(child => child.exitCode === null && child.signalCode === null ? new Promise(resolve => child.once('exit', resolve)) : Promise.resolve()));
  databaseCommand(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`);
  try { (await import('node:fs')).unlinkSync(gatewayStateFile); } catch { /* No state file was written. */ }
  try { (await import('node:fs')).unlinkSync(agentSessionFile); } catch { /* No session file was written. */ }
  (await import('node:fs')).rmSync(mediaDirectory, { recursive: true, force: true });
}
