import express from 'express';
import { randomUUID } from 'crypto';
import fs from 'node:fs';
import path from 'node:path';
import cors from 'cors';
import multer from 'multer';

const app = express();
app.use(express.json());
// The Gateway debug console talks to this service directly from the browser.
app.use(cors({ origin: true }));
app.use((req, res, next) => {
  const traceId = req.header('x-trace-id') || randomUUID();
  res.setHeader('x-trace-id', traceId);
  const started = Date.now();
  res.on('finish', () => console.log(JSON.stringify({ event: 'http_request', service: 'gateway', traceId, method: req.method, path: req.path, status: res.statusCode, durationMs: Date.now() - started })));
  next();
});
app.use((req, res, next) => {
  if (req.header('x-simulate-unavailable') === '1' && !req.path.startsWith('/admin/')) return error(res, 503, 'SERVICE_UNAVAILABLE');
  next();
});
const port = Number(process.env.PORT || 4001);
const mediaDirectory = path.resolve(process.env.GATEWAY_MEDIA_DIR || path.join(process.cwd(), 'media_gateway'));
const mediaMaxBytes = Math.max(1024, Number(process.env.GATEWAY_MEDIA_MAX_BYTES || 10 * 1024 * 1024));
const mediaRetentionDays = Math.max(0, Number(process.env.GATEWAY_MEDIA_RETENTION_DAYS || 30));
const mediaPublicUrl = (process.env.GATEWAY_PUBLIC_URL || `http://127.0.0.1:${port}`).replace(/\/$/, '');

type Account = { id: string; platformUserId: string | null; status: string; rateLimitedUntil?: number };
type GatewayUserRecord = { id: string; platformUserId: string; displayName: string; createdAt: string; updatedAt: string };
type UserProfile = { displayName: string; updatedAt: string };
type Group = { id: string; owner: string; members: Set<string>; admins: Set<string>; messages: any[]; writable: boolean };
type Invite = { link: string; groupId: string; readyAt: number; expiresAt: number };
type GatewayMedia = { id: string; storedName: string; fileName: string; contentType: string; size: number; createdAt: string; expiresAt: number };
type PublicMedia = { id: string; url: string; fileName: string; contentType: string; size: number };

