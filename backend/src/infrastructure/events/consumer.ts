import type { Pool, PoolClient } from 'pg';
import { applyTerminalEffects, isTerminal, transitions, type AccountStatus } from '../../domains/account/state.js';
import { gatewaySseConnected, gatewaySseReconnects } from '../observability/metrics.js';

type GatewayEvent = { eventId: number; type: string; groupId?: string; [key: string]: unknown };
type Notification = { type: string; payload: Record<string, unknown> };

export interface ConsumerDependencies {
  pool: Pool;
  gatewayUrl: string;
  publish: (type: string, payload: Record<string, unknown>) => void;
}

async function applyEvent(client: PoolClient, event: GatewayEvent): Promise<{ notifications: Notification[]; trigger?: string }> {
  const notifications: Notification[] = [];
  if (event.type === 'message') {
    const group = await client.query('SELECT id, agent_enabled, status FROM groups WHERE gateway_group_id=$1', [event.groupId]);
    if (!group.rowCount) return { notifications };
    const groupId = group.rows[0].id;
    const own = await client.query('SELECT 1 FROM accounts WHERE platform_user_id=$1', [event.senderPlatformUserId]);
    const inserted = await client.query(
      `INSERT INTO messages(group_id,msg_id,text,sender_platform_user_id,sent_at,is_own,delivery_status,media_url)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT(group_id,msg_id) DO NOTHING RETURNING id`,
      [groupId, event.msgId, event.text, event.senderPlatformUserId, event.sentAt, !!own.rowCount, own.rowCount ? 'sent' : null, event.mediaUrl || null],
    );
    if (inserted.rowCount) {
      notifications.push({ type: 'message', payload: { groupId, msgId: event.msgId, isOwn: !!own.rowCount } });
      if (!own.rowCount && group.rows[0].agent_enabled && group.rows[0].status === 'active') {
        await client.query(
          'INSERT INTO agent_pending_messages(group_id,msg_id,sender_platform_user_id,text,sent_at) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING',
          [groupId, event.msgId, event.senderPlatformUserId, event.text, event.sentAt],
        );
      }
      return { notifications };
    }
  }
  if (event.type === 'message_sent') {
    const outbound = await client.query('SELECT id,group_id FROM messages WHERE client_msg_id=$1', [event.clientMsgId]);
    if (outbound.rowCount) {
      await client.query('DELETE FROM messages WHERE group_id=$1 AND msg_id=$2 AND id<>$3 AND client_msg_id IS NULL', [outbound.rows[0].group_id, event.msgId, outbound.rows[0].id]);
      const sent = await client.query(
        `UPDATE messages SET delivery_status='sent',msg_id=$2,sent_at=$3,fail_code=NULL
         WHERE client_msg_id=$1 AND delivery_status NOT IN ('failed','cancelled') RETURNING group_id`,
        [event.clientMsgId, event.msgId, event.sentAt],
      );
      if (sent.rowCount) notifications.push({ type: 'message', payload: { groupId: sent.rows[0].group_id, msgId: event.msgId, isOwn: true } });
    }
  }
  if (event.type === 'message_failed') {
    await client.query("UPDATE messages SET delivery_status='failed',fail_code=$2 WHERE client_msg_id=$1 AND delivery_status NOT IN ('sent','cancelled')", [event.clientMsgId, event.code]);
  }
  if (event.type === 'member_joined' || event.type === 'member_left') {
    const group = await client.query('SELECT id FROM groups WHERE gateway_group_id=$1', [event.groupId]);
    const account = await client.query('SELECT id FROM accounts WHERE platform_user_id=$1', [event.platformUserId]);
    if (group.rowCount && account.rowCount) {
      if (event.type === 'member_joined') {
        await client.query("INSERT INTO group_members(group_id,account_id,platform_user_id,role) VALUES($1,$2,$3,'member') ON CONFLICT DO NOTHING", [group.rows[0].id, account.rows[0].id, event.platformUserId]);
      } else {
        await client.query('DELETE FROM group_members WHERE group_id=$1 AND account_id=$2', [group.rows[0].id, account.rows[0].id]);
      }
    }
  }
  if (event.type === 'account_status') {
    const current = await client.query('SELECT status,platform_user_id FROM accounts WHERE id=$1 FOR UPDATE', [event.accountId]);
    if (current.rowCount) {
      const oldStatus = current.rows[0].status;
      const status = event.status;
      if (!isTerminal(oldStatus) && status !== oldStatus && transitions[oldStatus as AccountStatus]?.includes(status as AccountStatus)) {
        await client.query('UPDATE accounts SET status=$2,version=version+1 WHERE id=$1', [event.accountId, status]);
        notifications.push({ type: 'account_status_changed', payload: { accountId: event.accountId, from: oldStatus, to: status } });
        if (status === 'suspended' || status === 'session_expired') {
          await applyTerminalEffects(client, String(event.accountId));
          notifications.push({ type: 'account_terminal', payload: { accountId: event.accountId, status } });
        }
      }
    }
  }
  return { notifications };
}

