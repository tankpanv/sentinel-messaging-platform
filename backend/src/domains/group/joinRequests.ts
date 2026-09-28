import type { Pool } from 'pg';

type Dependencies = {
  pool: Pool;
  gatewayUrl: string;
  publish: (type: string, payload: Record<string, unknown>) => void;
};

type JoinRow = {
  id: string;
  group_id: string;
  account_id: string;
  gateway_group_id: string;
  group_status: string;
  account_status: string;
  platform_user_id: string | null;
  trace_id: string | null;
};

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

export function startGroupJoinRequests({ pool, gatewayUrl, publish }: Dependencies): void {
  let busy = false;
  async function gateway(path: string, method = 'GET', body?: object, traceId?: string | null) {
    const response = await fetch(`${gatewayUrl}${path}`, {
      method,
      headers: { 'content-type': 'application/json', ...(traceId ? { 'x-trace-id': traceId } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(12000),
    });
    if (response.status === 503) throw new Error('gateway unavailable');
    const data = await response.json().catch(() => ({}));
    return { response, data };
  }
  async function setStatus(row: JoinRow, status: 'joined' | 'failed', errorCode?: string) {
    const changed = await pool.query(
      'UPDATE group_join_requests SET status=$2,error_code=$3,decided_at=now() WHERE id=$1 AND status=$4 RETURNING id',
      [row.id, status, errorCode || null, 'approved'],
    );
    if (changed.rowCount) publish('group_join_request_changed', { groupId: row.group_id, requestId: row.id, accountId: row.account_id, status, errorCode: errorCode || null });
  }
  async function isMember(row: JoinRow) {
    const local = await pool.query('SELECT 1 FROM group_members WHERE group_id=$1 AND account_id=$2', [row.group_id, row.account_id]);
    if (local.rowCount) return true;
    const remote = await gateway(`/groups/${row.gateway_group_id}/members`, 'GET', undefined, row.trace_id);
    if (!remote.response.ok || !Array.isArray(remote.data)) throw new Error(`member lookup ${remote.response.status}`);
    if (!remote.data.some((member: { platformUserId: string }) => member.platformUserId === row.platform_user_id)) return false;
    // The gateway member list is authoritative if the event was missed during a restart.
    await pool.query("INSERT INTO group_members(group_id,account_id,platform_user_id,role) VALUES($1,$2,$3,'member') ON CONFLICT DO NOTHING", [row.group_id, row.account_id, row.platform_user_id]);
    publish('group_members_changed', { groupId: row.group_id, accountId: row.account_id, action: 'joined' });
    return true;
  }
  async function process(row: JoinRow) {
    if (row.group_status !== 'active') return setStatus(row, 'failed', 'GROUP_UNREACHABLE');
    if (row.account_status !== 'online' || !row.platform_user_id) return setStatus(row, 'failed', 'ACCOUNT_NOT_ONLINE');
    if (await isMember(row)) return setStatus(row, 'joined');
    for (let linkAttempt = 0; linkAttempt < 3; linkAttempt++) {
      const invite = await gateway(`/groups/${row.gateway_group_id}/invite`, 'POST', {}, row.trace_id);
      if (!invite.response.ok) return setStatus(row, 'failed', invite.data.code || 'INVITE_FAILED');
      await sleep(Math.max(0, Number(invite.data.readyAfterMs || 0)) + 30);
      for (let joinAttempt = 0; joinAttempt < 3; joinAttempt++) {
        const joined = await gateway(`/groups/${row.gateway_group_id}/join`, 'POST', { accountId: row.account_id, inviteLink: invite.data.inviteLink }, row.trace_id);
        if (joined.response.ok || joined.data.code === 'ALREADY_MEMBER') {
          const deadline = Date.now() + 10000;
          while (Date.now() < deadline) {
            const local = await pool.query('SELECT 1 FROM group_members WHERE group_id=$1 AND account_id=$2', [row.group_id, row.account_id]);
            if (local.rowCount) return setStatus(row, 'joined');
            await sleep(200);
          }
          if (await isMember(row)) return setStatus(row, 'joined');
          return setStatus(row, 'failed', 'JOIN_TIMEOUT');
        }
        if (joined.data.code === 'INVITE_EXPIRED') break;
        if (joined.data.code === 'INVITE_NOT_READY') { await sleep(300); continue; }
        return setStatus(row, 'failed', joined.data.code || 'JOIN_FAILED');
      }
    }
    return setStatus(row, 'failed', 'INVITE_EXPIRED');
  }
  async function tick() {
    if (busy) return;
    busy = true;
    try {
      const candidate = await pool.query<JoinRow>(
        `SELECT r.*,g.gateway_group_id,g.status AS group_status,a.status AS account_status,a.platform_user_id
         FROM group_join_requests r JOIN groups g ON g.id=r.group_id JOIN accounts a ON a.id=r.account_id
         WHERE r.status='approved' ORDER BY r.requested_at LIMIT 1`,
      );
      const row = candidate.rows[0];
      if (!row) return;
      const lock = await pool.connect();
      try {
        const acquired = await lock.query('SELECT pg_try_advisory_lock(82947,hashtext($1)) AS ok', [row.id]);
        if (!acquired.rows[0].ok) return;
        const current = await pool.query<JoinRow>(
          `SELECT r.*,g.gateway_group_id,g.status AS group_status,a.status AS account_status,a.platform_user_id
           FROM group_join_requests r JOIN groups g ON g.id=r.group_id JOIN accounts a ON a.id=r.account_id
           WHERE r.id=$1 AND r.status='approved'`, [row.id],
        );
        if (current.rowCount) await process(current.rows[0]);
      } finally {
        await lock.query('SELECT pg_advisory_unlock(82947,hashtext($1))', [row.id]);
        lock.release();
      }
    } catch (error) {
      console.error(JSON.stringify({ event: 'group_join_request_retry', error: String(error) }));
    } finally { busy = false; }
  }
  setInterval(() => { void tick(); }, 500).unref();
  void tick();
}