const stateFile = process.env.GATEWAY_STATE_FILE || path.resolve(import.meta.dirname, '..', 'data', 'state.json');
const saved = fs.existsSync(stateFile) ? JSON.parse(fs.readFileSync(stateFile, 'utf8')) : null;
const accounts = new Map<string, Account>(saved?.accounts || []);
if (!saved) for (let i = 1; i <= 5; i++) accounts.set(`acc-${i}`, { id: `acc-${i}`, platformUserId: null, status: 'idle' });
const gatewayUsers = new Map<string, GatewayUserRecord>(saved?.gatewayUsers || saved?.externalAccounts || []);
if (!saved?.gatewayUsers && !saved?.externalAccounts) for (let i = 1; i <= 3; i++) {
  const now = new Date().toISOString();
  const id = `user-${i}`;
  gatewayUsers.set(id, { id, platformUserId: id, displayName: `用户 ${i}`, createdAt: now, updatedAt: now });
}
for (const value of gatewayUsers.values()) {
  const legacy = /^外部访客\s*(\d+)$/.exec(value.displayName);
  if (legacy) value.displayName = `用户 ${legacy[1]}`;
}
const userProfiles = new Map<string, UserProfile>(saved?.userProfiles || []);
function platformId(account: Account) { return account.platformUserId ?? `platform-${account.id.replace(/^acc-/, '')}`; }
const groups = new Map<string, Group>((saved?.groups || []).map(([id, value]: [string, any]) => [id, { ...value, members: new Set(value.members), admins: new Set(value.admins) }]));
const invites = new Map<string, Invite>(saved?.invites || []);
const events: any[] = saved?.events || [];
const createRequests = new Map<string, string>(saved?.createRequests || []);
fs.mkdirSync(mediaDirectory, { recursive: true });
const media = new Map<string, GatewayMedia>();
for (const [id, raw] of saved?.media || []) {
  const storedName = typeof raw.storedName === 'string' && /^[A-Za-z0-9-]+$/.test(raw.storedName) ? raw.storedName : id;
  const destination = path.join(mediaDirectory, storedName);
  if (typeof raw.base64 === 'string' && !fs.existsSync(destination)) fs.writeFileSync(destination, Buffer.from(raw.base64, 'base64'));
  const exists = fs.existsSync(destination);
  const stat = exists ? fs.statSync(destination) : null;
  media.set(id, {
    id,
    storedName,
    fileName: typeof raw.fileName === 'string' && raw.fileName ? raw.fileName : `media-${id}`,
    contentType: typeof raw.contentType === 'string' ? raw.contentType : 'application/octet-stream',
    size: Number(raw.size || stat?.size || 0),
    createdAt: typeof raw.createdAt === 'string' ? raw.createdAt : new Date(stat?.birthtimeMs || stat?.mtimeMs || Date.now()).toISOString(),
    expiresAt: exists ? Number(raw.expiresAt || Date.now() + mediaRetentionDays * 86400000) : 0,
  });
}
const sendFaults = new Map<string, { code: string; accept: boolean }>(saved?.sendFaults || []);
const sendDelays = new Map<string, number>(saved?.sendDelays || []);
const kickFaults = new Map<string, number>(saved?.kickFaults || []);
const clients = new Set<express.Response>();
let eventId = Number(saved?.eventId || 0);
type PendingAction = { id: string; dueAt: number; kind: 'join' | 'send'; data: Record<string, any> };
const pending: PendingAction[] = saved?.pending || [];
function recoverRateLimit(account: Account) {
  setTimeout(() => {
    if (accounts.get(account.id) !== account) return;
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
  fs.writeFileSync(temp, JSON.stringify({ eventId, accounts: [...accounts], gatewayUsers: [...gatewayUsers], userProfiles: [...userProfiles], groups: [...groups].map(([id, group]) => [id, { ...group, members: [...group.members], admins: [...group.admins] }]), invites: [...invites], events, createRequests: [...createRequests], media: [...media], sendFaults: [...sendFaults], sendDelays: [...sendDelays], kickFaults: [...kickFaults], pending }));
  fs.renameSync(temp, stateFile);
}
function complete(action: PendingAction) {
  const group = groups.get(action.data.groupId);
  if (action.kind === 'send' && action.data.media) {
    const stored = media.get(action.data.media.id);
    if (!stored || stored.expiresAt <= Date.now() || !fs.existsSync(path.join(mediaDirectory, stored.storedName))) {
      delete action.data.media;
      action.data.failCode = 'MEDIA_NOT_FOUND';
    }
  }
  if (group && action.kind === 'join' && !group.members.has(action.data.platformUserId)) {
    group.members.add(action.data.platformUserId);
    emit('member_joined', { groupId: group.id, platformUserId: action.data.platformUserId });
  }
  if (group && action.kind === 'send' && action.data.failCode) {
    emit('message_failed', { groupId: group.id, clientMsgId: action.data.clientMsgId, code: action.data.failCode });
    if (action.data.failCode === 'ACCOUNT_SUSPENDED' || action.data.failCode === 'SESSION_EXPIRED') {
      const account = accountByPlatform(action.data.senderPlatformUserId);
      if (account && account.status !== 'suspended' && account.status !== 'session_expired') {
        account.status = action.data.failCode === 'ACCOUNT_SUSPENDED' ? 'suspended' : 'session_expired';
        emit('account_status', { accountId: account.id, status: account.status });
        for (const memberGroup of groups.values()) if (memberGroup.members.delete(action.data.senderPlatformUserId)) emit('member_left', { groupId: memberGroup.id, platformUserId: action.data.senderPlatformUserId });
      }
    }
  } else if (group && action.kind === 'send' && !group.messages.some(message => message.msgId === action.data.msgId)) {
    group.messages.push(action.data);
    emit('message_sent', { groupId: group.id, clientMsgId: action.data.clientMsgId, msgId: action.data.msgId, sentAt: action.data.sentAt });
    emit('message', {
      groupId: group.id,
      msgId: action.data.msgId,
      senderPlatformUserId: action.data.senderPlatformUserId,
      text: action.data.text,
      sentAt: action.data.sentAt,
      ...(action.data.media ? { media: action.data.media, mediaUrl: action.data.media.url } : {}),
    });
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
function publicMedia(value: GatewayMedia): PublicMedia {
  return { id: value.id, url: `${mediaPublicUrl}/media/${value.id}`, fileName: value.fileName, contentType: value.contentType, size: value.size };
}
function cleanupExpiredMedia() {
  let changed = false;
  for (const [id, value] of media) {
    if (value.expiresAt > Date.now()) continue;
    try { fs.unlinkSync(path.join(mediaDirectory, value.storedName)); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        console.error(JSON.stringify({ event: 'gateway_media_cleanup_failed', mediaId: id, error: String(error) }));
        continue;
      }
    }
    media.delete(id);
    for (const group of groups.values()) for (const message of group.messages) {
      if (message.media?.id === id) { delete message.media; delete message.mediaUrl; changed = true; }
    }
    for (const event of events) {
      if (event.media?.id === id) { delete event.media; delete event.mediaUrl; changed = true; }
    }
    for (const action of pending) {
      if (action.data.media?.id === id) { delete action.data.media; action.data.failCode = 'MEDIA_NOT_FOUND'; changed = true; }
    }
    changed = true;
  }
  if (changed) persist();
}
function mediaFromBody(body: any): PublicMedia | undefined {
  if (body?.mediaId === undefined || body.mediaId === null || body.mediaId === '') return undefined;
  if (typeof body.mediaId !== 'string') return undefined;
  const value = media.get(body.mediaId);
  if (!value || value.expiresAt <= Date.now() || !fs.existsSync(path.join(mediaDirectory, value.storedName))) return undefined;
  return publicMedia(value);
}
function error(res: express.Response, status: number, code: string, extra: Record<string, unknown> = {}) {
  return res.status(status).json({ code, ...extra });
}
function accountStatusError(res: express.Response, account: Account) {
  if (account.status === 'suspended') return error(res, 403, 'ACCOUNT_SUSPENDED');
  if (account.status === 'session_expired') return error(res, 401, 'SESSION_EXPIRED');
  if (account.status !== 'online' && account.status !== 'rate_limited') return error(res, 409, 'ACCOUNT_OFFLINE');
  return null;
}
function accountFor(id: string) { return accounts.get(id); }
function accountByPlatform(id: string) { return [...accounts.values()].find((a) => a.platformUserId === id); }
function groupFor(id: string) { return groups.get(id); }
function isRateLimited(account: Account) { return !!account.rateLimitedUntil && account.rateLimitedUntil > Date.now(); }
function validUserId(value: unknown): value is string { return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/.test(value); }
function userIdConflict(value: string) { return [...accounts.values()].some(account => account.platformUserId === value || platformId(account) === value) || [...gatewayUsers.values()].some(account => account.platformUserId === value); }
function userFor(id: string) {
  const account = accounts.get(id);
  if (account) return { kind: 'account' as const, account, id: account.id, platformUserId: platformId(account) };
  const user = gatewayUsers.get(id);
  if (user) return { kind: 'user' as const, user, id: user.id, platformUserId: user.platformUserId };
  return null;
}
function userByPlatformId(platformUserId: string) {
  for (const id of [...accounts.keys(), ...gatewayUsers.keys()]) {
    const user = publicUser(id);
    if (user?.platformUserId === platformUserId) return user;
  }
  return null;
}
function publicUser(id: string) {
  const value = userFor(id);
  if (!value) return null;
  if (value.kind === 'account') {
    const profile = userProfiles.get(value.id);
    return { id: value.id, platformUserId: value.platformUserId, displayName: profile?.displayName || value.id, status: value.account.status, capabilities: ['edit', 'delete', 'join', 'leave', 'send', 'create_group', 'operate_group'] };
  }
  return { id: value.id, platformUserId: value.platformUserId, displayName: value.user.displayName, status: 'online', capabilities: ['edit', 'delete', 'join', 'leave', 'send', 'create_group', 'operate_group'] };
}
function allPublicUsers() { return [...accounts.keys(), ...gatewayUsers.keys()].map(publicUser).filter(Boolean); }
function removeUserFromGroups(platformUserId: string) {
  for (const group of groups.values()) {
    if (!group.members.delete(platformUserId)) continue;
    group.admins.delete(platformUserId);
    emit('member_left', { groupId: group.id, platformUserId });
  }
}

app.get('/health', (_req, res) => res.json({ ok: true, eventId }));
app.get('/accounts', (_req, res) => res.json([...accounts.values()]));
app.put('/accounts/:id', (req, res) => {
  const id = String(req.params.id);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{1,63}$/.test(id)) return error(res, 400, 'VALIDATION_ERROR');
  const existing = accounts.get(id);
  if (existing) return res.json(existing);
  if (userIdConflict(`platform-${id.replace(/^acc-/, '')}`)) return error(res, 409, 'PLATFORM_USER_ID_CONFLICT');
  const account: Account = { id, platformUserId: null, status: 'idle' };
  accounts.set(id, account);
  persist();
  return res.status(201).json(account);
});
app.delete('/accounts/:id', (req, res) => {
  const account = accounts.get(String(req.params.id));
  if (!account) return res.json({ deleted: true });
  const pid = platformId(account);
  if ([...groups.values()].some(group => group.owner === pid && group.members.has(pid))) return error(res, 409, 'ACCOUNT_OWNS_GROUP');
  accounts.delete(account.id);
  for (const group of groups.values()) {
    if (!group.members.delete(pid)) continue;
    group.admins.delete(pid);
    emit('member_left', { groupId: group.id, platformUserId: pid });
  }
  persist();
  return res.json({ deleted: true });
});

// The Gateway console uses one user resource. The protocol-level /accounts
// endpoints remain available to Backend, but that implementation detail is not
// exposed in the console's data model.
app.get('/users', (_req, res) => res.json(allPublicUsers()));
app.post('/users', (req, res) => {
  const displayName = typeof req.body?.displayName === 'string' ? req.body.displayName.trim() : '';
  const platformUserId = req.body?.platformUserId === undefined || req.body.platformUserId === '' ? `user-${randomUUID()}` : req.body.platformUserId;
  if (!displayName || displayName.length > 80 || !validUserId(platformUserId)) return error(res, 400, 'VALIDATION_ERROR');
  if (userIdConflict(platformUserId)) return error(res, 409, 'PLATFORM_USER_ID_CONFLICT');
  const now = new Date().toISOString();
  const user = { id: `user-${randomUUID()}`, platformUserId, displayName, createdAt: now, updatedAt: now };
  gatewayUsers.set(user.id, user);
  persist();
  return res.status(201).json(publicUser(user.id));
});
app.get('/users/:id', (req, res) => {
  const user = publicUser(req.params.id);
  return user ? res.json(user) : error(res, 404, 'USER_NOT_FOUND');
});
app.patch('/users/:id', (req, res) => {
  const value = userFor(req.params.id);
  const displayName = typeof req.body?.displayName === 'string' ? req.body.displayName.trim() : '';
  if (!value) return error(res, 404, 'USER_NOT_FOUND');
  if (!displayName || displayName.length > 80 || Object.keys(req.body || {}).some(key => key !== 'displayName')) return error(res, 400, 'VALIDATION_ERROR');
  if (value.kind === 'account') userProfiles.set(value.id, { displayName, updatedAt: new Date().toISOString() });
  else { value.user.displayName = displayName; value.user.updatedAt = new Date().toISOString(); }
  persist();
  return res.json(publicUser(value.id));
});
app.delete('/users/:id', (req, res) => {
  const value = userFor(req.params.id);
  if (!value) return error(res, 404, 'USER_NOT_FOUND');
  if ([...groups.values()].some(group => group.owner === value.platformUserId && group.members.has(value.platformUserId))) return error(res, 409, 'USER_OWNS_GROUP');
  removeUserFromGroups(value.platformUserId);
  userProfiles.delete(value.id);
  if (value.kind === 'account') {
    accounts.delete(value.id);
    emit('account_status', { accountId: value.id, status: 'session_expired' });
  } else gatewayUsers.delete(value.id);
  persist();
  return res.json({ deleted: true });
});
const publicGroup = (group: Group) => ({ id: group.id, owner: group.owner, members: [...group.members], admins: [...group.admins], writable: group.writable, messageCount: group.messages.length });
app.get('/groups', (_req, res) => res.json([...groups.values()].map(publicGroup)));
app.get('/groups/:id', (req, res) => { const group = groupFor(req.params.id); return group ? res.json(publicGroup(group)) : error(res, 404, 'NOT_FOUND'); });
app.get('/groups/:id/messages', (req, res) => { const group = groupFor(req.params.id); return group ? res.json([...group.messages].sort((a, b) => String(a.sentAt).localeCompare(String(b.sentAt)) || String(a.msgId).localeCompare(String(b.msgId)))) : error(res, 404, 'NOT_FOUND'); });
app.get('/admin/events', (req, res) => res.json(events.filter(event => !req.query.msgId || event.msgId === req.query.msgId)));
app.post('/admin/events/inject', (req, res) => {
  const { type, ...payload } = req.body || {};
  if (!['message_failed', 'account_status', 'member_joined', 'member_left'].includes(type) || !payload || typeof payload !== 'object') return error(res, 400, 'VALIDATION_ERROR');
  emit(type, payload);
  return res.status(202).json({ eventId });
});
app.post('/admin/events/:id/replay', (req, res) => { const event = events.find(item => item.eventId === Number(req.params.id)); if (!event) return res.sendStatus(404); for (const client of clients) client.write(`id: ${event.eventId}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`); return res.json({ replayed: true }); });
app.post('/admin/events/:id/redeliver', (req, res) => { const prior = events.find(item => item.eventId === Number(req.params.id)); if (!prior) return res.sendStatus(404); const event = { ...prior, eventId: ++eventId }; events.push(event); persist(); for (const client of clients) client.write(`id: ${event.eventId}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`); return res.json({ eventId: event.eventId }); });
app.post('/admin/send-fault', (req, res) => { if (typeof req.body.accountId !== 'string' || !['NETWORK_TIMEOUT', 'SERVICE_UNAVAILABLE'].includes(req.body.code)) return error(res, 400, 'VALIDATION_ERROR'); sendFaults.set(req.body.accountId, { code: req.body.code, accept: req.body.accept === true }); persist(); return res.json({ armed: true }); });
app.post('/admin/send-delay', (req, res) => { if (typeof req.body.accountId !== 'string' || !Number.isInteger(req.body.delayMs) || req.body.delayMs < 0 || req.body.delayMs > 5000) return error(res, 400, 'VALIDATION_ERROR'); sendDelays.set(req.body.accountId, req.body.delayMs); persist(); return res.json({ armed: true }); });
app.post('/admin/kick-fault', (req, res) => { if (typeof req.body.groupId !== 'string' || !groupFor(req.body.groupId)) return error(res, 400, 'VALIDATION_ERROR'); kickFaults.set(req.body.groupId, Math.min(2000, Math.max(0, Number(req.body.convergeAfterMs ?? 500)))); persist(); return res.json({ armed: true }); });
app.delete('/admin/groups/:id', (req, res) => {
  if (!groups.delete(req.params.id)) return error(res, 404, 'NOT_FOUND');
  for (const [link, invite] of invites) if (invite.groupId === req.params.id) invites.delete(link);
  for (let index = pending.length - 1; index >= 0; index--) if (pending[index].data.groupId === req.params.id) pending.splice(index, 1);
  persist();
  return res.json({ deleted: true });
});
app.get('/admin/groups/:id/messages', (req, res) => res.json(groupFor(req.params.id)?.messages || []));
app.get('/accounts/:id', (req, res) => { const account = accountFor(req.params.id); return account ? res.json(account) : error(res, 404, 'NOT_FOUND'); });
app.post('/accounts/:id/connect', (req, res) => {
  const account = accountFor(req.params.id); if (!account) return error(res, 404, 'NOT_FOUND');
  if (account.status === 'suspended') return error(res, 403, 'ACCOUNT_SUSPENDED');
  if (account.status === 'session_expired') return error(res, 401, 'SESSION_EXPIRED');
  account.platformUserId ??= platformId(account);
  if (!isRateLimited(account)) { account.status = 'online'; account.rateLimitedUntil = undefined; }
  persist();
  return res.json({ platformUserId: account.platformUserId });
});
app.post('/accounts/:id/disconnect', (req, res) => {
  const account = accountFor(req.params.id); if (!account) return error(res, 404, 'NOT_FOUND');
  if (account.status === 'suspended' || account.status === 'session_expired') return accountStatusError(res, account);
  account.status = 'disconnected';
  persist();
  return res.json({});
});
app.post('/accounts/:id/status', (req, res) => {
  const account = accountFor(req.params.id); if (!account) return error(res, 404, 'NOT_FOUND');
  const nextStatus = req.body.status;
  if (nextStatus !== 'suspended' && nextStatus !== 'session_expired') return error(res, 400, 'VALIDATION_ERROR');
  if (account.status === 'suspended' || account.status === 'session_expired') {
    if (account.status === nextStatus) return res.json({ status: account.status });
    return accountStatusError(res, account)!;
  }
  account.status = nextStatus;
  emit('account_status', { accountId: account.id, status: account.status });
  if (account.status === 'suspended' || account.status === 'session_expired') {
    const pid = account.platformUserId;
    if (pid) for (const group of groups.values()) if (group.members.delete(pid)) emit('member_left', { groupId: group.id, platformUserId: pid });
  }
  persist();
  return res.json({ status: account.status });
});
app.post('/accounts/:id/rate-limit', (req, res) => {
  const account = accountFor(req.params.id); if (!account) return error(res, 404, 'NOT_FOUND');
  if (account.status === 'suspended' || account.status === 'session_expired') return accountStatusError(res, account);
  const seconds = Math.max(1, Number(req.body.retryAfterSeconds || 5)); account.status = 'rate_limited'; account.rateLimitedUntil = Date.now() + seconds * 1000;
  persist();
  recoverRateLimit(account);
  return res.json({ retryAfterSeconds: seconds });
});

app.post('/groups', (req, res) => {
  const account = accountFor(req.body.creatorAccountId); if (!account) return error(res, 409, 'ACCOUNT_OFFLINE');
  const statusError = accountStatusError(res, account); if (statusError) return statusError;
  if (req.body.clientJobId && createRequests.has(req.body.clientJobId)) return res.json({ groupId: createRequests.get(req.body.clientJobId) });
  const id = `gw-${randomUUID()}`; const pid = platformId(account); groups.set(id, { id, owner: pid, members: new Set([pid]), admins: new Set(), messages: [], writable: true });
  if (req.body.clientJobId) createRequests.set(req.body.clientJobId, id);
  persist();
  return res.json({ groupId: id });
});
app.post('/users/:id/groups', (req, res) => {
  const user = userFor(req.params.id);
  if (!user) return error(res, 404, 'USER_NOT_FOUND');
  if (user.kind === 'account') { const statusError = accountStatusError(res, user.account); if (statusError) return statusError; }
  if (req.body?.clientJobId && createRequests.has(req.body.clientJobId)) return res.json({ groupId: createRequests.get(req.body.clientJobId) });
  const id = `gw-${randomUUID()}`;
  groups.set(id, { id, owner: user.platformUserId, members: new Set([user.platformUserId]), admins: new Set(), messages: [], writable: true });
  if (req.body?.clientJobId) createRequests.set(req.body.clientJobId, id);
  persist();
  return res.status(201).json({ groupId: id });
});
app.post('/groups/:id/invite', (req, res) => {
  if (!groupFor(req.params.id)) return res.sendStatus(404);
  const link = `invite-${randomUUID()}`; const readyAfterMs = Math.max(0, Number(req.body.readyAfterMs ?? process.env.INVITE_READY_AFTER_MS ?? 0));
  invites.set(link, { link, groupId: req.params.id, readyAt: Date.now() + readyAfterMs, expiresAt: Date.now() + Number(req.body.ttlMs ?? process.env.INVITE_TTL_MS ?? 60000) });
  persist();
  return res.json({ inviteLink: link, readyAfterMs });
});
app.post('/groups/:id/join', (req, res) => {
  const group = groupFor(req.params.id); const account = accountFor(req.body.accountId); const invite = invites.get(req.body.inviteLink);
  if (!group || !account || !invite) return error(res, 404, 'NOT_FOUND');
  if (invites.get(req.body.inviteLink)?.link !== invite.link || invite.groupId && invite.groupId !== group.id) return error(res, 404, 'NOT_FOUND');
  if (Date.now() >= invite.expiresAt) return error(res, 410, 'INVITE_EXPIRED');
  if (Date.now() < invite.readyAt) return error(res, 409, 'INVITE_NOT_READY');
  const statusError = accountStatusError(res, account); if (statusError) return statusError;
  if (group.members.has(platformId(account))) return error(res, 409, 'ALREADY_MEMBER');
  if (req.body.neverArrive === true) return res.status(202).json({ accepted: true });
  schedule('join', { groupId: group.id, platformUserId: platformId(account) }, Number(req.body.joinDelayMs ?? process.env.JOIN_DELAY_MS ?? 100));
  return res.status(202).json({ accepted: true });
});
app.post('/groups/:id/promote', (req, res) => {
  const group = groupFor(req.params.id); const by = accountFor(req.body.byAccountId); const target = accountFor(req.body.accountId);
  if (!group || !by || !target) return res.sendStatus(404);
  const byError = accountStatusError(res, by); if (byError) return byError;
  const targetError = accountStatusError(res, target); if (targetError) return targetError;
  if (by.platformUserId !== group.owner) return error(res, 403, 'NO_PERMISSION');
  if (!group.members.has(platformId(target))) return error(res, 409, 'NOT_MEMBER_YET');
  group.admins.add(platformId(target)); persist(); return res.json({});
});
app.post('/groups/:id/promote-user', (req, res) => {
  const group = groupFor(req.params.id); const by = userFor(req.body?.byUserId); const target = userFor(req.body?.targetUserId);
  if (!group) return error(res, 404, 'GROUP_NOT_FOUND');
  if (!by || !target) return error(res, 404, 'USER_NOT_FOUND');
  if (by.platformUserId !== group.owner) return error(res, 403, 'NO_PERMISSION');
  if (!group.members.has(target.platformUserId)) return error(res, 409, 'NOT_MEMBER_YET');
  group.admins.add(target.platformUserId); persist(); return res.json({ promoted: true });
});
app.get('/groups/:id/members', (req, res) => {
  const group = groupFor(req.params.id);
  if (!group) return error(res, 404, 'NOT_FOUND');
  return res.json([...group.members].map(platformUserId => {
    const user = userByPlatformId(platformUserId);
    return {
      platformUserId,
      userId: user?.id || null,
      displayName: user?.displayName || platformUserId,
      role: platformUserId === group.owner ? 'creator' : group.admins.has(platformUserId) ? 'admin' : 'member',
    };
  }));
});
app.post('/users/:id/groups/:groupId/join', (req, res) => {
  const user = userFor(req.params.id); const group = groupFor(req.params.groupId);
  if (!user) return error(res, 404, 'USER_NOT_FOUND');
  if (!group) return error(res, 404, 'GROUP_NOT_FOUND');
  if (group.members.has(user.platformUserId)) return res.json({ joined: true, alreadyMember: true, groupId: group.id, platformUserId: user.platformUserId });
  if (user.kind === 'user') {
    group.members.add(user.platformUserId);
    emit('member_joined', { groupId: group.id, platformUserId: user.platformUserId });
    return res.status(201).json({ joined: true, groupId: group.id, platformUserId: user.platformUserId });
  }
  const invite = invites.get(req.body?.inviteLink);
  if (!invite || invite.groupId !== group.id) return error(res, 404, 'INVITE_NOT_FOUND');
  if (Date.now() >= invite.expiresAt) return error(res, 410, 'INVITE_EXPIRED');
  if (Date.now() < invite.readyAt) return error(res, 409, 'INVITE_NOT_READY', { readyAfterMs: invite.readyAt - Date.now() });
  const statusError = accountStatusError(res, user.account); if (statusError) return statusError;
  schedule('join', { groupId: group.id, platformUserId: user.platformUserId }, Number(req.body?.joinDelayMs ?? process.env.JOIN_DELAY_MS ?? 100));
  return res.status(202).json({ joined: true, accepted: true, groupId: group.id, platformUserId: user.platformUserId });
});
app.post('/users/:id/groups/:groupId/leave', (req, res) => {
  const user = userFor(req.params.id); const group = groupFor(req.params.groupId);
  if (!user) return error(res, 404, 'USER_NOT_FOUND');
  if (!group) return error(res, 404, 'GROUP_NOT_FOUND');
  if (user.kind === 'account') { const statusError = accountStatusError(res, user.account); if (statusError) return statusError; }
  if (!group.members.delete(user.platformUserId)) return res.json({ left: true, alreadyLeft: true, groupId: group.id, platformUserId: user.platformUserId });
  group.admins.delete(user.platformUserId);
  emit('member_left', { groupId: group.id, platformUserId: user.platformUserId });
  return res.json({ left: true, groupId: group.id, platformUserId: user.platformUserId });
});
app.post('/groups/:id/kick', (req, res) => {
  const group = groupFor(req.params.id); const by = accountFor(req.body.byAccountId); if (!group || !by) return res.sendStatus(404);
  const byError = accountStatusError(res, by); if (byError) return byError;
  if (!group.members.has(group.owner)) return error(res, 409, 'OWNER_LEFT');
  if (platformId(by) !== group.owner && !group.admins.has(platformId(by))) return error(res, 403, 'NO_PERMISSION');
  const target = req.body.targetPlatformUserId;
  const armedDelay = kickFaults.get(group.id);
  if (armedDelay !== undefined) { kickFaults.delete(group.id); persist(); }
  const timeout = req.body.simulateTimeout === true || armedDelay !== undefined;
  const waitMs = Math.max(0, Number(req.body.delayMs ?? process.env.KICK_DELAY_MS ?? 0));
  const remove = () => { if (group.members.delete(target)) emit('member_left', { groupId: group.id, platformUserId: target }); persist(); };
  if (timeout) { setTimeout(remove, armedDelay ?? Math.min(2000, Math.max(0, Number(req.body.convergeAfterMs ?? 500)))); return error(res, 504, 'NETWORK_TIMEOUT'); }
  remove();
  if (waitMs) return setTimeout(() => res.json({ kicked: true }), waitMs);
  return res.json({ kicked: true });
});
app.post('/groups/:id/kick-user', (req, res) => {
  const group = groupFor(req.params.id); const by = userFor(req.body?.byUserId); const target = userFor(req.body?.targetUserId);
  if (!group) return error(res, 404, 'GROUP_NOT_FOUND');
  if (!by || !target) return error(res, 404, 'USER_NOT_FOUND');
  if (!group.members.has(group.owner)) return error(res, 409, 'OWNER_LEFT');
  if (by.platformUserId !== group.owner && !group.admins.has(by.platformUserId)) return error(res, 403, 'NO_PERMISSION');
  if (group.members.delete(target.platformUserId)) emit('member_left', { groupId: group.id, platformUserId: target.platformUserId });
  group.admins.delete(target.platformUserId); persist();
  return res.json({ kicked: true });
});
app.post('/groups/:id/leave', (req, res) => { const group = groupFor(req.params.id); const account = accountFor(req.body.accountId); if (!group || !account) return res.sendStatus(404); const statusError = accountStatusError(res, account); if (statusError) return statusError; if (req.body.fail === true) return error(res, 500, 'LEAVE_FAILED'); if (group.members.delete(platformId(account))) emit('member_left', { groupId: group.id, platformUserId: platformId(account) }); persist(); return res.json({}); });

function sendFromAccount(req: express.Request, res: express.Response, group: Group, account: Account) {
  if (req.body.simulateError) return error(res, Number(req.body.simulateStatus || 504), req.body.simulateError, req.body.retryAfterSeconds ? { retryAfterSeconds: req.body.retryAfterSeconds } : {});
  if (account.status === 'suspended') return error(res, 403, 'ACCOUNT_SUSPENDED');
  if (account.status === 'session_expired') return error(res, 401, 'SESSION_EXPIRED');
  if (isRateLimited(account)) { const seconds = Math.ceil((account.rateLimitedUntil! - Date.now()) / 1000); account.rateLimitedUntil = Date.now() + seconds * 1000; persist(); return error(res, 429, 'RATE_LIMITED', { retryAfterSeconds: seconds }); }
  if (account.status !== 'online') return error(res, 409, 'ACCOUNT_OFFLINE');
  if (!group.writable) return error(res, 403, 'GROUP_WRITE_FORBIDDEN');
  if (!group.members.has(platformId(account))) return error(res, 403, 'SENDER_NOT_IN_GROUP');
  const attachedMedia = mediaFromBody(req.body);
  if (req.body?.mediaId && !attachedMedia) return error(res, 400, 'MEDIA_NOT_FOUND');
  if ((typeof req.body?.text !== 'string' || !req.body.text.trim()) && !attachedMedia) return error(res, 400, 'VALIDATION_ERROR');
  const text = typeof req.body?.text === 'string' ? req.body.text.trim() : '';
  if (text.length > 5000) return error(res, 400, 'VALIDATION_ERROR');
  req.body.text = text;
  const msgId = `msg-${randomUUID()}`; const sentAt = new Date().toISOString();
  const fault = sendFaults.get(account.id);
  if (fault) { sendFaults.delete(account.id); persist(); if (fault.accept) schedule('send', { groupId: group.id, msgId, clientMsgId: req.body.clientMsgId, senderPlatformUserId: platformId(account), text, sentAt, traceId: req.header('x-trace-id'), ...(attachedMedia ? { media: attachedMedia } : {}) }, 1500); return error(res, fault.code === 'SERVICE_UNAVAILABLE' ? 503 : 504, fault.code); }
  if (req.body.simulateTimeout) {
    if (req.body.acceptOnTimeout === true) schedule('send', { groupId: group.id, msgId, clientMsgId: req.body.clientMsgId, senderPlatformUserId: platformId(account), text, sentAt, traceId: req.header('x-trace-id'), ...(attachedMedia ? { media: attachedMedia } : {}) }, Number(req.body.settleDelayMs ?? 1500));
    return error(res, 504, 'NETWORK_TIMEOUT');
  }
  const data: Record<string, any> = { groupId: group.id, msgId, clientMsgId: req.body.clientMsgId, senderPlatformUserId: platformId(account), text, sentAt, traceId: req.header('x-trace-id'), ...(attachedMedia ? { media: attachedMedia } : {}) };
  if (req.body.simulateFailed === true) data.failCode = req.body.failCode === 'ACCOUNT_SUSPENDED' ? 'ACCOUNT_SUSPENDED' : 'GROUP_WRITE_FORBIDDEN';
  const armedDelay = sendDelays.get(account.id);
  if (armedDelay !== undefined) { sendDelays.delete(account.id); persist(); }
  schedule('send', data, Number(req.body.delayMs ?? armedDelay ?? process.env.SEND_EVENT_DELAY_MS ?? 100));
  const respond = () => res.status(202).json({ accepted: true });
  const responseDelay = Math.max(0, Number(req.body.responseDelayMs ?? process.env.SEND_RESPONSE_DELAY_MS ?? 0));
  return responseDelay ? setTimeout(respond, responseDelay) : respond();
}
app.post('/groups/:id/send', (req, res) => {
  const group = groupFor(req.params.id); const account = accountFor(req.body.accountId); if (!group || !account) return res.sendStatus(404);
  return sendFromAccount(req, res, group, account);
});
app.post('/users/:id/groups/:groupId/messages', (req, res) => {
  const user = userFor(req.params.id); const group = groupFor(req.params.groupId);
  if (!user) return error(res, 404, 'USER_NOT_FOUND');
  if (!group) return error(res, 404, 'GROUP_NOT_FOUND');
  const text = typeof req.body?.text === 'string' ? req.body.text.trim() : '';
  const attachedMedia = mediaFromBody(req.body);
  if (req.body?.mediaId && !attachedMedia) return error(res, 400, 'MEDIA_NOT_FOUND');
  if ((!text && !attachedMedia) || text.length > 5000) return error(res, 400, 'VALIDATION_ERROR');
  req.body.text = text;
  if (user.kind === 'account') {
    req.body.clientMsgId = typeof req.body.clientMsgId === 'string' && req.body.clientMsgId ? req.body.clientMsgId : randomUUID();
    return sendFromAccount(req, res, group, user.account);
  }
  if (!group.members.has(user.platformUserId)) return error(res, 409, 'NOT_MEMBER');
  if (!group.writable) return error(res, 403, 'GROUP_WRITE_FORBIDDEN');
  const msgId = `msg-${randomUUID()}`;
  const sentAt = new Date().toISOString();
  const message = { groupId: group.id, msgId, senderPlatformUserId: user.platformUserId, text, sentAt, ...(attachedMedia ? { media: attachedMedia, mediaUrl: attachedMedia.url } : {}) };
  group.messages.push(message);
  emit('message', message);
  return res.status(202).json({ accepted: true, deliveryStatus: 'sent', msgId, sentAt });
});
app.get('/groups/:id/messages/by-client-id/:client', (req, res) => { const group = groupFor(req.params.id); const message = group?.messages.filter(m => m.clientMsgId === req.params.client).sort((a, b) => Date.parse(a.sentAt) - Date.parse(b.sentAt))[0]; return message ? res.json({ msgId: message.msgId, sentAt: message.sentAt }) : res.sendStatus(404); });
const mediaUpload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, done) => done(null, mediaDirectory),
    filename: (_req, _file, done) => done(null, randomUUID()),
  }),
  limits: { fileSize: mediaMaxBytes, files: 1 },
});
app.post('/media', mediaUpload.single('file'), (req, res) => {
  let id: string;
  let storedName: string;
  let fileName: string;
  let contentType: string;
  let size: number;
  if (req.file) {
    id = req.file.filename;
    storedName = req.file.filename;
    fileName = path.basename(req.file.originalname || `media-${id}`).replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 255) || `media-${id}`;
    contentType = req.file.mimetype || 'application/octet-stream';
    size = req.file.size;
  } else {
    // JSON base64 remains available for protocol fixtures; browser clients use multipart.
    const base64 = req.body?.base64;
    contentType = req.body?.contentType;
    if (typeof base64 !== 'string' || typeof contentType !== 'string' || !/^[\w.+-]+\/[\w.+-]+$/.test(contentType)) return error(res, 400, 'VALIDATION_ERROR');
    const bytes = Buffer.from(base64, 'base64');
    if (bytes.length > mediaMaxBytes) return error(res, 413, 'MEDIA_TOO_LARGE');
    id = randomUUID();
    storedName = id;
    fileName = typeof req.body.fileName === 'string' && req.body.fileName ? path.basename(req.body.fileName).slice(0, 255) : `media-${id}`;
    size = bytes.length;
    fs.writeFileSync(path.join(mediaDirectory, storedName), bytes, { flag: 'wx' });
  }
  const now = new Date();
  const requestedTtl = Number(req.body?.ttlSeconds);
  const ttlMs = Number.isFinite(requestedTtl) && requestedTtl > 0 ? requestedTtl * 1000 : mediaRetentionDays * 86400000;
  const expiresAt = now.getTime() + ttlMs;
  const value: GatewayMedia = { id, storedName, fileName, contentType, size, createdAt: now.toISOString(), expiresAt };
  media.set(id, value);
  persist();
  const result = publicMedia(value);
  return res.status(201).json({ media: result, mediaUrl: result.url });
});
app.get('/media/:id', (req, res) => {
  const value = media.get(req.params.id);
  if (!value || value.expiresAt <= Date.now()) return res.sendStatus(404);
  const filePath = path.join(mediaDirectory, value.storedName);
  if (!fs.existsSync(filePath)) { media.delete(req.params.id); persist(); return res.sendStatus(404); }
  res.type(value.contentType);
  res.setHeader('Content-Length', String(value.size));
  res.setHeader('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(value.fileName)}`);
  return res.sendFile(filePath);
});
app.post('/groups/:id/external-message', (req, res) => {
  const group = groupFor(req.params.id); if (!group) return res.sendStatus(404);
  const msgId = req.body.msgId || `external-${randomUUID()}`;
  const sentAt = req.body.sentAt || new Date().toISOString();
  const senderPlatformUserId = req.body.senderPlatformUserId || `external-${randomUUID()}`;
  const suppliedUrl = req.body.mediaUrl ? String(req.body.mediaUrl) : undefined;
  const ownedMedia = suppliedUrl ? [...media.values()].find(value => publicMedia(value).url === suppliedUrl && value.expiresAt > Date.now()) : undefined;
  const attachedMedia = mediaFromBody(req.body) || (ownedMedia ? publicMedia(ownedMedia) : undefined);
  const mediaUrl = attachedMedia?.url || suppliedUrl;
  const suppliedMedia = req.body?.media && typeof req.body.media === 'object' ? req.body.media : undefined;
  const message = { groupId: group.id, msgId, senderPlatformUserId, text: String(req.body.text || ''), sentAt, ...(mediaUrl ? { mediaUrl, media: attachedMedia || { ...suppliedMedia, url: mediaUrl } } : {}) };
  group.messages.push(message);
  emit('message', message);
  return res.status(202).json({ msgId, sentAt });
});
app.post('/groups/:id/external-member', (req, res) => {
  const group = groupFor(req.params.id); if (!group) return error(res, 404, 'NOT_FOUND');
  const platformUserId = typeof req.body.platformUserId === 'string' && req.body.platformUserId ? req.body.platformUserId : `external-${randomUUID()}`;
  if (req.body.action === 'joined') {
    if (!group.members.has(platformUserId)) { group.members.add(platformUserId); emit('member_joined', { groupId: group.id, platformUserId }); }
  } else if (req.body.action === 'left') {
    if (group.members.delete(platformUserId)) emit('member_left', { groupId: group.id, platformUserId });
  } else return error(res, 400, 'VALIDATION_ERROR');
  persist();
  return res.status(202).json({ platformUserId, action: req.body.action });
});
app.post('/groups/:id/write-status', (req, res) => { const group = groupFor(req.params.id); if (!group) return res.sendStatus(404); group.writable = req.body.writable === true; persist(); return res.json({ writable: group.writable }); });
app.get('/events', (req, res) => {
  const since = req.query.since === undefined ? eventId : Number(req.query.since);
  if (!Number.isSafeInteger(since) || since < 0) return error(res, 400, 'VALIDATION_ERROR');
  res.setHeader('Content-Type', 'text/event-stream'); res.setHeader('Cache-Control', 'no-cache'); res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();
  for (const event of events.filter(e => e.eventId > since)) res.write(`id: ${event.eventId}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
  clients.add(res); req.on('close', () => clients.delete(res));
});

const host = process.env.HOST || '127.0.0.1';
cleanupExpiredMedia();
setInterval(cleanupExpiredMedia, 60_000).unref();
app.use((errorValue: unknown, _req: express.Request, res: express.Response, next: express.NextFunction) => {
  if (errorValue instanceof multer.MulterError) return error(res, errorValue.code === 'LIMIT_FILE_SIZE' ? 413 : 400, errorValue.code === 'LIMIT_FILE_SIZE' ? 'MEDIA_TOO_LARGE' : 'VALIDATION_ERROR');
  return next(errorValue);
});
app.listen(port, host, () => console.log(`gateway listening ${host}:${port}`));