export function startGatewayConsumer({ pool, gatewayUrl, publish }: ConsumerDependencies): void {
  let stopped = false;
  const retryCounts = new Map<number, number>();
  async function handleEvent(event: GatewayEvent) {
    const client = await pool.connect();
    let result: Awaited<ReturnType<typeof applyEvent>> = { notifications: [] };
    try {
      await client.query('BEGIN');
      const claim = await client.query('INSERT INTO gateway_events(event_id,type,payload) VALUES($1,$2,$3) ON CONFLICT DO NOTHING RETURNING event_id', [event.eventId, event.type, event]);
      if (claim.rowCount) result = await applyEvent(client, event);
      // Events may arrive out of order. Advance only through a contiguous prefix.
      const cursor = await client.query('SELECT event_id FROM gateway_cursor WHERE id=true FOR UPDATE');
      let next = Number(cursor.rows[0].event_id) + 1;
      while (true) {
        const exists = await client.query('SELECT 1 FROM gateway_events WHERE event_id=$1', [next]);
        if (!exists.rowCount) break;
        next++;
      }
      await client.query('UPDATE gateway_cursor SET event_id=$1 WHERE id=true', [next - 1]);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      console.error(JSON.stringify({ event: 'gateway_event_failed', eventId: event.eventId, error: String(error) }));
      publish('inconsistency', { kind: 'gateway_event', ref: String(event.eventId), message: String(error) });
      const attempts = (retryCounts.get(event.eventId) || 0) + 1;
      retryCounts.set(event.eventId, attempts);
      setTimeout(() => { if (!stopped) void handleEvent(event); }, Math.min(30000, 1000 * 2 ** Math.min(attempts, 5)));
      return;
    } finally {
      client.release();
    }
    retryCounts.delete(event.eventId);
    for (const item of result.notifications) publish(item.type, item.payload);
  }
  async function connect() {
    if (stopped) return;
    gatewaySseReconnects.inc();
    try {
      const cursor = await pool.query('SELECT event_id FROM gateway_cursor WHERE id=true');
      const response = await fetch(`${gatewayUrl}/events?since=${cursor.rows[0].event_id}`);
      if (!response.ok || !response.body) throw new Error(`Gateway SSE returned ${response.status}`);
      gatewaySseConnected.set(1);
      const reader = response.body.getReader();
      let buffer = '';
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += new TextDecoder().decode(value);
        const frames = buffer.split(/\r?\n\r?\n/);
        buffer = frames.pop() || '';
        for (const frame of frames) {
          const data = frame.split(/\r?\n/).find(line => line.startsWith('data: '));
          if (data) await handleEvent(JSON.parse(data.slice(6)) as GatewayEvent);
        }
      }
    } catch (error) {
      console.error(JSON.stringify({ event: 'gateway_sse_disconnected', error: String(error) }));
    }
    gatewaySseConnected.set(0);
    setTimeout(connect, 1000);
  }
  void connect();
  process.once('SIGTERM', () => { stopped = true; });
}
