import express from 'express';
import cors from 'cors';
import { randomUUID } from 'crypto';
import fs from 'node:fs';
import path from 'node:path';

const app = express();
app.use(cors());
app.use(express.json());
const port = Number(process.env.PORT || 4001);

type Account = { id: string; platformUserId: string; status: string; rateLimitedUntil?: number };
type Group = { id: string; owner: string; members: Set<string>; admins: Set<string>; messages: any[]; writable: boolean };
type Invite = { link: string; readyAt: number; expiresAt: number };

const stateFile = process.env.GATEWAY_STATE_FILE || path.resolve(import.meta.dirname, '..', 'data', 'state.json');
const saved = fs.existsSync(stateFile) ? JSON.parse(fs.readFileSync(stateFile, 'utf8')) : null;
const accounts = new Map<string, Account>(saved?.accounts || []);
for (let i = 1; i <= 5; i++) if (!accounts.has(`acc-${i}`)) accounts.set(`acc-${i}`, { id: `acc-${i}`, platformUserId: `platform-${i}`, status: 'idle' });
const groups = new Map<string, Group>((saved?.groups || []).map(([id, value]: [string, any]) => [id, { ...value, members: new Set(value.members), admins: new Set(value.admins) }]));
const invites = new Map<string, Invite>(saved?.invites || []);
const events: any[] = saved?.events || [];
const createRequests = new Map<string, string>(saved?.createRequests || []);
const media = new Map<string, { base64: string; contentType: string; expiresAt: number }>(saved?.media || []);
const sendFaults = new Map<string, { code: string; accept: boolean }>(saved?.sendFaults || []);
const clients = new Set<express.Response>();
let eventId = Number(saved?.eventId || 0);
type PendingAction = { id: string; dueAt: number; kind: 'join' | 'send'; data: Record<string, any> };
const pending: PendingAction[] = saved?.pending || [];
function recoverRateLimit(account: Account) {
  setTimeout(() => {
    if (account.status !== 'rate_limited') return;
    if (isRateLimited(account)) { recoverRateLimit(account); return; }
    account.status = 'online'; account.rateLimitedUntil = undefined;
    emit('account_status', { accountId: account.id, status: 'online' });
  }, Math.max(0, Number(account.rateLimitedUntil || 0) - Date.now()) + 20);
}
for (const account of accounts.values()) if (account.status === 'rate_limited') recoverRateLimit(account);
function persist() {
  fs.mkdirSync(path.dirname(stateFile), { recursive: true });
  const temp = `${stateFile}.${process.pid}.tmp`;
  fs.writeFileSync(temp, JSON.stringify({ eventId, accounts: [...accounts], groups: [...groups].map(([id, group]) => [id, { ...group, members: [...group.members], admins: [...group.admins] }]), invites: [...invites], events, createRequests: [...createRequests], media: [...media], sendFaults: [...sendFaults], pending }));
  fs.renameSync(temp, stateFile);
}
function complete(action: PendingAction) {
  const group = groups.get(action.data.groupId);
  if (group && action.kind === 'join' && !group.members.has(action.data.platformUserId)) {
    group.members.add(action.data.platformUserId);
    emit('member_joined', { groupId: group.id, platformUserId: action.data.platformUserId });
  }
  if (group && action.kind === 'send' && !group.messages.some(message => message.msgId === action.data.msgId)) {
    group.messages.push(action.data);
    emit('message_sent', { groupId: group.id, clientMsgId: action.data.clientMsgId, msgId: action.data.msgId, sentAt: action.data.sentAt });
    emit('message', { groupId: group.id, msgId: action.data.msgId, senderPlatformUserId: action.data.senderPlatformUserId, text: action.data.text, sentAt: action.data.sentAt });
  }
  const index = pending.findIndex(item => item.id === action.id);
  if (index >= 0) pending.splice(index, 1);
  persist();
}
function schedule(kind: PendingAction['kind'], data: PendingAction['data'], delayMs: number) {
  const action = { id: randomUUID(), dueAt: Date.now() + delayMs, kind, data };
  pending.push(action);
  persist();
  setTimeout(() => complete(action), delayMs);
}
for (const action of [...pending]) setTimeout(() => complete(action), Math.max(0, action.dueAt - Date.now()));

