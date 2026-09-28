import type { Pool } from 'pg';

type Job = { id: string; trace_id?: string; kind: 'create' | 'leave_all'; group_id: string | null; payload: { creatorAccountId?: string; memberAccountIds?: string[] }; progress: { promoteAttempts?: number; processed?: string[]; errors?: { step: string; code: string }[] } };
type Dependencies = { pool: Pool; gatewayUrl: string; publish: (type: string, payload: Record<string, unknown>) => void };
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

async function gateway(url: string, pathname: string, method = 'GET', body?: object, traceId?: string) {
  const response = await fetch(`${url}${pathname}`, { method, headers: { 'content-type': 'application/json', ...(traceId ? { 'x-trace-id': traceId } : {}) }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(12000) });
  if (response.status === 503) throw new Error('gateway unavailable');
  const data = await response.json().catch(() => ({}));
  return { response, data };
}

export function startGroupJobs({ pool, gatewayUrl, publish }: Dependencies): void {
  async function saveProgress(job: Job) {
    await pool.query('UPDATE jobs SET progress=$2 WHERE id=$1', [job.id, JSON.stringify(job.progress)]);
  }
  async function finish(job: Job, errors: { step: string; code: string }[]) {
    await pool.query('UPDATE jobs SET status=$2,errors=$3,progress=$4,lease_until=NULL WHERE id=$1', [job.id, errors.length ? 'failed' : 'finished', JSON.stringify(errors), JSON.stringify(job.progress)]);
  }
  async function members(gatewayId: string, traceId?: string): Promise<string[]> {
    const result = await gateway(gatewayUrl, `/groups/${gatewayId}/members`, 'GET', undefined, traceId);
    if (!result.response.ok || !Array.isArray(result.data)) throw new Error('member lookup unavailable');
    return result.data.map((item: { platformUserId: string }) => item.platformUserId);
  }
  async function markUnreachable(groupId: string, gatewayId: string) {
    await pool.query("UPDATE groups SET status='unreachable',agent_enabled=false WHERE id=$1 AND status='active'", [groupId]);
    await pool.query("UPDATE messages SET delivery_status='cancelled',fail_code='GROUP_UNREACHABLE' WHERE group_id=$1 AND delivery_status='queued'", [groupId]);
    await pool.query("UPDATE messages SET delivery_status='failed',fail_code='GROUP_UNREACHABLE' WHERE group_id=$1 AND delivery_status='unknown'", [groupId]);
    await pool.query("UPDATE messages SET fail_code='GROUP_UNREACHABLE' WHERE group_id=$1 AND fail_code='GATEWAY_ERROR'", [groupId]);
    publish('group_unreachable', { groupId, gatewayGroupId: gatewayId });
  }
  async function reconcileGroups() {
    await pool.query("UPDATE messages SET fail_code='GROUP_UNREACHABLE' WHERE fail_code='GATEWAY_ERROR' AND group_id IN (SELECT id FROM groups WHERE status='unreachable')");
    const rows = await pool.query("SELECT id,gateway_group_id FROM groups WHERE status='active'");
    for (const row of rows.rows) {
      try {
        const response = await fetch(`${gatewayUrl}/groups/${row.gateway_group_id}/members`, { signal: AbortSignal.timeout(5000) });
        if (response.status === 404) await markUnreachable(row.id, row.gateway_group_id);
      } catch { /* Gateway may still be starting; the next pass retries. */ }
    }
  }
  async function create(job: Job) {
    const creator = String(job.payload.creatorAccountId);
    const memberIds = job.payload.memberAccountIds || [];
    let groupId = job.group_id;
    let gatewayId: string;
    if (!groupId) {
      const created = await gateway(gatewayUrl, '/groups', 'POST', { creatorAccountId: creator, clientJobId: job.id }, job.trace_id);
      if (!created.response.ok) { await finish(job, [{ step: 'create', code: created.data.code || 'CREATE_FAILED' }]); return; }
      gatewayId = created.data.groupId;
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const inserted = await client.query('INSERT INTO groups(gateway_group_id,creator_account_id) VALUES($1,$2) ON CONFLICT(gateway_group_id) DO UPDATE SET gateway_group_id=EXCLUDED.gateway_group_id RETURNING id', [gatewayId, creator]);
        groupId = inserted.rows[0].id;
        await client.query("INSERT INTO group_members(group_id,account_id,platform_user_id,role) SELECT $1,id,platform_user_id,'creator' FROM accounts WHERE id=$2 ON CONFLICT DO NOTHING", [groupId, creator]);
        await client.query('UPDATE jobs SET group_id=$2 WHERE id=$1', [job.id, groupId]);
        await client.query('COMMIT');
      } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
      job.group_id = groupId;
    } else {
      const group = await pool.query('SELECT gateway_group_id FROM groups WHERE id=$1', [groupId]);
      gatewayId = group.rows[0].gateway_group_id;
    }
    const errors: { step: string; code: string }[] = [];
    for (const accountId of memberIds) {
      const account = await pool.query('SELECT platform_user_id FROM accounts WHERE id=$1', [accountId]);
      const platformUserId = account.rows[0]?.platform_user_id;
      if (!platformUserId) { errors.push({ step: `join:${accountId}`, code: 'ACCOUNT_NOT_ONLINE' }); continue; }
      const local = await pool.query('SELECT 1 FROM group_members WHERE group_id=$1 AND account_id=$2', [groupId, accountId]);
      if (local.rowCount) continue;
      let joined = (await members(gatewayId, job.trace_id)).includes(platformUserId);
      if (joined) await pool.query("INSERT INTO group_members(group_id,account_id,platform_user_id,role) VALUES($1,$2,$3,'member') ON CONFLICT DO NOTHING", [groupId, accountId, platformUserId]);
      for (let inviteTry = 0; inviteTry < 2 && !joined; inviteTry++) {
        const invite = await gateway(gatewayUrl, `/groups/${gatewayId}/invite`, 'POST', undefined, job.trace_id);
        if (!invite.response.ok) { errors.push({ step: 'invite', code: invite.data.code || 'INVITE_FAILED' }); break; }
        await sleep(Math.max(0, Number(invite.data.readyAfterMs || 0)));
        for (let attempt = 0; attempt < 2 && !joined; attempt++) {
          const join = await gateway(gatewayUrl, `/groups/${gatewayId}/join`, 'POST', { accountId, inviteLink: invite.data.inviteLink }, job.trace_id);
          if (join.response.ok || join.data.code === 'ALREADY_MEMBER') { joined = true; break; }
          if (join.data.code === 'INVITE_EXPIRED') break;
          if (join.data.code === 'INVITE_NOT_READY') { await sleep(500); continue; }
          errors.push({ step: `join:${accountId}`, code: join.data.code || 'JOIN_FAILED' }); break;
        }
      }
      if (!joined) { if (!errors.some(error => error.step === `join:${accountId}`)) errors.push({ step: `join:${accountId}`, code: 'JOIN_TIMEOUT' }); continue; }
      const deadline = Date.now() + 10000;
      while (Date.now() < deadline) {
        const seen = await pool.query('SELECT 1 FROM group_members WHERE group_id=$1 AND account_id=$2', [groupId, accountId]);
        if (seen.rowCount) break;
        const currentMembers = await members(gatewayId, job.trace_id);
        if (currentMembers.includes(platformUserId)) {
          await pool.query("INSERT INTO group_members(group_id,account_id,platform_user_id,role) VALUES($1,$2,$3,'member') ON CONFLICT DO NOTHING", [groupId, accountId, platformUserId]);
          break;
        }
        await sleep(200);
      }
      const seen = await pool.query('SELECT 1 FROM group_members WHERE group_id=$1 AND account_id=$2', [groupId, accountId]);
      if (!seen.rowCount) errors.push({ step: `join:${accountId}`, code: 'JOIN_TIMEOUT' });
    }
    if (!errors.length) {
      const admin = memberIds[0];
      const current = await pool.query('SELECT role FROM group_members WHERE group_id=$1 AND account_id=$2', [groupId, admin]);
      while (current.rows[0]?.role !== 'admin' && (job.progress.promoteAttempts || 0) < 2) {
        job.progress.promoteAttempts = (job.progress.promoteAttempts || 0) + 1;
        await saveProgress(job);
        const promoted = await gateway(gatewayUrl, `/groups/${gatewayId}/promote`, 'POST', { byAccountId: creator, accountId: admin }, job.trace_id);
        if (promoted.response.ok) { await pool.query("UPDATE group_members SET role='admin' WHERE group_id=$1 AND account_id=$2", [groupId, admin]); break; }
        if (promoted.data.code !== 'NOT_MEMBER_YET') break;
        await sleep(250);
      }
      const checked = await pool.query('SELECT role FROM group_members WHERE group_id=$1 AND account_id=$2', [groupId, admin]);
      if (checked.rows[0]?.role !== 'admin') errors.push({ step: 'promote', code: 'PROMOTE_FAILED' });
    }
    await finish(job, errors);
  }
  async function leaveAll(job: Job) {
    const group = await pool.query('SELECT gateway_group_id FROM groups WHERE id=$1', [job.group_id]);
    if (!group.rowCount) { await finish(job, [{ step: 'create', code: 'GROUP_NOT_FOUND' }]); return; }
    const gatewayId = group.rows[0].gateway_group_id;
    const local = await pool.query('SELECT account_id,platform_user_id,role FROM group_members WHERE group_id=$1 ORDER BY (role=\'creator\'),account_id', [job.group_id]);
    const nonOwners = local.rows.filter(row => row.role !== 'creator');
    const errors: { step: string; code: string }[] = job.progress.errors || [];
    const processed = new Set(job.progress.processed || []);
    for (const member of nonOwners) {
      if (processed.has(member.account_id)) continue;
      const result = await gateway(gatewayUrl, `/groups/${gatewayId}/leave`, 'POST', { accountId: member.account_id }, job.trace_id);
      const stillMember = (await members(gatewayId, job.trace_id)).includes(member.platform_user_id);
      if (stillMember) errors.push({ step: `leave:${member.account_id}`, code: result.data.code || 'LEAVE_FAILED' });
      else await pool.query('DELETE FROM group_members WHERE group_id=$1 AND account_id=$2', [job.group_id, member.account_id]);
      processed.add(member.account_id); job.progress = { ...job.progress, processed: [...processed], errors }; await saveProgress(job);
    }
    if (!errors.length) {
      const owner = local.rows.find(row => row.role === 'creator');
      if (owner) {
        await gateway(gatewayUrl, `/groups/${gatewayId}/leave`, 'POST', { accountId: owner.account_id }, job.trace_id);
        if ((await members(gatewayId, job.trace_id)).includes(owner.platform_user_id)) errors.push({ step: `leave:${owner.account_id}`, code: 'LEAVE_FAILED' });
        else await pool.query('DELETE FROM group_members WHERE group_id=$1 AND account_id=$2', [job.group_id, owner.account_id]);
      }
    }
    if (!errors.length) await pool.query("UPDATE groups SET status='left' WHERE id=$1", [job.group_id]);
    await finish(job, errors);
  }
  let busy = false;
  async function tick() {
    if (busy) return;
    busy = true;
    try {
      const candidates = await pool.query<Job>("SELECT * FROM jobs WHERE status='running' AND kind IS NOT NULL ORDER BY id LIMIT 20");
      for (const job of candidates.rows) {
        const lock = await pool.connect();
        try {
          const acquired = await lock.query('SELECT pg_try_advisory_lock(82945,hashtext($1)) AS acquired', [job.id]);
          if (!acquired.rows[0].acquired) continue;
          const current = await pool.query<Job>("SELECT * FROM jobs WHERE id=$1 AND status='running'", [job.id]);
          if (!current.rowCount) continue;
          try { if (job.kind === 'create') await create(current.rows[0]); else await leaveAll(current.rows[0]); }
          catch (error) { console.error(JSON.stringify({ event: 'group_job_retry', jobId: job.id, error: String(error) })); publish('inconsistency', { kind: 'group_job', ref: job.id, message: String(error) }); }
          break;
        } finally { await lock.query('SELECT pg_advisory_unlock(82945,hashtext($1))', [job.id]); lock.release(); }
      }
    } catch (error) { console.error(JSON.stringify({ event: 'group_job_scan_failed', error: String(error) })); }
    finally { busy = false; }
  }
  setInterval(() => { void tick(); }, 500).unref();
  setInterval(() => { void reconcileGroups(); }, 30000).unref();
  setTimeout(() => { void reconcileGroups(); }, 3000).unref();
  void tick();
}
