import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { anthropicTurn } from './anthropic.js';

const app = express();
app.use(express.json({ limit: '256kb' }));
const port = Number(process.env.PORT || 4002);
const sessionFile = process.env.AGENT_SESSION_FILE || path.resolve(import.meta.dirname, '..', 'data', 'sessions.json');
type Session = { contextHash: string; turns: number; createdAt: string };
const sessions = new Map<string, Session>(fs.existsSync(sessionFile) ? JSON.parse(fs.readFileSync(sessionFile, 'utf8')) : []);
function persist() {
  fs.mkdirSync(path.dirname(sessionFile), { recursive: true });
  const temporary = `${sessionFile}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify([...sessions]));
  fs.renameSync(temporary, sessionFile);
}
const signatures: Record<string, string[]> = {
  get_recent_messages: ['limit'], send_message: ['text', 'idempotency_key'],
  kick_user: ['platform_user_id', 'reason'], finish: ['summary'],
};
function validTools(tools: unknown): boolean {
  if (!Array.isArray(tools) || tools.length !== 4) return false;
  const names = tools.map(tool => tool?.name);
  if (new Set(names).size !== 4 || names.some(name => !(name in signatures))) return false;
  return tools.every(tool => tool.input_schema?.type === 'object' && Array.isArray(tool.input_schema.required)
    && signatures[tool.name].every(input => tool.input_schema.required.includes(input) && tool.input_schema.properties?.[input]));
}
function tool(name: string, input: Record<string, unknown>) {
  return { stop_reason: 'tool_use', content: [{ type: 'tool_use', id: `tu-${randomUUID()}`, name, input }] };
}
function final(text: string) { return { stop_reason: 'end_turn', content: [{ type: 'text', text }] }; }
function parseContext(messages: any[]): any {
  const first = messages?.[0]?.content?.[0];
  if (messages?.[0]?.role !== 'user' || first?.type !== 'text') throw Error('CONTEXT_INVALID');
  const context = JSON.parse(first.text);
  if (typeof context.groupId !== 'string' || !Array.isArray(context.triggerMessages) || !Array.isArray(context.ownPlatformUserIds)) throw Error('CONTEXT_INVALID');
  return context;
}
function lastResult(messages: any[]): { name: string; result: any } | null {
  for (let i = messages.length - 1; i > 0; i--) {
    const item = messages[i];
    if (item.role !== 'user' || item.content?.[0]?.type !== 'tool_result') continue;
    const use = messages[i - 1]?.content?.[0];
    if (use?.type !== 'tool_use' || use.id !== item.content[0].tool_use_id) throw Error('HISTORY_INVALID');
    let result: any;
    try { result = JSON.parse(item.content[0].content); } catch { result = { code: 'BAD_TOOL_RESULT' }; }
    return { name: use.name, result };
  }
  return null;
}
app.post('/agent/turn', async (req, res) => {
  if (process.env.ENABLE_FAULT_INJECTION === 'true') await new Promise(resolve => setTimeout(resolve, Math.max(0, Number(process.env.AGENT_TURN_DELAY_MS || 0))));
  const { runId, tools, messages } = req.body || {};
  if (typeof runId !== 'string' || !runId || !validTools(tools)) return res.status(400).json({ code: 'TOOLS_INVALID' });
  if (!Array.isArray(messages) || !messages.length) return res.status(400).json({ code: 'MESSAGES_INVALID' });
  try {
    const context = parseContext(messages);
    const contextHash = createHash('sha256').update(messages[0].content[0].text).digest('hex');
    const existing = sessions.get(runId);
    if (existing && existing.contextHash !== contextHash) return res.status(409).json({ code: 'RUN_CONTEXT_CONFLICT' });
    sessions.set(runId, { contextHash, turns: Math.max(existing?.turns || 0, Math.ceil((messages.length + 1) / 2)), createdAt: existing?.createdAt || new Date().toISOString() });
    persist();
    if (process.env.AGENT_PROVIDER === 'anthropic') return res.json(await anthropicTurn({ runId, tools, messages }));
    const previous = lastResult(messages);
    if (!previous) return res.json(tool('get_recent_messages', { limit: 20 }));
    if (previous.name === 'get_recent_messages') {
      const messagesInGroup = Array.isArray(previous.result.messages) ? previous.result.messages : context.triggerMessages;
      const incoming = [...messagesInGroup].reverse().find((message: any) => !message.isOwn && !context.ownPlatformUserIds.includes(message.senderPlatformUserId) && typeof message.text === 'string');
      if (!incoming) return res.json(final('没有需要回复的外部消息'));
      if (context.policy?.autoKickEnabled && /\b(spam|scam|phishing)\b|广告|诈骗/i.test(incoming.text)) {
        return res.json(tool('kick_user', { platform_user_id: incoming.senderPlatformUserId, reason: '自动审核识别到骚扰或诈骗消息' }));
      }
      const reply = `收到：${incoming.text.slice(0, 200)}`;
      return res.json(tool('send_message', { text: reply, idempotency_key: `reply:${incoming.msgId || createHash('sha256').update(reply).digest('hex')}` }));
    }
    if (previous.name === 'send_message') return res.json(tool('finish', { summary: previous.result.code ? `回复未送达：${previous.result.code}` : '已回复群消息' }));
    if (previous.name === 'kick_user') return res.json(tool('finish', { summary: previous.result.kicked ? '已移除违规成员' : `移除失败：${previous.result.code}` }));
    return res.json(final('处理完成'));
  } catch (error) {
    return res.status(process.env.AGENT_PROVIDER === 'anthropic' ? 502 : 400).json({ code: process.env.AGENT_PROVIDER === 'anthropic' ? 'MODEL_UNAVAILABLE' : 'CONTEXT_INVALID', message: String(error) });
  }
});
app.post('/agent/audit', (req, res) => {
  const text = req.body?.text;
  const groupId = req.body?.groupId;
  if (typeof text !== 'string' || typeof groupId !== 'string') return res.status(400).json({ code: 'VALIDATION_ERROR' });
  const forbidden = text.length > 2000 || /(?:password|api[_ -]?key|私钥|密码)\s*[:=]/i.test(text);
  return res.json({ verdict: forbidden ? 'fail' : 'pass', reason: forbidden ? '内容包含敏感凭据或超过长度限制' : '符合内容策略' });
});
app.get('/health', (_req, res) => res.json({ ok: true, service: 'agent-service' }));
app.listen(port, () => console.log(`agent listening ${port}`));