function emit(type: string, payload: Record<string, unknown>) {
  const event = { eventId: ++eventId, type, ...payload };
  events.push(event);
  persist();
  for (const response of clients) response.write(`id: ${event.eventId}\nevent: ${type}\ndata: ${JSON.stringify(event)}\n\n`);
}
function error(res: express.Response, status: number, code: string, extra: Record<string, unknown> = {}) {
  return res.status(status).json({ code, ...extra });
}
function accountFor(id: string) { return accounts.get(id); }
function accountByPlatform(id: string) { return [...accounts.values()].find((a) => a.platformUserId === id); }
function groupFor(id: string) { return groups.get(id); }
function isRateLimited(account: Account) { return !!account.rateLimitedUntil && account.rateLimitedUntil > Date.now(); }

app.get('/health', (_req, res) => res.json({ ok: true }));
app.get('/admin/events', (req, res) => res.json(events.filter(event => !req.query.msgId || event.msgId === req.query.msgId)));
app.post('/admin/events/:id/replay', (req, res) => { const event = events.find(item => item.eventId === Number(req.params.id)); if (!event) return res.sendStatus(404); for (const client of clients) client.write(`id: ${event.eventId}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`); return res.json({ replayed: true }); });
app.post('/admin/send-fault', (req, res) => { if (typeof req.body.accountId !== 'string' || !['NETWORK_TIMEOUT', 'SERVICE_UNAVAILABLE'].includes(req.body.code)) return error(res, 400, 'VALIDATION_ERROR'); sendFaults.set(req.body.accountId, { code: req.body.code, accept: req.body.accept === true }); persist(); return res.json({ armed: true }); });
app.get('/admin/groups/:id/messages', (req, res) => res.json(groupFor(req.params.id)?.messages || []));
app.get('/accounts/:id', (req, res) => { const account = accountFor(req.params.id); return account ? res.json(account) : error(res, 404, 'NOT_FOUND'); });
app.post('/accounts/:id/connect', (req, res) => {
  const account = accountFor(req.params.id); if (!account) return error(res, 404, 'NOT_FOUND');
  if (account.status === 'suspended') return error(res, 403, 'ACCOUNT_SUSPENDED');
  if (account.status === 'session_expired') return error(res, 401, 'SESSION_EXPIRED');
  account.status = 'online'; account.rateLimitedUntil = undefined;
  persist();
  return res.json({ platformUserId: account.platformUserId });
});
app.post('/accounts/:id/disconnect', (req, res) => {
  const account = accountFor(req.params.id); if (!account) return error(res, 404, 'NOT_FOUND');
  account.status = 'disconnected';
  for (const group of groups.values()) if (group.members.delete(account.platformUserId)) emit('member_left', { groupId: group.id, platformUserId: account.platformUserId });
  persist();
  return res.json({});
});
app.post('/accounts/:id/status', (req, res) => {
  const account = accountFor(req.params.id); if (!account) return error(res, 404, 'NOT_FOUND');
  account.status = req.body.status;
  emit('account_status', { accountId: account.id, status: account.status });
  if (account.status === 'suspended' || account.status === 'session_expired') {
    for (const group of groups.values()) if (group.members.delete(account.platformUserId)) emit('member_left', { groupId: group.id, platformUserId: account.platformUserId });
  }
  persist();
  return res.json({ status: account.status });
});
app.post('/accounts/:id/rate-limit', (req, res) => {
  const account = accountFor(req.params.id); if (!account) return error(res, 404, 'NOT_FOUND');
  const seconds = Math.max(1, Number(req.body.retryAfterSeconds || 5)); account.status = 'rate_limited'; account.rateLimitedUntil = Date.now() + seconds * 1000;
  persist();
  recoverRateLimit(account);
  return res.json({ retryAfterSeconds: seconds });
});

