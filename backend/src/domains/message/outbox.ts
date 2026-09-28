import type { Pool } from 'pg';
import { AccountTransitionError, transitionAccount } from '../account/state.js';
import { recordTrace } from '../../infrastructure/observability/traces.js';

type Outbound = {
  id: string;
  group_id: string;
  gateway_group_id: string;
  client_msg_id: string;
  text: string;
  outbound_account_id: string;
  send_attempts: number;
  attempted_at: Date;
  trace_id?: string;
};

export function startOutbox(pool: Pool, gatewayUrl: string, publish: (type: string, payload: unknown) => void): void {
  let busy = false;

  async function markGroupUnreachable(message: Outbound) {
    const client = await pool.connect();
    let stoppedRuns: { id: string; current_step_index: number }[] = [];
    try {
      await client.query('BEGIN');
      await client.query("UPDATE groups SET status='unreachable',agent_enabled=false WHERE id=$1 AND status='active'", [message.group_id]);
      const stopped = await client.query("UPDATE sequence_runs SET status='stopped' WHERE group_id=$1 AND status='running' RETURNING id,current_step_index", [message.group_id]);
      stoppedRuns = stopped.rows;
      await client.query("UPDATE messages SET delivery_status='cancelled',fail_code='GROUP_UNREACHABLE' WHERE group_id=$1 AND delivery_status='queued'", [message.group_id]);
      await client.query("UPDATE messages SET delivery_status='failed',fail_code='GROUP_UNREACHABLE' WHERE id=$1 AND delivery_status='unknown'", [message.id]);
      await client.query("UPDATE messages SET fail_code='GROUP_UNREACHABLE' WHERE group_id=$1 AND fail_code='GATEWAY_ERROR'", [message.group_id]);
      await client.query('COMMIT');
    } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
    publish('group_unreachable', { groupId: message.group_id, reason: 'GATEWAY_GROUP_NOT_FOUND' });
    for (const run of stoppedRuns) publish('sequence_run', { runId: run.id, groupId: message.group_id, status: 'stopped', currentStepIndex: run.current_step_index });
  }

  async function send(message: Outbound) {
    try {
      const response = await fetch(`${gatewayUrl}/groups/${message.gateway_group_id}/send`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(message.trace_id ? { 'x-trace-id': message.trace_id } : {}) },
        body: JSON.stringify({ accountId: message.outbound_account_id, clientMsgId: message.client_msg_id, text: message.text }),
        signal: AbortSignal.timeout(10000),
      });
      if (response.ok) {
        await recordTrace(pool, message.trace_id, 'backend', 'gateway_send', { groupId: message.group_id, gatewayGroupId: message.gateway_group_id, clientMsgId: message.client_msg_id, status: response.status, code: 'accepted' });
        await pool.query("UPDATE messages SET delivery_status='accepted',fail_code=NULL WHERE id=$1 AND delivery_status='unknown'", [message.id]);
        return;
      }
      const body = await response.json().catch(() => ({})) as { code?: string; retryAfterSeconds?: number };
      const code = body.code || 'GATEWAY_ERROR';
      await recordTrace(pool, message.trace_id, 'backend', 'gateway_send', { groupId: message.group_id, gatewayGroupId: message.gateway_group_id, clientMsgId: message.client_msg_id, status: response.status, code });
      if (response.status === 404 || code === 'NOT_FOUND') {
        await markGroupUnreachable(message);
        return;
      }
      if (code === 'NETWORK_TIMEOUT' || response.status === 504 || response.status === 503) {
        // The two-second settlement window starts when the uncertain response arrives.
        await pool.query("UPDATE messages SET attempted_at=now() WHERE id=$1 AND delivery_status='unknown'", [message.id]);
        return;
      }
      if (code === 'RATE_LIMITED') {
        const until = new Date(Date.now() + Math.max(1, Number(body.retryAfterSeconds || 1)) * 1000);
        const client = await pool.connect();
        let fromStatus: string | undefined;
        try {
          await client.query('BEGIN');
          const account = await client.query('SELECT status FROM accounts WHERE id=$1 FOR UPDATE', [message.outbound_account_id]);
          fromStatus = account.rows[0]?.status;
          if (fromStatus === 'online' || fromStatus === 'rate_limited') {
            await client.query("UPDATE accounts SET status='rate_limited',rate_limited_until=$2,version=version+1 WHERE id=$1", [message.outbound_account_id, until]);
            await client.query("UPDATE messages SET delivery_status='queued',send_attempts=send_attempts-1,attempted_at=NULL WHERE id=$1 AND delivery_status='unknown'", [message.id]);
          } else {
            await client.query("UPDATE messages SET delivery_status='failed',fail_code=$2 WHERE id=$1 AND delivery_status='unknown'", [message.id, fromStatus === 'suspended' || fromStatus === 'session_expired' ? 'ACCOUNT_TERMINAL' : 'ACCOUNT_OFFLINE']);
          }
          await client.query('COMMIT');
        } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
        if (fromStatus === 'online') publish('account_status_changed', { accountId: message.outbound_account_id, from: 'online', to: 'rate_limited' });
        return;
      }
      if (code === 'ACCOUNT_SUSPENDED' || code === 'SESSION_EXPIRED') {
        const terminal = code === 'ACCOUNT_SUSPENDED' ? 'suspended' : 'session_expired';
        try {
          const result = await transitionAccount(pool, message.outbound_account_id, terminal, { allowSameTerminal: true });
          if (result.changed) {
            publish('account_status_changed', { accountId: message.outbound_account_id, from: result.from, to: terminal });
            publish('account_terminal', { accountId: message.outbound_account_id, status: terminal });
          }
        } catch (error) { if (!(error instanceof AccountTransitionError)) throw error; }
        await pool.query("UPDATE messages SET delivery_status='failed',fail_code=$2 WHERE id=$1 AND delivery_status='unknown'", [message.id, code]);
        return;
      }
      if (code === 'GROUP_WRITE_FORBIDDEN') {
        const client = await pool.connect();
        try {
          await client.query('BEGIN');
          await client.query("UPDATE groups SET status='unreachable',agent_enabled=false WHERE id=$1", [message.group_id]);
          const stopped = await client.query("UPDATE sequence_runs SET status='stopped' WHERE group_id=$1 AND status='running' RETURNING id,current_step_index", [message.group_id]);
          await client.query("UPDATE messages SET delivery_status='cancelled',fail_code='GROUP_UNREACHABLE' WHERE group_id=$1 AND delivery_status='queued'", [message.group_id]);
          await client.query("UPDATE messages SET delivery_status='failed',fail_code='GROUP_UNREACHABLE' WHERE id=$1 AND delivery_status='unknown'", [message.id]);
          await client.query('COMMIT');
          publish('group_unreachable', { groupId: message.group_id, reason: 'GROUP_WRITE_FORBIDDEN' });
          for (const run of stopped.rows) publish('sequence_run', { runId: run.id, groupId: message.group_id, status: 'stopped', currentStepIndex: run.current_step_index });
        } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
        return;
      }
      await pool.query("UPDATE messages SET delivery_status='failed',fail_code=$2 WHERE id=$1 AND delivery_status='unknown'", [message.id, code]);
    } catch (error) {
      console.error(JSON.stringify({ event: 'outbox_send_uncertain', clientMsgId: message.client_msg_id, error: String(error) }));
      await pool.query("UPDATE messages SET attempted_at=now() WHERE id=$1 AND delivery_status='unknown'", [message.id]);
    }
  }

  async function claimQueued(): Promise<Outbound | undefined> {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const row = await client.query<Outbound>(
        `SELECT m.*,g.gateway_group_id FROM messages m
         JOIN groups g ON g.id=m.group_id
         JOIN accounts a ON a.id=m.outbound_account_id
         WHERE m.delivery_status='queued' AND a.status='online' AND g.status='active'
           AND NOT EXISTS (
             SELECT 1 FROM messages earlier
             WHERE earlier.outbound_account_id=m.outbound_account_id
               AND earlier.delivery_status IN ('queued','unknown','accepted')
               AND (earlier.sent_at,earlier.id)<(m.sent_at,m.id)
           )
         ORDER BY m.sent_at,m.id FOR UPDATE OF m SKIP LOCKED LIMIT 1`,
      );
      if (!row.rowCount) { await client.query('COMMIT'); return undefined; }
      const message = row.rows[0];
      // On a process crash before receiving HTTP status, the request itself can take
      // two seconds and the gateway can need another two seconds to settle it.
      await client.query("UPDATE messages SET delivery_status='unknown',send_attempts=send_attempts+1,attempted_at=now()+interval '2 seconds' WHERE id=$1", [message.id]);
      await client.query('COMMIT');
      return message;
    } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
  }

  async function reconcileUnknown() {
    const rows = await pool.query<Outbound>(
      `SELECT m.*,g.gateway_group_id FROM messages m JOIN groups g ON g.id=m.group_id
       WHERE m.delivery_status='unknown' AND m.attempted_at<now()-interval '2 seconds'
       ORDER BY m.attempted_at LIMIT 100`,
    );
    for (const message of rows.rows) {
      try {
        const response = await fetch(`${gatewayUrl}/groups/${message.gateway_group_id}/messages/by-client-id/${message.client_msg_id}`, { headers: message.trace_id ? { 'x-trace-id': message.trace_id } : undefined, signal: AbortSignal.timeout(5000) });
        if (response.ok) {
          const landed = await response.json() as { msgId: string; sentAt: string };
          await pool.query("UPDATE messages SET delivery_status='sent',msg_id=$2,sent_at=$3,fail_code=NULL WHERE id=$1 AND delivery_status='unknown'", [message.id, landed.msgId, landed.sentAt]);
        } else if (response.status === 404) {
          if (message.send_attempts >= 2) {
            await pool.query("UPDATE messages SET delivery_status='failed',fail_code='NETWORK_TIMEOUT' WHERE id=$1 AND delivery_status='unknown'", [message.id]);
          } else {
            const claimed = await pool.query<Outbound>("UPDATE messages AS m SET send_attempts=m.send_attempts+1,attempted_at=now() FROM accounts a WHERE m.id=$1 AND a.id=m.outbound_account_id AND a.status='online' AND m.delivery_status='unknown' AND m.send_attempts<2 AND m.attempted_at<now()-interval '2 seconds' RETURNING m.*", [message.id]);
            if (claimed.rowCount) await send({ ...claimed.rows[0], gateway_group_id: message.gateway_group_id });
          }
        }
      } catch (error) {
        console.error(JSON.stringify({ event: 'outbox_reconciliation_failed', clientMsgId: message.client_msg_id, error: String(error) }));
      }
    }
  }

  async function reconcileAccepted() {
    const rows = await pool.query<Outbound & { group_status: string }>(
      `SELECT m.*,g.gateway_group_id,g.status AS group_status FROM messages m JOIN groups g ON g.id=m.group_id
       WHERE m.delivery_status='accepted' AND m.attempted_at<now()-interval '5 seconds'
       ORDER BY m.attempted_at LIMIT 100`,
    );
    for (const message of rows.rows) {
      try {
        const response = await fetch(`${gatewayUrl}/groups/${message.gateway_group_id}/messages/by-client-id/${message.client_msg_id}`, {
          headers: message.trace_id ? { 'x-trace-id': message.trace_id } : undefined,
          signal: AbortSignal.timeout(5000),
        });
        if (response.ok) {
          const landed = await response.json() as { msgId: string; sentAt: string };
          await pool.query("UPDATE messages SET delivery_status='sent',msg_id=$2,sent_at=$3,fail_code=NULL WHERE id=$1 AND delivery_status='accepted'", [message.id, landed.msgId, landed.sentAt]);
          publish('message', { groupId: message.group_id, msgId: landed.msgId, isOwn: true });
        } else if (response.status === 404 && message.group_status !== 'active') {
          // A retired group cannot later deliver an unlanded accepted message.
          // Resolve it so one stale record does not block every later send
          // from the same account.
          await pool.query("UPDATE messages SET delivery_status='failed',fail_code='GROUP_UNREACHABLE' WHERE id=$1 AND delivery_status='accepted'", [message.id]);
          publish('message', { groupId: message.group_id, msgId: null, isOwn: true });
        } else {
          await pool.query("UPDATE messages SET attempted_at=now() WHERE id=$1 AND delivery_status='accepted'", [message.id]);
        }
      } catch (error) {
        await pool.query("UPDATE messages SET attempted_at=now() WHERE id=$1 AND delivery_status='accepted'", [message.id]);
        console.error(JSON.stringify({ event: 'outbox_accepted_reconciliation_failed', clientMsgId: message.client_msg_id, error: String(error) }));
      }
    }
  }

  async function tick() {
    if (busy) return;
    busy = true;
    try {
      const message = await claimQueued();
      if (message) await send(message);
      await reconcileUnknown();
      await reconcileAccepted();
      const recovered = await pool.query("UPDATE accounts SET status='online',rate_limited_until=NULL,version=version+1 WHERE status='rate_limited' AND rate_limited_until<=now() RETURNING id");
      for (const row of recovered.rows) publish('account_status_changed', { accountId: row.id, from: 'rate_limited', to: 'online' });
    } catch (error) { console.error(JSON.stringify({ event: 'outbox_tick_failed', error: String(error) })); }
    finally { busy = false; }
  }
  setInterval(() => { void tick(); }, 250).unref();
  void tick();
}
