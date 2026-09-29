import type { Pool, PoolClient } from 'pg';

export type AccountStatus = 'idle' | 'online' | 'rate_limited' | 'disconnected' | 'suspended' | 'session_expired';
export const transitions: Record<AccountStatus, readonly AccountStatus[]> = {
  idle: ['online', 'suspended', 'session_expired'],
  online: ['idle', 'rate_limited', 'disconnected', 'suspended', 'session_expired'],
  rate_limited: ['online', 'disconnected', 'suspended', 'session_expired'],
  disconnected: ['idle', 'online', 'suspended', 'session_expired'],
  suspended: [],
  session_expired: [],
};

export class AccountTransitionError extends Error {
  constructor(public readonly code: 'ACCOUNT_NOT_FOUND' | 'ILLEGAL_TRANSITION' | 'CAS_CONFLICT', message: string) { super(message); }
}

export function isTerminal(status: string): boolean { return status === 'suspended' || status === 'session_expired'; }

export async function applyTerminalEffects(client: PoolClient, accountId: string): Promise<void> {
  await client.query('DELETE FROM group_members WHERE account_id=$1', [accountId]);
  const cancelled = await client.query(
    `UPDATE messages SET delivery_status='cancelled',fail_code='ACCOUNT_TERMINAL'
     WHERE outbound_account_id=$1 AND delivery_status='queued' RETURNING client_msg_id`, [accountId],
  );
  const clientIds = new Set(cancelled.rows.map(row => row.client_msg_id));
  if (!clientIds.size) return;
  const runs = await client.query("SELECT id,steps FROM sequence_runs WHERE status='running' FOR UPDATE");
  for (const run of runs.rows) {
    let changed = false;
    const steps = run.steps.map((step: Record<string, unknown>) => {
      if (clientIds.has(step.clientMsgId)) { changed = true; return { ...step, status: 'skipped', sentAt: new Date().toISOString() }; }
      return step;
    });
    if (changed) await client.query('UPDATE sequence_runs SET steps=$2 WHERE id=$1', [run.id, JSON.stringify(steps)]);
  }
}

export async function transitionAccount(
  pool: Pool,
  accountId: string,
  to: AccountStatus,
  options: { expectedFrom?: AccountStatus; platformUserId?: string; rateLimitedUntil?: Date; allowSameTerminal?: boolean } = {},
): Promise<{ from: AccountStatus; to: AccountStatus; changed: boolean }> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const query = await client.query('SELECT status FROM accounts WHERE id=$1 AND deleted_at IS NULL FOR UPDATE', [accountId]);
    if (!query.rowCount) throw new AccountTransitionError('ACCOUNT_NOT_FOUND', '账号不存在');
    const from = query.rows[0].status as AccountStatus;
    // Terminal states are idempotent across gateway events and operator
    // retries.  Do this before the transition-table check because the table
    // intentionally has no outgoing edges from a terminal state.
    if (options.allowSameTerminal && from === to && isTerminal(to)) {
      if (options.expectedFrom && from !== options.expectedFrom) throw new AccountTransitionError('CAS_CONFLICT', '状态已变化');
      await client.query('COMMIT');
      return { from, to, changed: false };
    }
    if (options.expectedFrom && !transitions[options.expectedFrom]?.includes(to)) throw new AccountTransitionError('ILLEGAL_TRANSITION', '非法状态转移');
    if (options.expectedFrom && from !== options.expectedFrom) throw new AccountTransitionError('CAS_CONFLICT', '状态已变化');
    if (!transitions[from]?.includes(to)) throw new AccountTransitionError('ILLEGAL_TRANSITION', '非法状态转移');
    await client.query(
      'UPDATE accounts SET status=$2,platform_user_id=COALESCE($3,platform_user_id),rate_limited_until=$4,version=version+1 WHERE id=$1',
      [accountId, to, options.platformUserId || null, options.rateLimitedUntil || null],
    );
    if (isTerminal(to)) await applyTerminalEffects(client, accountId);
    await client.query('COMMIT');
    return { from, to, changed: true };
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
}
