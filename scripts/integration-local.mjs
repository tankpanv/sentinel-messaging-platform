import { spawn, spawnSync } from 'node:child_process';
import { strict as assert } from 'node:assert';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
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
const gatewayMediaDirectory = `/tmp/${schemaName}_gateway_media`;
const adminUrl = new URL(process.env.DATABASE_URL || 'postgresql://sentinel:sentinel@127.0.0.1:5432/sentinel');
const testUrl = new URL(adminUrl);
testUrl.searchParams.set('options', `-csearch_path=${schemaName}`);
function databaseCommand(sql) {
  const result = spawnSync('psql', [adminUrl.toString(), '-v', 'ON_ERROR_STOP=1', '-c', sql], { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(result.stderr || result.stdout);
}
function testDatabaseCommand(sql) {
  const result = spawnSync('psql', [testUrl.toString(), '-v', 'ON_ERROR_STOP=1', '-c', sql], { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(result.stderr || result.stdout);
}
let token = '';
function launch(service, port, extra = {}) {
  const child = spawn(process.execPath, [path.join(root, service, 'dist/index.js')], {
    cwd: root,
    env: { ...process.env, PORT: String(port), DATABASE_URL: testUrl.toString(), GATEWAY_URL: gateway, AGENT_URL: `http://127.0.0.1:${ports.agent}`, JWT_SECRET: 'integration-secret', MEDIA_DIR: mediaDirectory, ENABLE_GATEWAY_SIMULATION: 'true', ...extra },
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
  let gatewayProcess = launch('gateway-service', ports.gateway, { GATEWAY_STATE_FILE: gatewayStateFile, GATEWAY_MEDIA_DIR: gatewayMediaDirectory, INVITE_READY_AFTER_MS: '500' });
  launch('agent-service', ports.agent, { AGENT_PROVIDER: 'mock', AGENT_SESSION_FILE: agentSessionFile, ENABLE_FAULT_INJECTION: 'true', AGENT_TURN_DELAY_MS: '500' });
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
  const illegalTransition = await request('/api/accounts/acc-5/transition', 'POST', { to: 'rate_limited', expectedFrom: 'idle' });
  assert.equal(illegalTransition.response.status, 409);
  assert.equal(illegalTransition.data.error.code, 'ILLEGAL_TRANSITION');
  const staleTransition = await request('/api/accounts/acc-5/transition', 'POST', { to: 'online', expectedFrom: 'disconnected' });
  assert.equal(staleTransition.response.status, 409);
  assert.equal(staleTransition.data.error.code, 'CAS_CONFLICT');
  for (const id of ['acc-1', 'acc-2', 'acc-3']) await expectOk(`/api/accounts/${id}/connect`, 'POST');

  const { jobId } = await expectOk('/api/groups', 'POST', { creatorAccountId: 'acc-1', memberAccountIds: ['acc-2', 'acc-3'] });
  const creationJob = await until(() => expectOk(`/api/jobs/${jobId}`), job => ['finished', 'failed'].includes(job.status));
  assert.equal(creationJob.status, 'finished', `group creation job failed: ${JSON.stringify(creationJob.errors)}`);
  assert.equal(creationJob.progress.step, 'complete');
  assert.deepEqual(creationJob.progress.completedMemberAccountIds.sort(), ['acc-2', 'acc-3']);
  assert.deepEqual(creationJob.errors, []);
  const group = (await expectOk('/api/groups')).find(g => g.members?.some(m => m.accountId === 'acc-3') && g.status === 'active');
  assert(group, 'created group appears in list');
  const detail = await expectOk(`/api/groups/${group.id}`);
  assert.equal(detail.members.find(m => m.accountId === 'acc-1').role, 'creator');
  assert.equal(detail.members.find(m => m.accountId === 'acc-2').role, 'admin');
  assert.equal(detail.members.find(m => m.accountId === 'acc-3').role, 'member');
  const gatewayGroupMembers = await expectOk(`/groups/${group.gatewayGroupId}/members`, 'GET', undefined, gateway);
  assert.equal(gatewayGroupMembers.find(member => member.platformUserId === detail.members.find(m => m.accountId === 'acc-2').platformUserId).role, 'admin');
  await expectOk('/api/accounts/acc-5/connect', 'POST');
  const competingTransitions = await Promise.all([
    request('/api/accounts/acc-5/transition', 'POST', { to: 'disconnected', expectedFrom: 'online' }),
    request('/api/accounts/acc-5/transition', 'POST', { to: 'disconnected', expectedFrom: 'online' }),
  ]);
  assert.deepEqual(competingTransitions.map(result => result.response.status).sort(), [200, 409], 'concurrent account transitions have one winner');
  assert.equal(competingTransitions.find(result => result.response.status === 409)?.data.error.code, 'CAS_CONFLICT');
  await expectOk('/api/accounts/acc-5/connect', 'POST');
  const fifthAccount = (await expectOk('/api/accounts')).find(account => account.id === 'acc-5');
  const firstRequest = await expectOk(`/api/groups/${group.id}/join-requests`, 'POST', { accountId: 'acc-5' });
  assert.equal(firstRequest.status, 'pending');
  const viewerLogin = await expectOk('/api/auth/login', 'POST', { username: 'viewer', password: 'viewer' });
  const viewerApproval = await request(`/api/groups/${group.id}/join-requests/${firstRequest.id}/approve`, 'POST', undefined, base, { headers: { authorization: `Bearer ${viewerLogin.accessToken}` } });
  assert.equal(viewerApproval.response.status, 403);
  assert.equal((await request(`/api/groups/${group.id}/join-requests`, 'POST', { accountId: 'acc-5' })).response.status, 409);
  assert(!(await expectOk(`/groups/${group.gatewayGroupId}/members`, 'GET', undefined, gateway)).some(member => member.platformUserId === fifthAccount.platformUserId));
  const rejectedRequest = await expectOk(`/api/groups/${group.id}/join-requests/${firstRequest.id}/reject`, 'POST');
  assert.equal(rejectedRequest.status, 'rejected');
  assert.equal((await request(`/api/groups/${group.id}/join-requests/${firstRequest.id}/approve`, 'POST')).response.status, 409);
  assert(!(await expectOk(`/groups/${group.gatewayGroupId}/members`, 'GET', undefined, gateway)).some(member => member.platformUserId === fifthAccount.platformUserId));
  const secondRequest = await expectOk(`/api/groups/${group.id}/join-requests`, 'POST', { accountId: 'acc-5' });
  assert.equal((await expectOk(`/api/groups/${group.id}/join-requests/${secondRequest.id}/approve`, 'POST')).status, 'approved');
  await stop(backendProcess);
  backendProcess = launch('backend', ports.backend);
  await waitFor(`${base}/api/health`);
  await until(() => expectOk(`/api/groups/${group.id}/join-requests`), list => list.some(item => item.id === secondRequest.id && item.status === 'joined'), 15000);
  assert((await expectOk(`/api/groups/${group.id}`)).members.some(member => member.accountId === 'acc-5'));
  await expectOk(`/api/groups/${group.id}/members/leave`, 'POST', { accountId: 'acc-5' });
  await until(() => expectOk(`/api/groups/${group.id}`), current => !current.members.some(member => member.accountId === 'acc-5'));
  const invalidJoin = await request(`/api/groups/${group.id}/members/join`, 'POST', { accountId: 'acc-5' });
  assert.equal(invalidJoin.response.status, 400);
  const invite = await expectOk(`/api/groups/${group.id}/members/invite`, 'POST');
  assert(invite.inviteLink);
  await delay(Number(invite.readyAfterMs || 0) + 100);
  const joined = await request(`/api/groups/${group.id}/members/join`, 'POST', { accountId: 'acc-5', inviteLink: invite.inviteLink });
  assert.equal(joined.response.status, 202);
  await until(() => expectOk(`/api/groups/${group.id}`), current => current.members.some(member => member.accountId === 'acc-5'));
  const notOwner = await request(`/api/groups/${group.id}/members/promote`, 'POST', { byAccountId: 'acc-2', accountId: 'acc-5' });
  assert.equal(notOwner.response.status, 403);
  assert.equal(notOwner.data.error.code, 'FORBIDDEN');
  await expectOk(`/api/groups/${group.id}/members/promote`, 'POST', { byAccountId: 'acc-1', accountId: 'acc-5' });
  assert.equal((await expectOk(`/api/groups/${group.id}`)).members.find(member => member.accountId === 'acc-5').role, 'admin');
  const fifth = (await expectOk('/api/accounts')).find(account => account.id === 'acc-5');
  await expectOk(`/api/groups/${group.id}/members/kick`, 'POST', { byAccountId: 'acc-2', targetPlatformUserId: fifth.platformUserId });
  await until(() => expectOk(`/api/groups/${group.id}`), current => !current.members.some(member => member.accountId === 'acc-5'));
  const inviteAgain = await expectOk(`/api/groups/${group.id}/members/invite`, 'POST');
  await delay(Number(inviteAgain.readyAfterMs || 0) + 100);
  assert.equal((await request(`/api/groups/${group.id}/members/join`, 'POST', { accountId: 'acc-5', inviteLink: inviteAgain.inviteLink })).response.status, 202);
  await until(() => expectOk(`/api/groups/${group.id}`), current => current.members.some(member => member.accountId === 'acc-5'));
  await expectOk(`/api/groups/${group.id}/members/leave`, 'POST', { accountId: 'acc-5' });
  await until(() => expectOk(`/api/groups/${group.id}`), current => !current.members.some(member => member.accountId === 'acc-5'));
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
  const secondBackend = launch('backend', 4313);
  await waitFor('http://127.0.0.1:4313/api/health');
  await expectOk('/admin/send-delay', 'POST', { accountId: 'acc-2', delayMs: 1600 }, gateway);
  const orderedFirst = await expectOk(`/api/groups/${group.id}/send`, 'POST', { accountId: 'acc-2', text: 'ordered-first' });
  const orderedSecond = await expectOk(`/api/groups/${group.id}/send`, 'POST', { accountId: 'acc-2', text: 'ordered-second' });
  await until(() => expectOk(`/api/groups/${group.id}/messages`), page => page.items.some(item => item.clientMsgId === orderedFirst.clientMsgId && item.deliveryStatus === 'accepted'));
  const beforeFirstLands = await expectOk(`/api/groups/${group.id}/messages`);
  assert.equal(beforeFirstLands.items.find(item => item.clientMsgId === orderedSecond.clientMsgId)?.deliveryStatus, 'queued', 'another Backend must not overtake this account’s accepted message');
  await until(() => expectOk(`/api/groups/${group.id}/messages`), page => [orderedFirst.clientMsgId, orderedSecond.clientMsgId].every(id => page.items.some(item => item.clientMsgId === id && item.deliveryStatus === 'sent')), 12000);
  const gatewayOrdered = (await expectOk(`/admin/groups/${group.gatewayGroupId}/messages`, 'GET', undefined, gateway)).filter(item => ['ordered-first', 'ordered-second'].includes(item.text));
  assert.deepEqual(gatewayOrdered.map(item => item.text), ['ordered-first', 'ordered-second']);
  await stop(secondBackend);

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
  const localMediaFile = path.join(mediaDirectory, mediaMessage.id);
  assert(fs.existsSync(localMediaFile), 'backend stores a separate local media file');
  assert.equal(fs.readFileSync(localMediaFile, 'utf8'), 'real media bytes');
  assert.equal(mediaMessage.media.status, 'ready');
  assert.equal(mediaMessage.media.contentType, 'text/plain');
  assert.equal(mediaMessage.media.sourceUrl, null, 'downloaded media no longer retains a Gateway URL that can expire');
  const staleAttachment = await expectOk(`/groups/${group.gatewayGroupId}/external-message`, 'POST', {
    senderPlatformUserId: 'outside-stale-media', text: 'late delivery', mediaUrl: media.mediaUrl,
    sentAt: new Date(Date.now() - 31 * 86400000).toISOString(),
  }, gateway);
  const stalePage = await until(() => expectOk(`/api/groups/${group.id}/messages`), page => page.items.some(item => item.msgId === staleAttachment.msgId && item.media?.status === 'deleted'), 8000);
  const staleMessage = stalePage.items.find(item => item.msgId === staleAttachment.msgId);
  assert.equal(staleMessage.localFilePath, null, 'late expired media is never downloaded');
  assert.equal(staleMessage.media.sourceUrl, null, 'late expired media does not retain a stale Gateway URL');
  const downloaded = await fetch(`${base}/api/media/${mediaMessage.id}`, { headers: { authorization: `Bearer ${token}` } });
  assert(downloaded.ok); assert.equal(await downloaded.text(), 'real media bytes');
  testDatabaseCommand(`UPDATE messages SET sent_at=now()-interval '31 days' WHERE id='${mediaMessage.id}'`);
  // Synthetic running Run fixture: verify that retention honors an exact message reference.
  await stop(backendProcess);
  const protectedRunId = randomUUID();
  testDatabaseCommand(`INSERT INTO agent_runs(id,group_id,status) VALUES('${protectedRunId}','${group.id}','running'); INSERT INTO agent_run_media_refs(run_id,message_id) VALUES('${protectedRunId}','${mediaMessage.id}')`);
  process.env.MEDIA_DIR = mediaDirectory;
  const requireBackend = createRequire(path.join(root, 'backend', 'package.json'));
  const { Pool } = requireBackend('pg');
  const { cleanupExpiredMedia } = await import(path.join(root, 'backend', 'dist', 'domains', 'message', 'media.js'));
  const testPool = new Pool({ connectionString: testUrl.toString() });
  try {
    await cleanupExpiredMedia(testPool);
    assert(fs.existsSync(localMediaFile), 'running Agent Run keeps its referenced media file');
    const protectedMessage = await testPool.query('SELECT local_file_path,media_status FROM messages WHERE id=$1', [mediaMessage.id]);
    assert.equal(protectedMessage.rows[0].local_file_path, localMediaFile);
    assert.equal(protectedMessage.rows[0].media_status, 'ready');
    await testPool.query(
      "UPDATE agent_runs SET status='finished',trigger_messages=$2,history=$3,steps=$4,summary=$5 WHERE id=$1",
      [protectedRunId,
        JSON.stringify([{ messageId: mediaMessage.id, media: { localFilePath: localMediaFile, mediaUrl: null } }]),
        JSON.stringify([{ role: 'user', content: [{ type: 'text', text: JSON.stringify({ localFilePath: localMediaFile, mediaUrl: null }) }] }]),
        JSON.stringify([{ resultSummary: localMediaFile }]),
        `Viewed ${localMediaFile}`],
    );
  } finally { await testPool.end(); }
  backendProcess = launch('backend', ports.backend);
  await waitFor(`${base}/api/health`);
  await until(async () => {
    const response = await fetch(`${base}/api/media/${mediaMessage.id}`, { headers: { authorization: `Bearer ${token}` } });
    return response.status;
  }, status => status === 404, 8000);
  await delay(2500);
  const expiredAttachment = await fetch(`${base}/api/media/${mediaMessage.id}`, { headers: { authorization: `Bearer ${token}` } });
  assert.equal(expiredAttachment.status, 404, 'expired attachment is not downloaded again after cleanup');
  assert.equal(fs.existsSync(localMediaFile), false, 'expired local media bytes are removed');
  const expiredMessage = (await expectOk(`/api/groups/${group.id}/messages`)).items.find(item => item.id === mediaMessage.id);
  assert.equal(expiredMessage.localFilePath, null, 'message no longer points to the deleted local file');
  assert.equal(expiredMessage.media.localUrl, null);
  assert.equal(expiredMessage.media.sourceUrl, null);
  assert.equal(expiredMessage.media.status, 'deleted');
  const scrubPool = new Pool({ connectionString: testUrl.toString() });
  try {
    const scrubbed = await scrubPool.query('SELECT trigger_messages,history,steps,summary FROM agent_runs WHERE id=$1', [protectedRunId]);
    assert(!JSON.stringify(scrubbed.rows[0]).includes(localMediaFile), 'finished Agent Run snapshots no longer point to deleted local media');
  } finally { await scrubPool.end(); }

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
  assert.equal((await expectOk('/api/agent-simulation')).enabled, true);
  const viewerSimulationToken = (await expectOk('/api/auth/login', 'POST', { username: 'viewer', password: 'viewer' })).accessToken;
  const deniedSimulation = await request(`/api/groups/${group.id}/agent-simulation/messages`, 'POST', { senderPlatformUserId: 'external-viewer', text: 'forbidden' }, base, { headers: { authorization: `Bearer ${viewerSimulationToken}` } });
  assert.equal(deniedSimulation.response.status, 403);
  assert.equal(deniedSimulation.data.error.code, 'FORBIDDEN');
  const invalidSimulation = await request(`/api/groups/${group.id}/agent-simulation/messages`, 'POST', { senderPlatformUserId: 'platform-1', text: '' });
  assert.equal(invalidSimulation.response.status, 400);
  assert.equal(invalidSimulation.data.error.code, 'VALIDATION_ERROR');
  const agentRunsBefore = new Set((await expectOk(`/api/groups/${group.id}/agent-runs`)).map(run => run.id));
  const simulated = await expectOk(`/api/groups/${group.id}/agent-simulation/messages`, 'POST', { senderPlatformUserId: 'external-agent-check', text: 'please answer' });
  assert(simulated.msgId);
  const replyRun = await until(async () => (await expectOk(`/api/groups/${group.id}/agent-runs`)).find(run => !agentRunsBefore.has(run.id)), run => run?.status === 'finished');
  const replyDetail = await expectOk(`/api/agent-runs/${replyRun.id}`);
  assert.deepEqual(replyDetail.steps.map(step => step.name), ['get_recent_messages', 'send_message', 'finish']);
  assert.equal(replyDetail.steps[1].auditVerdict, 'pass');
  assert.equal(replyDetail.steps[1].isError, false);
  assert(replyDetail.steps.every(step => step.kind && step.resultSummary !== undefined && step.rawResponse !== undefined));
  const replyMessages = await expectOk(`/api/groups/${group.id}/messages`);
  assert(replyMessages.items.some(message => message.text === '收到：please answer' && message.isOwn));
  await expectOk(`/api/groups/${group.id}`, 'PATCH', { autoKickEnabled: true });
  const kickRunsBefore = new Set((await expectOk(`/api/groups/${group.id}/agent-runs`)).map(run => run.id));
  await expectOk(`/api/groups/${group.id}/agent-simulation/messages`, 'POST', { senderPlatformUserId: 'external-spammer', text: 'spam 广告' });
  const kickRun = await until(async () => (await expectOk(`/api/groups/${group.id}/agent-runs`)).find(run => !kickRunsBefore.has(run.id)), run => run?.status === 'finished');
  const kickDetail = await expectOk(`/api/agent-runs/${kickRun.id}`);
  assert.deepEqual(kickDetail.steps.map(step => step.name), ['get_recent_messages', 'kick_user', 'finish']);
  assert.equal(kickDetail.steps[1].auditVerdict, 'pass');
  assert(!(await expectOk(`/groups/${group.gatewayGroupId}/members`, 'GET', undefined, gateway)).some(member => member.platformUserId === 'external-spammer'));

  const sequence = await expectOk('/api/sequences', 'POST', { name: 'integration', steps: [{ index: 1, accountRole: 'admin', text: 'Event {event}', delaySeconds: 0 }, { index: 2, accountRole: 'member', text: 'At {location}', delaySeconds: 0 }] });
  const previewMissing = await request('/api/sequences/preview', 'POST', { steps: [{ index: 1, accountRole: 'admin', text: 'Event {event}', delaySeconds: 0 }, { index: 2, accountRole: 'member', text: 'At {location}', delaySeconds: 0 }], vars: { event: 'demo' } });
  assert.equal(previewMissing.response.status, 422);
  assert.equal(previewMissing.data.error.code, 'UNRESOLVED_PLACEHOLDER');
  assert.equal(previewMissing.data.error.stepIndex, 2);
  assert.equal(previewMissing.data.error.key, 'location');
  const preview = await expectOk('/api/sequences/preview', 'POST', { steps: [{ index: 1, accountRole: 'admin', text: 'Event {event}', delaySeconds: 0 }, { index: 2, accountRole: 'member', text: 'At {location}', delaySeconds: 0 }], vars: { event: 'demo' }, stepVars: { '2': { location: 'shared drive' } } });
  assert.equal(preview.steps[1].text, 'At shared drive');
  assert.equal(preview.steps[1].varSources.location, 'step:2');
  assert.equal(preview.steps[1].varSources.event, 'default');
  const { response: unresolved, data: unresolvedBody } = await request(`/api/groups/${group.id}/sequence-runs`, 'POST', { sequenceId: sequence.id, vars: { event: 'demo' } });
  assert.equal(unresolved.status, 422); assert.equal(unresolvedBody.error.code, 'UNRESOLVED_PLACEHOLDER');
  const { runId } = await expectOk(`/api/groups/${group.id}/sequence-runs`, 'POST', { sequenceId: sequence.id, vars: { event: 'demo' }, stepVars: { '2': { location: 'shared drive' } } });
  const finished = await until(() => expectOk(`/api/sequence-runs/${runId}`), run => run.status === 'finished');
  assert.equal(finished.steps[1].resolvedVars.location, 'shared drive');
  assert.equal(finished.steps[1].varSources.location, 'step:2');
  assert(finished.steps.every(step => step.status === 'sent'));
  const fixedSender = await expectOk('/api/sequences', 'POST', { name: 'fixed sender', steps: [{ index: 1, accountRole: 'member', senderAccountId: 'acc-1', text: 'fixed sender first', delaySeconds: 0 }] });
  const fixedPreview = await expectOk('/api/sequences/preview', 'POST', { steps: [{ index: 1, accountRole: 'member', senderAccountId: 'acc-1', text: 'fixed sender first', delaySeconds: 0 }], stepAccountIds: { '1': 'acc-2' } });
  assert.equal(fixedPreview.steps[0].senderAccountId, 'acc-2');
  const accountIds = await expectOk('/api/accounts');
  const fixedRun = await expectOk(`/api/groups/${group.id}/sequence-runs`, 'POST', { sequenceId: fixedSender.id, vars: {} });
  const fixedFinished = await until(() => expectOk(`/api/sequence-runs/${fixedRun.runId}`), run => run.status === 'finished');
  assert.equal(fixedFinished.steps[0].senderAccountId, 'acc-1');
  assert.equal(fixedFinished.steps[0].accountId, 'acc-1', 'fixed service account overrides role based selection');
  const overrideRun = await expectOk(`/api/groups/${group.id}/sequence-runs`, 'POST', { sequenceId: fixedSender.id, vars: {}, stepAccountIds: { '1': 'acc-2' } });
  const overrideFinished = await until(() => expectOk(`/api/sequence-runs/${overrideRun.runId}`), run => run.status === 'finished');
  assert.equal(overrideFinished.steps[0].senderAccountId, 'acc-2');
  assert.equal(overrideFinished.steps[0].accountId, 'acc-2', 'run sender override is used for gateway send');
  assert.equal((await expectOk(`/api/sequences/${fixedSender.id}`)).steps[0].senderAccountId, 'acc-1', 'run override leaves saved template intact');
  const senderPage = await expectOk(`/api/groups/${group.id}/messages`);
  assert.equal(senderPage.items.find(item => item.clientMsgId === fixedFinished.steps[0].clientMsgId)?.senderPlatformUserId, accountIds.find(item => item.id === 'acc-1').platformUserId);
  assert.equal(senderPage.items.find(item => item.clientMsgId === overrideFinished.steps[0].clientMsgId)?.senderPlatformUserId, accountIds.find(item => item.id === 'acc-2').platformUserId);
  const slowSequence = await expectOk('/api/sequences', 'POST', { name: 'concurrent', steps: [{ index: 1, accountRole: 'admin', text: 'concurrent', delaySeconds: 1 }] });
  const concurrent = await Promise.all([request(`/api/groups/${group.id}/sequence-runs`, 'POST', { sequenceId: slowSequence.id, vars: {} }), request(`/api/groups/${group.id}/sequence-runs`, 'POST', { sequenceId: slowSequence.id, vars: {} })]);
  assert.deepEqual(concurrent.map(item => item.response.status).sort(), [201, 409]);
  await until(() => expectOk(`/api/sequence-runs/${concurrent.find(item => item.response.status === 201).data.runId}`), item => item.status === 'finished');

  await expectOk('/accounts/acc-2/rate-limit', 'POST', { retryAfterSeconds: 4 }, gateway);
  const limited = await expectOk(`/api/groups/${group.id}/send`, 'POST', { accountId: 'acc-2', text: 'rate limited then sent' });
  await until(() => expectOk('/api/accounts'), accounts => accounts.find(item => item.id === 'acc-2').status === 'rate_limited');
  const fallbackSequence = await expectOk('/api/sequences', 'POST', { name: 'online admin fallback', steps: [{ index: 1, accountRole: 'admin', text: 'creator sends while admin limited', delaySeconds: 0 }] });
  const fallbackRun = await expectOk(`/api/groups/${group.id}/sequence-runs`, 'POST', { sequenceId: fallbackSequence.id, vars: {} });
  const fallbackFinished = await until(() => expectOk(`/api/sequence-runs/${fallbackRun.runId}`), run => run.status === 'finished', 8000);
  const fallbackPage = await expectOk(`/api/groups/${group.id}/messages`);
  assert.equal(fallbackPage.items.find(item => item.clientMsgId === fallbackFinished.steps[0].clientMsgId)?.senderPlatformUserId, (await expectOk('/api/accounts')).find(item => item.id === 'acc-1').platformUserId);
  await until(() => expectOk(`/api/groups/${group.id}/messages`), page => page.items.some(item => item.clientMsgId === limited.clientMsgId && item.deliveryStatus === 'sent'), 10000);
  await expectOk('/accounts/acc-3/rate-limit', 'POST', { retryAfterSeconds: 5 }, gateway);
  const terminalMessage = await expectOk(`/api/groups/${group.id}/send`, 'POST', { accountId: 'acc-3', text: 'cancel on suspension' });
  await until(() => expectOk('/api/accounts'), accounts => accounts.find(item => item.id === 'acc-3').status === 'rate_limited');
  await expectOk('/accounts/acc-3/status', 'POST', { status: 'suspended' }, gateway);
  await until(() => expectOk('/api/accounts'), accounts => accounts.find(item => item.id === 'acc-3').status === 'suspended');
  const repeatedTerminal = await request('/api/accounts/acc-3/transition', 'POST', { to: 'suspended', expectedFrom: 'suspended' });
  assert.equal(repeatedTerminal.response.status, 200, 're-entering the same terminal account state is idempotent');
  await until(() => expectOk(`/api/groups/${group.id}/messages`), page => page.items.some(item => item.clientMsgId === terminalMessage.clientMsgId && item.deliveryStatus === 'cancelled' && item.failCode === 'ACCOUNT_TERMINAL'));
  assert(!(await expectOk(`/api/groups/${group.id}`)).members.some(member => member.accountId === 'acc-3'));

  await stop(gatewayProcess);
  gatewayProcess = launch('gateway-service', ports.gateway, { GATEWAY_STATE_FILE: gatewayStateFile, GATEWAY_MEDIA_DIR: gatewayMediaDirectory, INVITE_READY_AFTER_MS: '500' });
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
  const afterLeaveGatewayMembers = await expectOk(`/groups/${group.gatewayGroupId}/members`, 'GET', undefined, gateway);
  assert(!afterLeaveGatewayMembers.some(member => group.members.some(managed => managed.platformUserId === member.platformUserId)), 'leave-all removes all managed accounts; external members can remain');
  const asyncGroup = (await expectOk('/api/groups')).find(item => item.id !== group.id && item.members?.some(member => member.accountId === 'acc-4'));
  assert(asyncGroup, 'isolated group for asynchronous gateway failure cases');
  const staleAcceptedId = randomUUID();
  testDatabaseCommand(`INSERT INTO messages(group_id,client_msg_id,text,sender_platform_user_id,sent_at,delivery_status,is_own,outbound_account_id,attempted_at) SELECT '${group.id}','${staleAcceptedId}','stale accepted from left group',platform_user_id,now()-interval '10 seconds','accepted',true,id,now()-interval '10 seconds' FROM accounts WHERE id='acc-1'`);
  const afterStale = await expectOk(`/api/groups/${asyncGroup.id}/send`, 'POST', { accountId: 'acc-1', text: 'queue continues after retired group' });
  await until(() => expectOk(`/api/groups/${group.id}/messages`), page => page.items.some(item => item.clientMsgId === staleAcceptedId && item.deliveryStatus === 'failed' && item.failCode === 'GROUP_UNREACHABLE'), 8000);
  await until(() => expectOk(`/api/groups/${asyncGroup.id}/messages`), page => page.items.some(item => item.clientMsgId === afterStale.clientMsgId && item.deliveryStatus === 'sent'), 8000);
  const writeFailureId = randomUUID();
  testDatabaseCommand(`INSERT INTO messages(group_id,client_msg_id,text,sender_platform_user_id,sent_at,delivery_status,is_own,outbound_account_id) SELECT '${asyncGroup.id}','${writeFailureId}','async write forbidden',platform_user_id,now(),'accepted',true,id FROM accounts WHERE id='acc-4'`);
  await expectOk('/admin/events/inject', 'POST', { type: 'message_failed', clientMsgId: writeFailureId, code: 'GROUP_WRITE_FORBIDDEN' }, gateway);
  await until(() => expectOk(`/api/groups/${asyncGroup.id}`), current => current.status === 'unreachable' && current.agentEnabled === false);
  await until(() => expectOk(`/api/groups/${asyncGroup.id}/messages`), page => page.items.some(item => item.clientMsgId === writeFailureId && item.deliveryStatus === 'failed'));
  const suspendedFailureId = randomUUID();
  testDatabaseCommand(`INSERT INTO messages(group_id,client_msg_id,text,sender_platform_user_id,sent_at,delivery_status,is_own,outbound_account_id) SELECT '${asyncGroup.id}','${suspendedFailureId}','async account suspended',platform_user_id,now(),'accepted',true,id FROM accounts WHERE id='acc-4'`);
  await expectOk('/admin/events/inject', 'POST', { type: 'message_failed', clientMsgId: suspendedFailureId, code: 'ACCOUNT_SUSPENDED' }, gateway);
  await until(() => expectOk('/api/accounts'), items => items.find(item => item.id === 'acc-4').status === 'suspended');
  assert(!(await expectOk(`/api/groups/${asyncGroup.id}`)).members.some(member => member.accountId === 'acc-4'));
  console.log('Simulated-service integration scenarios passed: RBAC, approval reject/approve/restart, group jobs, invite/join/promote/kick/leave, event dedupe, timeout reconciliation, outbox, media, mock agent, sequence concurrency, rate limit, restart recovery, leave-all. Real external gateway users and real LLM were not tested.');
} finally {
  for (const child of processes.reverse()) child.kill('SIGKILL');
  await Promise.all(processes.map(child => child.exitCode === null && child.signalCode === null ? new Promise(resolve => child.once('exit', resolve)) : Promise.resolve()));
  databaseCommand(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`);
  try { (await import('node:fs')).unlinkSync(gatewayStateFile); } catch { /* No state file was written. */ }
  try { (await import('node:fs')).unlinkSync(agentSessionFile); } catch { /* No session file was written. */ }
  (await import('node:fs')).rmSync(mediaDirectory, { recursive: true, force: true });
  (await import('node:fs')).rmSync(gatewayMediaDirectory, { recursive: true, force: true });
}
