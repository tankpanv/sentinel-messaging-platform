import type { Pool } from 'pg';
import { AccountTransitionError, transitionAccount } from '../account/state.js';

type Outbound = {
  id: string;
  group_id: string;
  gateway_group_id: string;
  client_msg_id: string;
  text: string;
  outbound_account_id: string;
  send_attempts: number;
  attempted_at: Date;
};

export function startOutbox(pool: Pool, gatewayUrl: string, publish: (type: string, payload: unknown) => void): void {
  let busy = false;

  async function send(message: Outbound) {
    try {
      const response = await fetch(`${gatewayUrl}/groups/${message.gateway_group_id}/send`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ accountId: message.outbound_account_id, clientMsgId: message.client_msg_id, text: message.text }),
      });
      if (response.ok) {
        await pool.query("UPDATE messages SET delivery_status='accepted',fail_code=NULL WHERE id=$1 AND delivery_status='unknown'", [message.id]);
        return;
      }
      const body = await response.json().catch(() => ({})) as { code?: string; retryAfterSeconds?: number };
      const code = body.code || 'GATEWAY_ERROR';
      if (code === 'NETWORK_TIMEOUT' || response.status === 504 || response.status === 503) return;
      if (code === 'RATE_LIMITED') {
        const until = new Date(Date.now() + Math.max(1, Number(body.retryAfterSeconds || 1)) * 1000);
        const changed = await pool.query(
          `WITH previous AS (SELECT id,status FROM accounts WHERE id=$1 AND status IN ('online','rate_limited') FOR UPDATE)
           UPDATE accounts AS a SET status='rate_limited',rate_limited_until=$2,version=a.version+1
           FROM previous WHERE a.id=previous.id RETURNING previous.status AS from_status`,
          [message.outbound_account_id, until],
        );
        await pool.query("UPDATE messages SET delivery_status='queued',send_attempts=send_attempts-1,attempted_at=NULL WHERE id=$1 AND delivery_status='unknown'", [message.id]);
        if (changed.rows[0]?.from_status === 'online') publish('account_status_changed', { accountId: message.outbound_account_id, from: 'online', to: 'rate_limited' });
        return;
      }
      if (code === 'ACCOUNT_SUSPENDED' || code === 'SESSION_EXPIRED') {
        const terminal = code === 'ACCOUNT_SUSPENDED' ? 'suspended' : 'session_expired';
        try {
          const result = await transitionAccount(pool, message.outbound_account_id, terminal, { allowSameTerminal: true });
          if (result.changed) publish('account_terminal', { accountId: message.outbound_account_id, status: terminal });
        } catch (error) { if (!(error instanceof AccountTransitionError)) throw error; }
        await pool.query("UPDATE messages SET delivery_status='failed',fail_code=$2 WHERE id=$1 AND delivery_status='unknown'", [message.id, code]);
        return;
      }
      if (code === 'GROUP_WRITE_FORBIDDEN') {
        const client = await pool.connect();
        try {
          await client.query('BEGIN');
          await client.query("UPDATE groups SET status='unreachable' WHERE id=$1", [message.group_id]);
          const stopped = await client.query("UPDATE sequence_runs SET status='stopped' WHERE group_id=$1 AND status='running' RETURNING id,current_step_index", [message.group_id]);
          await client.query("UPDATE messages SET delivery_status='cancelled',fail_code='GROUP_UNREACHABLE' WHERE group_id=$1 AND delivery_status='queued'", [message.group_id]);
          await client.query("UPDATE messages SET delivery_status='failed',fail_code='GROUP_UNREACHABLE' WHERE id=$1 AND delivery_status='unknown'", [message.id]);
          await client.query('COMMIT');
          for (const run of stopped.rows) publish('sequence_run', { runId: run.id, groupId: message.group_id, status: 'stopped', currentStepIndex: run.current_step_index });
        } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
        return;
      }
      await pool.query("UPDATE messages SET delivery_status='failed',fail_code=$2 WHERE id=$1 AND delivery_status='unknown'", [message.id, code]);
    } catch (error) {
      console.error(JSON.stringify({ event: 'outbox_send_uncertain', clientMsgId: message.client_msg_id, error: String(error) }));
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
         ORDER BY m.sent_at,m.id FOR UPDATE OF m SKIP LOCKED LIMIT 1`,
      );
      if (!row.rowCount) { await client.query('COMMIT'); return undefined; }
      const message = row.rows[0];
      await client.query("UPDATE messages SET delivery_status='unknown',send_attempts=send_attempts+1,attempted_at=now() WHERE id=$1", [message.id]);
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
        const response = await fetch(`${gatewayUrl}/groups/${message.gateway_group_id}/messages/by-client-id/${message.client_msg_id}`);
        if (response.ok) {
          const landed = await response.json() as { msgId: string; sentAt: string };
          await pool.query("UPDATE messages SET delivery_status='sent',msg_id=$2,sent_at=$3,fail_code=NULL WHERE id=$1 AND delivery_status='unknown'", [message.id, landed.msgId, landed.sentAt]);
        } else if (response.status === 404) {
          if (message.send_attempts >= 2) {
            await pool.query("UPDATE messages SET delivery_status='failed',fail_code='NETWORK_TIMEOUT' WHERE id=$1 AND delivery_status='unknown'", [message.id]);
          } else {
            const claimed = await pool.query<Outbound>("UPDATE messages SET send_attempts=send_attempts+1,attempted_at=now() WHERE id=$1 AND delivery_status='unknown' AND send_attempts<2 AND attempted_at<now()-interval '2 seconds' RETURNING *", [message.id]);
            if (claimed.rowCount) await send({ ...claimed.rows[0], gateway_group_id: message.gateway_group_id });
          }
        }
      } catch (error) {
        console.error(JSON.stringify({ event: 'outbox_reconciliation_failed', clientMsgId: message.client_msg_id, error: String(error) }));
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
      const recovered = await pool.query("UPDATE accounts SET status='online',rate_limited_until=NULL,version=version+1 WHERE status='rate_limited' AND rate_limited_until<=now() RETURNING id");
      for (const row of recovered.rows) publish('account_status_changed', { accountId: row.id, from: 'rate_limited', to: 'online' });
    } catch (error) { console.error(JSON.stringify({ event: 'outbox_tick_failed', error: String(error) })); }
    finally { busy = false; }
  }
  setInterval(() => { void tick(); }, 250).unref();
  void tick();
}