app.post('/groups', (req, res) => {
  const account = accountFor(req.body.creatorAccountId); if (!account || account.status !== 'online') return error(res, 409, 'ACCOUNT_OFFLINE');
  if (req.body.clientJobId && createRequests.has(req.body.clientJobId)) return res.json({ groupId: createRequests.get(req.body.clientJobId) });
  const id = `gw-${randomUUID()}`; groups.set(id, { id, owner: account.platformUserId, members: new Set([account.platformUserId]), admins: new Set(), messages: [], writable: true });
  if (req.body.clientJobId) createRequests.set(req.body.clientJobId, id);
  persist();
  return res.json({ groupId: id });
});
app.post('/groups/:id/invite', (req, res) => {
  if (!groupFor(req.params.id)) return res.sendStatus(404);
  const link = `invite-${randomUUID()}`; const readyAfterMs = Math.max(0, Number(req.body.readyAfterMs ?? process.env.INVITE_READY_AFTER_MS ?? 0));
  invites.set(link, { link, readyAt: Date.now() + readyAfterMs, expiresAt: Date.now() + Number(process.env.INVITE_TTL_MS || 60000) });
  persist();
  return res.json({ inviteLink: link, readyAfterMs });
});
app.post('/groups/:id/join', (req, res) => {
  const group = groupFor(req.params.id); const account = accountFor(req.body.accountId); const invite = invites.get(req.body.inviteLink);
  if (!group || !account || !invite) return error(res, 404, 'NOT_FOUND');
  if (Date.now() < invite.readyAt) return error(res, 409, 'INVITE_NOT_READY');
  if (Date.now() >= invite.expiresAt) return error(res, 410, 'INVITE_EXPIRED');
  if (account.status !== 'online') return error(res, 409, 'ACCOUNT_OFFLINE');
  if (group.members.has(account.platformUserId)) return error(res, 409, 'ALREADY_MEMBER');
  if (req.body.neverArrive === true) return res.status(202).json({ accepted: true });
  schedule('join', { groupId: group.id, platformUserId: account.platformUserId }, Number(req.body.joinDelayMs || 100));
  return res.status(202).json({ accepted: true });
});
app.post('/groups/:id/promote', (req, res) => {
  const group = groupFor(req.params.id); const by = accountFor(req.body.byAccountId); const target = accountFor(req.body.accountId);
  if (!group || !by || !target) return res.sendStatus(404);
  if (by.platformUserId !== group.owner) return error(res, 403, 'NO_PERMISSION');
  if (!group.members.has(target.platformUserId)) return error(res, 409, 'NOT_MEMBER_YET');
  group.admins.add(target.platformUserId); persist(); return res.json({});
});
app.get('/groups/:id/members', (req, res) => { const group = groupFor(req.params.id); return res.json(group ? [...group.members].map(platformUserId => ({ platformUserId })) : []); });
app.post('/groups/:id/kick', (req, res) => {
  const group = groupFor(req.params.id); const by = accountFor(req.body.byAccountId); if (!group || !by) return res.sendStatus(404);
  if (!group.members.has(group.owner)) return error(res, 409, 'OWNER_LEFT');
  if (by.platformUserId !== group.owner && !group.admins.has(by.platformUserId)) return error(res, 403, 'NO_PERMISSION');
  group.members.delete(req.body.targetPlatformUserId); emit('member_left', { groupId: group.id, platformUserId: req.body.targetPlatformUserId }); persist(); return res.json({ kicked: true });
});
app.post('/groups/:id/leave', (req, res) => { const group = groupFor(req.params.id); const account = accountFor(req.body.accountId); if (!group || !account) return res.sendStatus(404); if (req.body.fail === true) return error(res, 500, 'LEAVE_FAILED'); group.members.delete(account.platformUserId); emit('member_left', { groupId: group.id, platformUserId: account.platformUserId }); persist(); return res.json({}); });

