import { spawn, spawnSync } from 'node:child_process';
import { strict as assert } from 'node:assert';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const port = 4523;
const base = `http://127.0.0.1:${port}`;
const sessionFile = `/tmp/agent-contract-${randomUUID()}.json`;
const child = spawn(process.execPath, [path.join(root, 'agent-service/dist/index.js')], { cwd: root, env: { ...process.env, PORT: String(port), AGENT_PROVIDER: 'mock', AGENT_SESSION_FILE: sessionFile }, stdio: ['ignore', 'pipe', 'pipe'] });
child.stdout.on('data', chunk => process.stdout.write(`[agent-service] ${chunk}`));
child.stderr.on('data', chunk => process.stderr.write(`[agent-service] ${chunk}`));
const tools = [
  ['get_recent_messages', { limit: { type: 'number' } }],
  ['send_message', { text: { type: 'string' }, idempotency_key: { type: 'string' } }],
  ['kick_user', { platform_user_id: { type: 'string' }, reason: { type: 'string' } }],
  ['finish', { summary: { type: 'string' } }],
].map(([name, properties]) => ({ name, description: String(name), input_schema: { type: 'object', properties, required: Object.keys(properties) } }));
const context = { groupId: 'g-test', triggerMessages: [{ msgId: 'm-1', senderPlatformUserId: 'outside', text: 'hello', sentAt: '2026-09-27T00:00:00.000Z' }], policy: { autoKickEnabled: false }, ownPlatformUserIds: ['own'] };
const messages = [{ role: 'user', content: [{ type: 'text', text: JSON.stringify(context) }] }];
function curl(label, endpoint, data, expectedStatus) {
  const command = ['-sS', '-i', '-X', 'POST', `${base}${endpoint}`, '-H', 'content-type: application/json', '--data-binary', JSON.stringify(data)];
  const result = spawnSync('curl', command, { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const [header, body] = result.stdout.split('\r\n\r\n');
  const status = Number(header.match(/^HTTP\/1\.1 (\d+)/m)?.[1]);
  assert.equal(status, expectedStatus, `${label}: ${result.stdout}`);
  const parsed = JSON.parse(body);
  console.log(JSON.stringify({ case: label, request: `curl -X POST ${base}${endpoint}`, status, response: parsed }));
  return parsed;
}
try {
  for (let i = 0; i < 100; i++) { try { if ((await fetch(`${base}/health`)).ok) break; } catch {} await delay(50); }
  const runId = randomUUID();
  const first = curl('initial tool_use', '/agent/turn', { runId, tools, messages }, 200);
  assert.equal(first.stop_reason, 'tool_use'); assert.equal(first.content.length, 1);
  assert.equal(first.content[0].name, 'get_recent_messages');
  const resultHistory = [...messages, { role: 'assistant', content: first.content }, { role: 'user', content: [{ type: 'tool_result', tool_use_id: first.content[0].id, content: JSON.stringify({ messages: [{ ...context.triggerMessages[0], isOwn: false }], truncated: false }) }] }];
  const second = curl('tool_result history', '/agent/turn', { runId, tools, messages: resultHistory }, 200);
  assert.equal(second.content[0].name, 'send_message');
  const laterMessage = { msgId: 'm-2', senderPlatformUserId: 'new-outside', text: 'later message', sentAt: '2026-09-27T00:00:01.000Z', isOwn: false };
  const withLaterMessage = [...messages, { role: 'assistant', content: first.content }, { role: 'user', content: [{ type: 'tool_result', tool_use_id: first.content[0].id, content: JSON.stringify({ messages: [{ ...context.triggerMessages[0], isOwn: false }, laterMessage], truncated: false }) }] }];
  const boundToTrigger = curl('new message does not replace trigger', '/agent/turn', { runId, tools, messages: withLaterMessage }, 200);
  assert.equal(boundToTrigger.content[0].input.idempotency_key, 'reply:m-1');
  const missing = structuredClone(tools); missing.pop();
  assert.equal(curl('missing tool', '/agent/turn', { runId: randomUUID(), tools: missing, messages }, 400).code, 'TOOLS_INVALID');
  const missingRequired = structuredClone(tools); missingRequired[1].input_schema.required = ['text'];
  assert.equal(curl('required incomplete', '/agent/turn', { runId: randomUUID(), tools: missingRequired, messages }, 400).code, 'TOOLS_INVALID');
  const invalidSchema = structuredClone(tools); invalidSchema[0].input_schema.properties.limit.type = 'unknown-type';
  assert.equal(curl('invalid JSON Schema', '/agent/turn', { runId: randomUUID(), tools: invalidSchema, messages }, 400).code, 'TOOLS_INVALID');
  const wrongType = structuredClone(tools); wrongType[0].input_schema.properties.limit.type = 'string';
  assert.equal(curl('wrong parameter type', '/agent/turn', { runId: randomUUID(), tools: wrongType, messages }, 400).code, 'TOOLS_INVALID');
  const changed = structuredClone(messages); changed[0].content[0].text = JSON.stringify({ ...context, groupId: 'another' });
  assert.equal(curl('runId context conflict', '/agent/turn', { runId, tools, messages: changed }, 409).code, 'RUN_CONTEXT_CONFLICT');
  assert.equal(curl('audit pass', '/agent/audit', { text: 'hello', groupId: 'g-test' }, 200).verdict, 'pass');
  assert.equal(curl('audit fail', '/agent/audit', { text: 'password: secret', groupId: 'g-test' }, 200).verdict, 'fail');
  assert.equal(curl('audit invalid input', '/agent/audit', { text: 1, groupId: 'g-test' }, 400).code, 'VALIDATION_ERROR');
  console.log('Agent service contract cases passed.');
} finally {
  child.kill('SIGKILL');
  if (child.exitCode === null && child.signalCode === null) await new Promise(resolve => child.once('exit', resolve));
  fs.rmSync(sessionFile, { force: true });
}
