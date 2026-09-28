import type { Application, RequestHandler } from 'express';
import type { Pool } from 'pg';
import { AccountTransitionError, transitionAccount, isTerminal, type AccountStatus } from './state.js';

const ACCOUNT_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{1,63}$/;

export function registerAccountRoutes(
  app: Application,
  pool: Pool,
  gatewayUrl: string,
  broadcast: (type: string, payload: any) => void,
  auth: RequestHandler,
  write: RequestHandler,
) {
  const selectAccount = `SELECT id,display_name AS "displayName",status,
    platform_user_id AS "platformUserId",rate_limited_until AS "rateLimitedUntil"
    FROM accounts WHERE id=$1 AND deleted_at IS NULL`;

  app.get('/api/accounts', auth, async (_req, res) => {
    const result = await pool.query(`SELECT id,display_name AS "displayName",status,
      platform_user_id AS "platformUserId",rate_limited_until AS "rateLimitedUntil"
      FROM accounts WHERE deleted_at IS NULL ORDER BY id`);
    res.json(result.rows);
  });

  app.post('/api/accounts', auth, write, async (req, res) => {
    const id = typeof req.body?.id === 'string' ? req.body.id.trim() : '';
    const displayName = typeof req.body?.displayName === 'string' ? req.body.displayName.trim() : '';
    if (!ACCOUNT_ID.test(id) || displayName.length > 80) return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: '账号 ID 需为 2–64 位字母、数字或 ._:-，名称最多 80 字', requestId: req.requestId } });
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      if ((await client.query('SELECT 1 FROM accounts WHERE id=$1', [id])).rowCount) {
        await client.query('ROLLBACK');
        return res.status(409).json({ error: { code: 'ACCOUNT_ALREADY_EXISTS', message: '账号 ID 已存在或已被历史记录使用', requestId: req.requestId } });
      }
      await client.query("INSERT INTO accounts(id,display_name,status) VALUES($1,$2,'idle')", [id, displayName || null]);
      const gatewayResponse = await fetch(`${gatewayUrl}/accounts/${encodeURIComponent(id)}`, { method: 'PUT', headers: { 'content-type': 'application/json', 'x-trace-id': req.traceId }, body: '{}' });
      if (!gatewayResponse.ok) {
        const body: any = await gatewayResponse.json().catch(() => ({}));
        await client.query('ROLLBACK');
        return res.status(502).json({ error: { code: body.code || 'GATEWAY_ERROR', message: 'Gateway 创建账号失败', requestId: req.requestId } });
      }
      await client.query('COMMIT');
      const account = (await pool.query(selectAccount, [id])).rows[0];
      broadcast('account_created', { accountId: id });
      return res.status(201).json(account);
    } catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
  });

  app.get('/api/accounts/:id', auth, async (req, res) => {
    const account = (await pool.query(selectAccount, [String(req.params.id)])).rows[0];
    if (!account) return res.status(404).json({ error: { code: 'ACCOUNT_NOT_FOUND', message: '账号不存在', requestId: req.requestId } });
    return res.json(account);
  });

  app.patch('/api/accounts/:id', auth, write, async (req, res) => {
    if (typeof req.body?.displayName !== 'string') return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'displayName 必填', requestId: req.requestId } });
    const displayName = req.body.displayName.trim();
    if (displayName.length > 80) return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: '名称最多 80 字', requestId: req.requestId } });
    const result = await pool.query(`UPDATE accounts SET display_name=$2,version=version+1 WHERE id=$1 AND deleted_at IS NULL
      RETURNING id,display_name AS "displayName",status,platform_user_id AS "platformUserId",rate_limited_until AS "rateLimitedUntil"`, [String(req.params.id), displayName || null]);
    if (!result.rowCount) return res.status(404).json({ error: { code: 'ACCOUNT_NOT_FOUND', message: '账号不存在', requestId: req.requestId } });
    broadcast('account_updated', { accountId: req.params.id });
    return res.json(result.rows[0]);
  });

  app.delete('/api/accounts/:id', auth, write, async (req, res) => {
    const id = String(req.params.id);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      if (!(await client.query('SELECT 1 FROM accounts WHERE id=$1 AND deleted_at IS NULL FOR UPDATE', [id])).rowCount) {
        await client.query('ROLLBACK');
        return res.status(404).json({ error: { code: 'ACCOUNT_NOT_FOUND', message: '账号不存在', requestId: req.requestId } });
      }
      const blockers = (await client.query(`SELECT
        (SELECT count(*)::int FROM group_members WHERE account_id=$1) AS memberships,
        (SELECT count(*)::int FROM group_join_requests WHERE account_id=$1 AND status IN ('pending','approved')) AS applications,
        (SELECT count(*)::int FROM messages WHERE outbound_account_id=$1 AND delivery_status IN ('queued','accepted','unknown')) AS pending_sends`, [id])).rows[0];
      if (blockers.memberships || blockers.applications || blockers.pending_sends) {
        await client.query('ROLLBACK');
        return res.status(409).json({ error: { code: 'ACCOUNT_IN_USE', message: '请先退出所属群组、处理入群申请和未完成发送', requestId: req.requestId, memberships: blockers.memberships, applications: blockers.applications, pendingSends: blockers.pending_sends } });
      }
      const gatewayResponse = await fetch(`${gatewayUrl}/accounts/${encodeURIComponent(id)}`, { method: 'DELETE', headers: { 'x-trace-id': req.traceId } });
      if (!gatewayResponse.ok) {
        const body: any = await gatewayResponse.json().catch(() => ({}));
        await client.query('ROLLBACK');
        return res.status(502).json({ error: { code: body.code || 'GATEWAY_ERROR', message: 'Gateway 删除账号失败', requestId: req.requestId } });
      }
      await client.query('UPDATE accounts SET deleted_at=now(),gateway_deleted_at=now(),version=version+1 WHERE id=$1', [id]);
      await client.query('COMMIT');
      broadcast('account_deleted', { accountId: id });
      return res.json({ deleted: true });
    } catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
  });

  app.post('/api/accounts/:id/connect', auth, write, async (req, res) => {
    const id = String(req.params.id);
    const row = (await pool.query('SELECT status,platform_user_id FROM accounts WHERE id=$1 AND deleted_at IS NULL', [id])).rows[0];
    if (!row) return res.status(404).json({ error: { code: 'ACCOUNT_NOT_FOUND', message: '账号不存在', requestId: req.requestId } });
    if (isTerminal(row.status) || !['idle', 'disconnected'].includes(row.status)) return res.status(409).json({ error: { code: 'ILLEGAL_TRANSITION', message: isTerminal(row.status) ? '终态账号不可重连' : '当前状态不可重连', requestId: req.requestId } });
    try {
      const gatewayResponse = await fetch(`${gatewayUrl}/accounts/${encodeURIComponent(id)}/connect`, { method: 'POST', headers: { 'x-trace-id': req.traceId } });
      if (!gatewayResponse.ok) {
        const body: any = await gatewayResponse.json().catch(() => ({}));
        if (body.code === 'ACCOUNT_SUSPENDED' || body.code === 'SESSION_EXPIRED') {
          const status = body.code === 'ACCOUNT_SUSPENDED' ? 'suspended' : 'session_expired';
          const result = await transitionAccount(pool, id, status, { allowSameTerminal: true });
          if (result.changed) { broadcast('account_status_changed', { accountId: id, from: result.from, to: status }); broadcast('account_terminal', { accountId: id, status }); }
        }
        return res.status(gatewayResponse.status).json({ error: { code: body.code || 'GATEWAY_ERROR', message: '网关连接失败', requestId: req.requestId } });
      }
      const body: any = await gatewayResponse.json();
      const result = await transitionAccount(pool, id, 'online', { expectedFrom: row.status, platformUserId: body.platformUserId });
      broadcast('account_status_changed', { accountId: id, from: result.from, to: 'online' });
      return res.json({ status: 'online', platformUserId: body.platformUserId });
    } catch (error) {
      if (error instanceof AccountTransitionError) return res.status(error.code === 'ACCOUNT_NOT_FOUND' ? 404 : 409).json({ error: { code: error.code, message: error.message, requestId: req.requestId } });
      throw error;
    }
  });

  app.post('/api/accounts/:id/transition', auth, write, async (req, res) => {
    const { to, expectedFrom } = req.body || {};
    if (typeof to !== 'string' || typeof expectedFrom !== 'string') return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'to 和 expectedFrom 必填', requestId: req.requestId } });
    try {
      const result = await transitionAccount(pool, String(req.params.id), to as AccountStatus, { expectedFrom: expectedFrom as AccountStatus, allowSameTerminal: true });
      if (to === 'disconnected' || to === 'idle') {
        try {
          const response = await fetch(`${gatewayUrl}/accounts/${encodeURIComponent(String(req.params.id))}/disconnect`, { method: 'POST', headers: { 'x-trace-id': req.traceId } });
          if (!response.ok) broadcast('inconsistency', { kind: 'gateway_disconnect', ref: req.params.id, message: `Gateway returned ${response.status}` });
        } catch (error) { broadcast('inconsistency', { kind: 'gateway_disconnect', ref: req.params.id, message: String(error) }); }
      }
      if (result.changed) { broadcast('account_status_changed', { accountId: req.params.id, from: result.from, to, status: to }); if (isTerminal(to)) broadcast('account_terminal', { accountId: req.params.id, status: to }); }
      return res.json({ status: to });
    } catch (error) {
      if (error instanceof AccountTransitionError) return res.status(error.code === 'ACCOUNT_NOT_FOUND' ? 404 : 409).json({ error: { code: error.code, message: error.message, requestId: req.requestId } });
      throw error;
    }
  });
}