app.post('/groups/:id/send', (req, res) => {
  const group = groupFor(req.params.id); const account = accountFor(req.body.accountId); if (!group || !account) return res.sendStatus(404);
  if (req.body.simulateError) return error(res, Number(req.body.simulateStatus || 504), req.body.simulateError, req.body.retryAfterSeconds ? { retryAfterSeconds: req.body.retryAfterSeconds } : {});
  if (account.status === 'suspended') return error(res, 403, 'ACCOUNT_SUSPENDED');
  if (account.status === 'session_expired') return error(res, 401, 'SESSION_EXPIRED');
  if (isRateLimited(account)) { const seconds = Math.ceil((account.rateLimitedUntil! - Date.now()) / 1000); account.rateLimitedUntil = Date.now() + seconds * 1000; persist(); return error(res, 429, 'RATE_LIMITED', { retryAfterSeconds: seconds }); }
  if (account.status !== 'online') return error(res, 409, 'ACCOUNT_OFFLINE');
  if (!group.writable) return error(res, 403, 'GROUP_WRITE_FORBIDDEN');
  if (!group.members.has(account.platformUserId)) return error(res, 403, 'SENDER_NOT_IN_GROUP');
  const msgId = `msg-${randomUUID()}`; const sentAt = new Date().toISOString();
  const fault = sendFaults.get(account.id);
  if (fault) { sendFaults.delete(account.id); persist(); if (fault.accept) schedule('send', { groupId: group.id, msgId, clientMsgId: req.body.clientMsgId, senderPlatformUserId: account.platformUserId, text: req.body.text, sentAt }, 1500); return error(res, fault.code === 'SERVICE_UNAVAILABLE' ? 503 : 504, fault.code); }
  if (req.body.simulateTimeout) return error(res, 504, 'NETWORK_TIMEOUT');
  schedule('send', { groupId: group.id, msgId, clientMsgId: req.body.clientMsgId, senderPlatformUserId: account.platformUserId, text: req.body.text, sentAt }, Number(req.body.delayMs || 100));
  return res.status(202).json({ accepted: true });
});
app.get('/groups/:id/messages/by-client-id/:client', (req, res) => { const group = groupFor(req.params.id); const message = group?.messages.find(m => m.clientMsgId === req.params.client); return message ? res.json({ msgId: message.msgId, sentAt: message.sentAt }) : res.sendStatus(404); });
app.post('/media', (req, res) => {
  const base64 = req.body?.base64;
  const contentType = req.body?.contentType;
  if (typeof base64 !== 'string' || typeof contentType !== 'string' || !/^[\w.+-]+\/[\w.+-]+$/.test(contentType) || base64.length > 14_000_000) return error(res, 400, 'VALIDATION_ERROR');
  const id = randomUUID();
  media.set(id, { base64, contentType, expiresAt: Date.now() + Math.max(1, Number(req.body.ttlSeconds || 3600)) * 1000 });
  persist();
  return res.status(201).json({ mediaUrl: `http://127.0.0.1:${port}/media/${id}` });
});
app.get('/media/:id', (req, res) => {
  const value = media.get(req.params.id);
  if (!value || value.expiresAt < Date.now()) return res.sendStatus(404);
  return res.type(value.contentType).send(Buffer.from(value.base64, 'base64'));
});
app.post('/groups/:id/external-message', (req, res) => {
  const group = groupFor(req.params.id); if (!group) return res.sendStatus(404);
  const msgId = req.body.msgId || `external-${randomUUID()}`;
  const sentAt = req.body.sentAt || new Date().toISOString();
  const senderPlatformUserId = req.body.senderPlatformUserId || `external-${randomUUID()}`;
  const message = { groupId: group.id, msgId, senderPlatformUserId, text: String(req.body.text || ''), sentAt, ...(req.body.mediaUrl ? { mediaUrl: String(req.body.mediaUrl) } : {}) };
  group.messages.push(message);
  emit('message', message);
  return res.status(202).json({ msgId, sentAt });
});
app.post('/groups/:id/write-status', (req, res) => { const group = groupFor(req.params.id); if (!group) return res.sendStatus(404); group.writable = req.body.writable === true; persist(); return res.json({ writable: group.writable }); });
app.get('/events', (req, res) => { res.setHeader('Content-Type', 'text/event-stream'); res.setHeader('Cache-Control', 'no-cache'); const since = req.query.since === undefined ? eventId : Number(req.query.since); for (const event of events.filter(e => e.eventId > since)) res.write(`id: ${event.eventId}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`); clients.add(res); req.on('close', () => clients.delete(res)); });

app.listen(port, () => console.log(`gateway listening ${port}`));
