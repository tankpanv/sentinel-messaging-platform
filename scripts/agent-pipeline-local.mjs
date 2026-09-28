import { createServer } from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { strict as assert } from 'node:assert';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ports = { backend: 4530, gateway: 4531, agent: 4532 };
const base = `http://127.0.0.1:${ports.backend}`;
const gateway = `http://127.0.0.1:${ports.gateway}`;
const schema = `sentinel_agent_${randomUUID().replaceAll('-', '')}`;
const db = new URL(process.env.DATABASE_URL || 'postgresql://sentinel:sentinel@127.0.0.1:5432/sentinel');
const testDb = new URL(db); testDb.searchParams.set('options', `-csearch_path=${schema}`);
const state = `/tmp/${schema}_gateway.json`;
const children = [];
let token = '';
const calls = new Map();
const contexts = new Map();
const audits = new Map();
let expectedGroupId = '';
const tool = (id, name, input) => ({ stop_reason: 'tool_use', content: [{ type: 'tool_use', id, name, input }] });
const finish = summary => tool(`finish-${randomUUID()}`, 'finish', { summary });
function sql(statement) {
  const result = spawnSync('psql', [db.toString(), '-v', 'ON_ERROR_STOP=1', '-c', statement], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || result.stdout);
}
function sqlValue(statement) {
  const result = spawnSync('psql', [testDb.toString(), '-v', 'ON_ERROR_STOP=1', '-At', '-c', statement], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout.trim();
}
function launch(service, port, extra = {}) {
  const child = spawn(process.execPath, [path.join(root, service, 'dist/index.js')], { cwd: root, env: { ...process.env, PORT: String(port), DATABASE_URL: testDb.toString(), GATEWAY_URL: gateway, AGENT_URL: `http://127.0.0.1:${ports.agent}`, JWT_SECRET: 'agent-pipeline-test', GATEWAY_STATE_FILE: state, ...extra }, stdio: ['ignore', 'pipe', 'pipe'] });
  children.push(child);
  child.stdout.on('data', chunk => { for (const line of String(chunk).split('\n')) if (line && !line.includes('"event":"http_request"')) process.stdout.write(`[${service}] ${line}\n`); });
  child.stderr.on('data', chunk => process.stderr.write(`[${service}] ${chunk}`));
  return child;
}
async function ready(url) { for (let i = 0; i < 100; i++) { try { if ((await fetch(url)).ok) return; } catch {} await delay(100); } throw Error(`Not ready: ${url}`); }
async function request(pathname, method = 'GET', body, origin = base) {
  const response = await fetch(`${origin}${pathname}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const data = await response.json().catch(() => ({}));
  assert(response.ok, `${method} ${pathname}: ${response.status} ${JSON.stringify(data)}`);
  return data;
}
async function until(task, predicate, ms = 15000) { const end = Date.now() + ms; while (Date.now() < end) { const value = await task(); if (predicate(value)) return value; await delay(100); } throw Error('Timed out waiting for state'); }
const agent = createServer(async (req, res) => {
  let body = ''; for await (const chunk of req) body += chunk;
  const data = JSON.parse(body || '{}');
  const reply = (status, value) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(typeof value === 'string' ? value : JSON.stringify(value)); };
  if (req.url === '/agent/audit') {
    assert.equal(data.groupId, expectedGroupId, 'audit uses the Backend group ID');
    audits.set(data.text, (audits.get(data.text) || 0) + 1);
    if (data.text === 'blocked-audit') return reply(500, { error: 'unavailable' });
    if (data.text === 'invalid-audit-json') return reply(200, 'not json');
    if (data.text === 'missing-audit-verdict') return reply(200, { reason: 'missing' });
    if (data.text === 'unknown-audit-verdict') return reply(200, { verdict: 'maybe', reason: 'unknown' });
    if (data.text === 'slow-audit') { await delay(5500); return reply(200, { verdict: 'pass', reason: 'late' }); }
    return reply(200, { verdict: data.text === 'password: secret' ? 'fail' : 'pass', reason: 'scripted' });
  }
  if (req.url !== '/agent/turn') return reply(404, {});
  const firstContext = data.messages[0].content[0].text;
  if (contexts.has(data.runId)) assert.equal(firstContext, contexts.get(data.runId), 'runId keeps its original trigger context across turns and restart');
  else contexts.set(data.runId, firstContext);
  const context = JSON.parse(data.messages[0].content[0].text);
  assert.equal(context.groupId, expectedGroupId, 'trigger context uses the Backend group ID');
  const test = context.triggerMessages[0].text.split('|')[0];
  const count = (calls.get(data.runId) || 0) + 1; calls.set(data.runId, count);
  const results = data.messages.filter(message => message.content?.[0]?.type === 'tool_result');
  const last = results.at(-1)?.content[0];
  const errors = data.messages.filter(message => message.content?.[0]?.text?.startsWith('PROTOCOL_ERROR'));
  if (test === 'bad-json') return reply(200, '```json\n{"stop_reason":"end_turn","content":[{"type":"text","text":"x"}]}\n```');
  if (test === 'bad-large-unicode') return reply(200, `not-json-${'中'.repeat(2000)}`);
  if (test === 'bad-shape') return reply(200, { stop_reason: 'tool_use', content: [{ type: 'text', text: 'wrong block' }] });
  if (test === 'bad-count') return reply(200, { stop_reason: 'end_turn', content: [] });
  if (test === 'http-error') return reply(500, { stop_reason: 'end_turn', content: [{ type: 'text', text: 'not accepted' }] });
  if (test === 'turn-timeout') { await delay(11000); return reply(200, finish('late result')); }
  if (test === 'restart-run') { if (count === 1) await delay(5000); return reply(200, finish('resumed after backend restart')); }
  if (test === 'end-turn') return reply(200, { stop_reason: 'end_turn', content: [{ type: 'text', text: 'ended without sending' }] });
  if (test === 'budget') return reply(200, tool(`repeat-${count}`, 'get_recent_messages', { limit: 10 }));
  if (test === 'unknown') return reply(200, results.length ? finish('done') : tool('unknown-1', 'outside_tool', {}));
  if (test === 'invalid') return reply(200, results.length ? finish('done') : tool('invalid-1', 'send_message', { text: 'missing key' }));
  if (test === 'duplicate') return reply(200, errors.length ? finish('done') : tool('same-id', 'get_recent_messages', { limit: 10 }));
  if (test === 'limit') return reply(200, results.length ? finish('done') : tool('limit-1', 'get_recent_messages', { limit: 100000 }));
  if (test === 'limit-bulk' || test === 'limit-long') return reply(200, results.length ? finish('done') : tool(`${test}-1`, 'get_recent_messages', { limit: 100000 }));
  if (test === 'audit-fail') return reply(200, results.length ? finish('done') : tool('audit-fail-1', 'send_message', { text: 'password: secret', idempotency_key: 'rejected-key' }));
  if (test === 'audit-blocked') return reply(200, tool('audit-blocked-1', 'send_message', { text: 'blocked-audit', idempotency_key: 'blocked-key' }));
  if (['audit-invalid-json', 'audit-no-verdict', 'audit-unknown-verdict', 'audit-slow'].includes(test)) {
    const text = ({ 'audit-invalid-json': 'invalid-audit-json', 'audit-no-verdict': 'missing-audit-verdict', 'audit-unknown-verdict': 'unknown-audit-verdict', 'audit-slow': 'slow-audit' })[test];
    return reply(200, tool(`${test}-1`, 'send_message', { text, idempotency_key: `${test}-key` }));
  }
  if (test === 'kick-denied') return reply(200, results.length ? finish('done') : tool('kick-denied-1', 'kick_user', { platform_user_id: 'outside', reason: 'test' }));
  if (test === 'no-account') return reply(200, results.length ? finish('done') : tool('no-account-1', 'send_message', { text: 'cannot send', idempotency_key: 'no-account-key' }));
  if (test === 'restart-send') return reply(200, results.length ? finish('send resumed') : tool('restart-send-1', 'send_message', { text: 'restart persistent reply', idempotency_key: 'restart-send-key' }));
  if (test === 'send-unreachable') return reply(200, results.length ? finish('done') : tool('send-unreachable-1', 'send_message', { text: 'write forbidden', idempotency_key: 'unreachable-key' }));
  if (test === 'idem') {
    if (!results.length) return reply(200, tool('idem-1', 'send_message', { text: 'idempotent reply', idempotency_key: 'same-key' }));
    if (results.length === 1) return reply(200, tool('idem-2', 'send_message', { text: 'idempotent reply', idempotency_key: 'same-key' }));
    return reply(200, finish('done'));
  }
  if (test === 'kick-retry') {
    if (!results.length) return reply(200, tool('kick-retry-1', 'kick_user', { platform_user_id: 'platform-2', reason: 'test' }));
    if (results.length === 1) return reply(200, tool('kick-retry-2', 'kick_user', { platform_user_id: 'platform-2', reason: 'test' }));
    return reply(200, finish('kicked once'));
  }
  if (test === 'pending') {
    if (count === 1) await delay(900);
    return reply(200, finish('done'));
  }
  return reply(200, finish('done'));
});
try {
  sql(`CREATE SCHEMA ${schema}`);
  const migrate = spawnSync(process.execPath, [path.join(root, 'backend/node_modules/tsx/dist/cli.mjs'), path.join(root, 'backend/src/infrastructure/db/migrate.ts')], { env: { ...process.env, DATABASE_URL: testDb.toString() }, encoding: 'utf8' });
  assert.equal(migrate.status, 0, migrate.stderr);
  await new Promise(resolve => agent.listen(ports.agent, '127.0.0.1', resolve));
  launch('gateway-service', ports.gateway); await ready(`${gateway}/health`);
  let backendProcess = launch('backend', ports.backend, { AGENT_TURN_TIMEOUT_MS: '10000' }); await ready(`${base}/api/health`);
  token = (await request('/api/auth/login', 'POST', { username: 'admin', password: 'admin' })).accessToken;
  for (const id of ['acc-1', 'acc-2']) await request(`/api/accounts/${id}/connect`, 'POST');
  const job = await request('/api/groups', 'POST', { creatorAccountId: 'acc-1', memberAccountIds: ['acc-2'] });
  await until(() => request(`/api/jobs/${job.jobId}`), value => value.status === 'finished');
  const group = (await request('/api/groups'))[0];
  expectedGroupId = group.id;
  await request(`/api/groups/${group.id}`, 'PATCH', { agentEnabled: true });
  async function runCase(label, expectedStatus, verify, triggerText = `${label}|trigger`) {
    const before = await request(`/api/groups/${group.id}/agent-runs`);
    const seen = new Set(before.map(run => run.id));
    await request(`/groups/${group.gatewayGroupId}/external-message`, 'POST', { senderPlatformUserId: `outside-${label}`, text: triggerText }, gateway);
    const list = await until(() => request(`/api/groups/${group.id}/agent-runs`), value => value.some(run => !seen.has(run.id) && run.status !== 'running'), 45000);
    const run = await request(`/api/agent-runs/${list.find(item => !seen.has(item.id)).id}`);
    assert.equal(run.status, expectedStatus, `${label}: ${JSON.stringify(run)}`);
    verify(run);
    console.log(JSON.stringify({ case: label, runId: run.id, status: run.status, endReason: run.endReason, steps: run.steps.map(step => ({ kind: step.kind, name: step.name, errorCode: step.errorCode, auditVerdict: step.auditVerdict })) }));
    return run;
  }
  await runCase('bad-json', 'failed', run => { assert.equal(run.endReason, 'protocol_errors'); assert.equal(run.steps.length, 3); assert(run.steps.every(step => step.errorCode === 'BAD_JSON' && step.rawResponse.includes('```'))); });
  await runCase('bad-large-unicode', 'failed', run => { assert(run.steps.every(step => Buffer.byteLength(step.rawResponse) <= 2048)); });
  for (const label of ['bad-shape', 'bad-count', 'http-error']) await runCase(label, 'failed', run => { assert.equal(run.endReason, 'protocol_errors'); assert(run.steps.every(step => step.kind === 'protocol_error' && step.errorCode === 'BAD_JSON')); });
  await runCase('turn-timeout', 'failed', run => { assert.equal(run.endReason, 'protocol_errors'); assert.equal(run.steps.length, 3); assert(run.steps.every(step => step.errorCode === 'TURN_TIMEOUT')); });
  await runCase('end-turn', 'finished', run => { assert.equal(run.endReason, 'final'); assert.equal(run.summary, 'ended without sending'); assert.equal(run.steps[0].kind, 'final'); });
  await runCase('unknown', 'finished', run => assert.equal(run.steps[0].errorCode, 'UNKNOWN_TOOL'));
  await runCase('invalid', 'finished', run => assert.equal(run.steps[0].errorCode, 'INVALID_INPUT'));
  await runCase('duplicate', 'finished', run => assert(run.steps.some(step => step.errorCode === 'DUPLICATE_TOOL_USE_ID')));
  const limitRun = await runCase('limit', 'finished', run => { assert.equal(run.steps[0].input.limit, 100000); assert(Buffer.byteLength(run.steps[0].resultSummary) <= 200); });
  await until(() => Number(sqlValue(`SELECT count(*) FROM websocket_events WHERE type='agent_run' AND payload->>'runId'='${limitRun.id}'`)), count => count >= limitRun.steps.length + 1);
  await runCase('audit-fail', 'finished', run => { assert.equal(run.steps[0].errorCode, 'AUDIT_REJECTED'); assert.equal(run.steps[0].auditVerdict, 'fail'); });
  await runCase('audit-blocked', 'blocked', run => { assert.equal(run.endReason, 'audit_blocked'); assert.equal(audits.get('blocked-audit'), 3); });
  for (const [label, text] of [['audit-invalid-json', 'invalid-audit-json'], ['audit-no-verdict', 'missing-audit-verdict'], ['audit-unknown-verdict', 'unknown-audit-verdict'], ['audit-slow', 'slow-audit']]) {
    await runCase(label, 'blocked', run => { assert.equal(run.endReason, 'audit_blocked'); assert.equal(audits.get(text), 3); });
  }
  await runCase('kick-denied', 'finished', run => assert.equal(run.steps[0].errorCode, 'POLICY_DENIED'));
  await runCase('budget', 'failed', run => { assert.equal(run.endReason, 'budget_exhausted'); assert.equal(run.steps.length, 12); });
  await request('/admin/send-fault', 'POST', { accountId: 'acc-1', code: 'NETWORK_TIMEOUT', accept: true }, gateway);
  await runCase('idem', 'finished', run => { assert.equal(run.steps[0].name, 'send_message'); assert.equal(run.steps[1].name, 'send_message'); assert.equal(audits.get('idempotent reply'), 1); assert.equal(run.steps[1].auditVerdict, null); });
  const sent = await request(`/admin/groups/${group.gatewayGroupId}/messages`, 'GET', undefined, gateway);
  assert.equal(sent.filter(message => message.text === 'idempotent reply').length, 1);
  const prior = await request(`/api/groups/${group.id}/agent-runs`);
  const priorIds = new Set(prior.map(run => run.id));
  await request(`/groups/${group.gatewayGroupId}/external-message`, 'POST', { senderPlatformUserId: 'outside-pending', text: 'pending|first' }, gateway);
  await until(() => request(`/api/groups/${group.id}/agent-runs`), list => list.some(run => !priorIds.has(run.id) && run.status === 'running'));
  await request(`/groups/${group.gatewayGroupId}/external-message`, 'POST', { senderPlatformUserId: 'outside-pending', text: 'pending|second' }, gateway);
  const twoRuns = await until(() => request(`/api/groups/${group.id}/agent-runs`), list => list.filter(run => !priorIds.has(run.id)).length >= 2 && list.filter(run => !priorIds.has(run.id)).every(run => run.status === 'finished'));
  const newRuns = twoRuns.filter(run => !priorIds.has(run.id));
  assert(newRuns[0].steps.length && newRuns[1].steps.length);
  console.log(JSON.stringify({ case: 'pending messages', runs: newRuns.slice(0, 2).map(run => ({ id: run.id, status: run.status })) }));
  await request(`/api/groups/${group.id}`, 'PATCH', { agentEnabled: false });
  for (let index = 0; index < 55; index++) await request(`/groups/${group.gatewayGroupId}/external-message`, 'POST', { msgId: `b${index}`, senderPlatformUserId: 'x', text: `bulk-${index}` }, gateway);
  await until(() => Number(sqlValue(`SELECT count(*) FROM messages WHERE group_id='${group.id}' AND text LIKE 'bulk-%'`)), count => count === 55);
  await request(`/api/groups/${group.id}`, 'PATCH', { agentEnabled: true });
  function recentResult(runId) {
    const history = JSON.parse(sqlValue(`SELECT history::text FROM agent_runs WHERE id='${runId}'`));
    const content = history.find(item => item.role === 'user' && item.content?.[0]?.type === 'tool_result')?.content[0].content;
    assert(content, 'tool_result is persisted in the run history');
    assert(Buffer.byteLength(content) <= 8192, 'tool_result content fits 8KB');
    return JSON.parse(content);
  }
  await runCase('limit-bulk', 'finished', run => { const result = recentResult(run.id); assert.equal(result.messages.length, 50); assert.equal(result.messages.at(-1).text, 'limit-bulk|trigger'); });
  await runCase('limit-long', 'finished', run => { const result = recentResult(run.id); assert.equal(result.truncated, true); assert(result.messages.some(message => message.text.startsWith('limit-long|') && message.text.length === 500)); assert(result.messages.length <= 50); }, `limit-long|${'x'.repeat(700)}`);
  const beforeRestartIds = new Set((await request(`/api/groups/${group.id}/agent-runs`)).map(run => run.id));
  await request(`/groups/${group.gatewayGroupId}/external-message`, 'POST', { senderPlatformUserId: 'outside-restart', text: 'restart-run|trigger' }, gateway);
  const restartList = await until(() => request(`/api/groups/${group.id}/agent-runs`), list => list.some(run => !beforeRestartIds.has(run.id) && run.status === 'running'));
  const pendingRestart = restartList.find(run => !beforeRestartIds.has(run.id) && run.status === 'running');
  await until(() => calls.get(pendingRestart.id) || 0, count => count === 1);
  backendProcess.kill('SIGKILL');
  await new Promise(resolve => backendProcess.once('exit', resolve));
  // The run's first context must survive a restart even if policy changes
  // while Backend is down; Agent service binds this exact context to runId.
  sqlValue(`UPDATE groups SET auto_kick_enabled=true WHERE id='${group.id}' RETURNING id`);
  backendProcess = launch('backend', ports.backend, { AGENT_TURN_TIMEOUT_MS: '10000' }); await ready(`${base}/api/health`);
  const resumed = await until(() => request(`/api/agent-runs/${pendingRestart.id}`), run => run.status === 'finished', 45000);
  assert.equal(resumed.summary, 'resumed after backend restart');
  assert.equal(calls.get(pendingRestart.id), 2);
  sqlValue(`UPDATE groups SET auto_kick_enabled=false WHERE id='${group.id}' RETURNING id`);
  console.log(JSON.stringify({ case: 'restart-run', runId: resumed.id, status: resumed.status, turns: calls.get(resumed.id) }));
  const beforeEffectIds = new Set((await request(`/api/groups/${group.id}/agent-runs`)).map(run => run.id));
  await request('/admin/send-fault', 'POST', { accountId: 'acc-1', code: 'NETWORK_TIMEOUT', accept: true }, gateway);
  await request(`/groups/${group.gatewayGroupId}/external-message`, 'POST', { senderPlatformUserId: 'outside-effect', text: 'restart-send|trigger' }, gateway);
  const effectList = await until(() => request(`/api/groups/${group.id}/agent-runs`), list => list.some(run => !beforeEffectIds.has(run.id) && run.status === 'running'));
  const effectRun = effectList.find(run => !beforeEffectIds.has(run.id) && run.status === 'running');
  await until(() => Number(sqlValue(`SELECT count(*) FROM agent_tool_effects WHERE run_id='${effectRun.id}' AND idempotency_key='restart-send-key'`)), count => count === 1);
  backendProcess.kill('SIGKILL');
  await new Promise(resolve => backendProcess.once('exit', resolve));
  backendProcess = launch('backend', ports.backend, { AGENT_TURN_TIMEOUT_MS: '10000' }); await ready(`${base}/api/health`);
  const resumedEffect = await until(() => request(`/api/agent-runs/${effectRun.id}`), run => run.status === 'finished', 45000);
  assert.equal(resumedEffect.summary, 'send resumed');
  assert.equal(audits.get('restart persistent reply'), 1);
  const effectsSent = await request(`/admin/groups/${group.gatewayGroupId}/messages`, 'GET', undefined, gateway);
  assert.equal(effectsSent.filter(message => message.text === 'restart persistent reply').length, 1);
  console.log(JSON.stringify({ case: 'restart-send', runId: resumedEffect.id, status: resumedEffect.status, audits: audits.get('restart persistent reply') }));
  const beforeCancel = await request(`/api/groups/${group.id}/agent-runs`);
  const beforeCancelIds = new Set(beforeCancel.map(run => run.id));
  await request(`/groups/${group.gatewayGroupId}/external-message`, 'POST', { senderPlatformUserId: 'outside-cancel', text: 'pending|cancel' }, gateway);
  const runningCancel = await until(() => request(`/api/groups/${group.id}/agent-runs`), list => list.some(run => !beforeCancelIds.has(run.id) && run.status === 'running'));
  await request(`/api/groups/${group.id}`, 'PATCH', { agentEnabled: false });
  const cancelled = await until(() => request(`/api/agent-runs/${runningCancel.find(run => !beforeCancelIds.has(run.id)).id}`), run => run.status === 'cancelled');
  assert.equal(cancelled.endReason, 'cancelled');
  await request(`/api/groups/${group.id}`, 'PATCH', { agentEnabled: true });
  for (const id of ['acc-1', 'acc-2']) await request(`/api/accounts/${id}/transition`, 'POST', { to: 'disconnected', expectedFrom: 'online' });
  await runCase('no-account', 'finished', run => assert.equal(run.steps[0].errorCode, 'NO_AVAILABLE_ACCOUNT'));
  for (const id of ['acc-1', 'acc-2']) await request(`/api/accounts/${id}/connect`, 'POST');
  await request(`/api/groups/${group.id}`, 'PATCH', { autoKickEnabled: true });
  await request('/admin/kick-fault', 'POST', { groupId: group.gatewayGroupId, convergeAfterMs: 500 }, gateway);
  await runCase('kick-retry', 'finished', run => { assert.equal(run.steps[0].name, 'kick_user'); assert.equal(run.steps[0].auditVerdict, 'pass'); assert.equal(run.steps[1].name, 'kick_user'); assert.equal(run.steps[1].auditVerdict, null); assert.equal(audits.get(JSON.stringify({ action: 'kick', platform_user_id: 'platform-2', reason: 'test' })), 1); });
  const membersAfterKick = await request(`/groups/${group.gatewayGroupId}/members`, 'GET', undefined, gateway);
  assert(!membersAfterKick.some(member => member.platformUserId === 'platform-2'));
  await request(`/groups/${group.gatewayGroupId}/write-status`, 'POST', { writable: false }, gateway);
  await runCase('send-unreachable', 'cancelled', run => { assert.equal(run.endReason, 'cancelled'); assert.equal(run.steps[0].errorCode, 'GROUP_UNREACHABLE'); });
  assert.equal((await request(`/api/groups/${group.id}`)).status, 'unreachable');
  console.log('Simulated Agent pipeline fault cases passed. Real external gateway users and real LLM were not tested.');
} finally {
  agent.close();
  for (const child of children) child.kill('SIGKILL');
  await Promise.all(children.map(child => child.exitCode === null && child.signalCode === null ? new Promise(resolve => child.once('exit', resolve)) : Promise.resolve()));
  sql(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
  fs.rmSync(state, { force: true });
}
