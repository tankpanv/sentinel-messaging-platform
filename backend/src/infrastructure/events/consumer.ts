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
    const eventMedia = event.media && typeof event.media === 'object' ? event.media as Record<string, unknown> : {};
    const mediaUrl = typeof event.mediaUrl === 'string' && event.mediaUrl ? event.mediaUrl : typeof eventMedia.url === 'string' ? eventMedia.url : null;
    const mediaFileName = typeof eventMedia.fileName === 'string' ? eventMedia.fileName.slice(0, 255) : null;
    const mediaContentType = typeof eventMedia.contentType === 'string' ? eventMedia.contentType.slice(0, 255) : null;
    const mediaSize = typeof eventMedia.size === 'number' && Number.isSafeInteger(eventMedia.size) && eventMedia.size >= 0 ? eventMedia.size : null;
    const inserted = await client.query(
      `INSERT INTO messages(group_id,msg_id,text,sender_platform_user_id,sent_at,is_own,delivery_status,media_url,media_file_name,media_content_type,media_size,media_status,trace_id)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
       ON CONFLICT(group_id,msg_id) DO NOTHING RETURNING id`,
      [groupId, event.msgId, String(event.text || ''), event.senderPlatformUserId, event.sentAt, !!own.rowCount, own.rowCount ? 'sent' : null, mediaUrl, mediaFileName, mediaContentType, mediaSize, mediaUrl ? 'pending' : null, String(event.traceId || `gateway-${event.eventId}`)],
    );
    if (inserted.rowCount) {
      await client.query('INSERT INTO trace_events(trace_id,service,event_type,payload) VALUES($1,$2,$3,$4)', [String(event.traceId || `gateway-${event.eventId}`), 'backend', 'gateway_message_received', JSON.stringify({ eventId: event.eventId, groupId, msgId: event.msgId, senderPlatformUserId: event.senderPlatformUserId })]);
      notifications.push({ type: 'message', payload: { groupId, msgId: event.msgId, isOwn: !!own.rowCount, hasMedia: !!mediaUrl } });
      if (!own.rowCount && group.rows[0].agent_enabled && group.rows[0].status === 'active') {
        await client.query(
          'INSERT INTO agent_pending_messages(group_id,msg_id,sender_platform_user_id,text,sent_at,trace_id,message_id) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING',
          [groupId, event.msgId, event.senderPlatformUserId, String(event.text || ''), event.sentAt, String(event.traceId || `gateway-${event.eventId}`), inserted.rows[0].id],
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
    const failed = await client.query("UPDATE messages SET delivery_status='failed',fail_code=$2 WHERE client_msg_id=$1 AND delivery_status NOT IN ('sent','cancelled') RETURNING group_id,msg_id,outbound_account_id", [event.clientMsgId, event.code]);
    if (failed.rowCount) notifications.push({ type: 'message', payload: { groupId: failed.rows[0].group_id, msgId: failed.rows[0].msg_id || null, isOwn: true, deliveryStatus: 'failed', failCode: event.code } });
    if (failed.rowCount && event.code === 'GROUP_WRITE_FORBIDDEN') {
      const groupId = failed.rows[0].group_id;
      await client.query("UPDATE groups SET status='unreachable',agent_enabled=false WHERE id=$1 AND status='active'", [groupId]);
      const stopped = await client.query("UPDATE sequence_runs SET status='stopped' WHERE group_id=$1 AND status='running' RETURNING id,current_step_index", [groupId]);
      await client.query("UPDATE messages SET delivery_status='cancelled',fail_code='GROUP_UNREACHABLE' WHERE group_id=$1 AND delivery_status='queued'", [groupId]);
      notifications.push({ type: 'group_unreachable', payload: { groupId, reason: 'GROUP_WRITE_FORBIDDEN' } });
      for (const run of stopped.rows) notifications.push({ type: 'sequence_run', payload: { runId: run.id, groupId, status: 'stopped', currentStepIndex: run.current_step_index } });
    }
    if (failed.rowCount && (event.code === 'ACCOUNT_SUSPENDED' || event.code === 'SESSION_EXPIRED') && failed.rows[0].outbound_account_id) {
      const accountId = failed.rows[0].outbound_account_id;
      const account = await client.query('SELECT status FROM accounts WHERE id=$1 FOR UPDATE', [accountId]);
      if (account.rowCount && !isTerminal(account.rows[0].status)) {
        const terminal = event.code === 'ACCOUNT_SUSPENDED' ? 'suspended' : 'session_expired';
        await client.query('UPDATE accounts SET status=$2,rate_limited_until=NULL,version=version+1 WHERE id=$1', [accountId, terminal]);
        await applyTerminalEffects(client, accountId);
        notifications.push({ type: 'account_status_changed', payload: { accountId, from: account.rows[0].status, to: terminal } });
        notifications.push({ type: 'account_terminal', payload: { accountId, status: terminal } });
      }
    }
  }
  if (event.type === 'member_joined' || event.type === 'member_left') {
    const group = await client.query('SELECT id FROM groups WHERE gateway_group_id=$1', [event.groupId]);
    const account = await client.query('SELECT id FROM accounts WHERE platform_user_id=$1', [event.platformUserId]);
    if (group.rowCount) {
      if (account.rowCount) {
      if (event.type === 'member_joined') {
        await client.query("INSERT INTO group_members(group_id,account_id,platform_user_id,role) VALUES($1,$2,$3,'member') ON CONFLICT DO NOTHING", [group.rows[0].id, account.rows[0].id, event.platformUserId]);
        const completed = await client.query("UPDATE group_join_requests SET status='joined',error_code=NULL,decided_at=now() WHERE group_id=$1 AND account_id=$2 AND status IN ('pending','approved') RETURNING id", [group.rows[0].id, account.rows[0].id]);
        for (const row of completed.rows) notifications.push({ type: 'group_join_request_changed', payload: { groupId: group.rows[0].id, requestId: row.id, accountId: account.rows[0].id, status: 'joined' } });
      } else {
        await client.query('DELETE FROM group_members WHERE group_id=$1 AND account_id=$2', [group.rows[0].id, account.rows[0].id]);
      }
      }
      notifications.push({ type: 'group_members_changed', payload: { groupId: group.rows[0].id, accountId: account.rows[0]?.id || null, platformUserId: event.platformUserId, action: event.type === 'member_joined' ? 'joined' : 'left' } });
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
      let since = Number(cursor.rows[0].event_id);
      const health = await fetch(`${gatewayUrl}/health`, { signal: AbortSignal.timeout(5000) });
      if (health.ok) {
        const healthBody = await health.json() as { eventId?: number };
        if (Number.isSafeInteger(healthBody.eventId) && Number(healthBody.eventId) < since) {
          // The gateway state was restored from an older snapshot. Its event log is authoritative now.
          await pool.query('BEGIN');
          try {
            await pool.query('TRUNCATE gateway_events');
            await pool.query('UPDATE gateway_cursor SET event_id=0 WHERE id=true');
            await pool.query('COMMIT');
            since = 0;
          } catch (error) { await pool.query('ROLLBACK'); throw error; }
        }
      }
      const response = await fetch(`${gatewayUrl}/events?since=${since}`);
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
