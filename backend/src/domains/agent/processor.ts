import type { Pool } from 'pg';
import { randomUUID } from 'crypto';
import { recordTrace } from '../../infrastructure/observability/traces.js';
import { buildRecentAgentMessages, type AgentContextMessage } from './context.js';

type Json = Record<string, any>;
type Dependencies = { pool: Pool; agentUrl: string; gatewayUrl: string; publish: (type: string, payload: Json) => void };
const TOOL_NAMES = ['get_recent_messages', 'send_message', 'kick_user', 'finish'] as const;
class UnknownKickOutcome extends Error {}
const tools = [
  { name: 'get_recent_messages', description: 'Read recent group messages', input_schema: { type: 'object', required: ['limit'], properties: { limit: { type: 'number' } } } },
  { name: 'send_message', description: 'Send a group message', input_schema: { type: 'object', required: ['text', 'idempotency_key'], properties: { text: { type: 'string' }, idempotency_key: { type: 'string' } } } },
  { name: 'kick_user', description: 'Remove a group member', input_schema: { type: 'object', required: ['platform_user_id', 'reason'], properties: { platform_user_id: { type: 'string' }, reason: { type: 'string' } } } },
  { name: 'finish', description: 'Finish this run', input_schema: { type: 'object', required: ['summary'], properties: { summary: { type: 'string' } } } },
];
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
function isRecord(value: unknown): value is Json { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function validInput(name: string, input: unknown): input is Json {
  if (!isRecord(input)) return false;
  if (name === 'get_recent_messages') return typeof input.limit === 'number' && Number.isFinite(input.limit);
  if (name === 'send_message') return typeof input.text === 'string' && typeof input.idempotency_key === 'string' && !!input.idempotency_key;
  if (name === 'kick_user') return typeof input.platform_user_id === 'string' && typeof input.reason === 'string';
  if (name === 'finish') return typeof input.summary === 'string';
  return false;
}
function boundedContent(value: Json): string {
  let content = JSON.stringify(value);
  if (Buffer.byteLength(content) > 8192) content = JSON.stringify({ truncated: true, code: value.code, message: String(value.message || '').slice(0, 500) });
  return content;
}
function boundedRawResponse(value: string): string {
  const bytes = Buffer.from(value);
  if (bytes.length <= 2048) return value;
  return bytes.subarray(0, 2048).toString('utf8').replace(/\uFFFD$/, '');
}
function mediaFromRow(row: Json): AgentContextMessage['media'] | undefined {
  if (!row.media_url && !row.local_file_path && !row.media_status) return undefined;
  return {
    mediaUrl: row.media_url || null,
    localFilePath: row.local_file_path || null,
    fileName: row.media_file_name || null,
    contentType: row.media_content_type || null,
    size: row.media_size === null || row.media_size === undefined ? null : Number(row.media_size),
    status: row.media_status || null,
  };
}
async function audit(agentUrl: string, text: string, groupId: string, traceId?: string): Promise<'pass' | 'fail' | 'blocked'> {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const response = await fetch(`${agentUrl}/agent/audit`, { method: 'POST', headers: { 'content-type': 'application/json', ...(traceId ? { 'x-trace-id': traceId } : {}) }, body: JSON.stringify({ text, groupId }), signal: AbortSignal.timeout(5000) });
      const body = await response.json();
      if (response.ok && isRecord(body) && body.verdict === 'pass') return 'pass';
      if (response.ok && isRecord(body) && body.verdict === 'fail') return 'fail';
    } catch { /* Retry an unavailable or invalid audit response. */ }
  }
  return 'blocked';
}
async function executeTool(dep: Dependencies, run: Json, group: Json, name: string, input: Json, toolUseId: string): Promise<{ result: Json; auditVerdict?: string; blocked?: boolean }> {
  const { pool, agentUrl, gatewayUrl } = dep;
  if (name === 'get_recent_messages') {
    const limit = Math.min(50, Math.max(1, Math.trunc(input.limit)));
    const triggerMessages = Array.isArray(run.trigger_messages) ? run.trigger_messages : [];
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const candidates = await client.query('SELECT id FROM messages WHERE group_id=$1 ORDER BY sent_at DESC,id DESC LIMIT $2', [run.group_id, limit]);
      const ids = candidates.rows.map(row => String(row.id)).sort();
      for (const messageId of ids) await client.query('SELECT pg_advisory_xact_lock(82947,hashtext($1))', [messageId]);
      const recent = ids.length ? await client.query(
        `SELECT id AS "messageId",msg_id AS "msgId",sender_platform_user_id AS "senderPlatformUserId",is_own AS "isOwn",text,sent_at AS "sentAt",
           media_url,local_file_path,media_file_name,media_content_type,media_size,media_status
         FROM messages WHERE id=ANY($1::uuid[]) ORDER BY sent_at DESC,id DESC`,
        [ids],
      ) : { rows: [] as Json[] };
      const normalized = recent.rows.map((row: Json) => ({ ...row, ...(mediaFromRow(row) ? { media: mediaFromRow(row) } : {}) }));
      const context = buildRecentAgentMessages({ triggerMessages, recentMessages: normalized, limit });
      const referenced = context.messages.map(message => message.messageId).filter((id): id is string => typeof id === 'string');
      if (referenced.length) await client.query(
        `INSERT INTO agent_run_media_refs(run_id,message_id)
         SELECT $1,id FROM messages WHERE id=ANY($2::uuid[]) AND local_file_path IS NOT NULL
         ON CONFLICT DO NOTHING`,
        [run.id, referenced],
      );
      await client.query('COMMIT');
      return { result: context };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally { client.release(); }
  }
  if (name === 'finish') return { result: { ok: true } };
  if (name === 'send_message') {
    const existing = await pool.query('SELECT * FROM agent_tool_effects WHERE run_id=$1 AND idempotency_key=$2', [run.id, input.idempotency_key]);
    if (existing.rowCount) {
      const effect = existing.rows[0];
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline) {
        const message = await pool.query('SELECT delivery_status,fail_code FROM messages WHERE client_msg_id=$1', [effect.client_msg_id]);
        const deliveryStatus = message.rows[0]?.delivery_status || effect.status;
        if (deliveryStatus === 'accepted' || deliveryStatus === 'sent') return { result: { clientMsgId: effect.client_msg_id, deliveryStatus } };
        if (deliveryStatus === 'failed' || deliveryStatus === 'cancelled') return { result: { code: message.rows[0]?.fail_code === 'GROUP_UNREACHABLE' ? 'GROUP_UNREACHABLE' : 'SEND_FAILED', message: 'Message delivery failed' } };
        await sleep(100);
      }
      return { result: { code: 'SEND_TIMEOUT', message: 'Delivery is still unconfirmed' } };
    }
    const account = await pool.query("SELECT m.account_id,m.platform_user_id FROM group_members m JOIN accounts a ON a.id=m.account_id WHERE m.group_id=$1 AND a.status='online' ORDER BY m.account_id LIMIT 1", [run.group_id]);
    if (!account.rowCount) return { result: { code: 'NO_AVAILABLE_ACCOUNT', message: 'No online group account' } };
    const verdict = await audit(agentUrl, input.text, run.group_id, run.trace_id);
    if (verdict === 'blocked') return { result: { code: 'AUDIT_REJECTED', message: 'Audit unavailable' }, auditVerdict: verdict, blocked: true };
    if (verdict === 'fail') return { result: { code: 'AUDIT_REJECTED', message: 'Audit rejected message' }, auditVerdict: verdict };
    const clientMsgId = randomUUID();
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      // Serialize the final account/member check with terminal transitions.  A
      // terminal transition removes members and cancels queued messages in the
      // same transaction, so this prevents a message being inserted after that
      // cleanup and then stranded forever in queued.
      const lockedAccount = await client.query("SELECT m.account_id,m.platform_user_id FROM group_members m JOIN accounts a ON a.id=m.account_id WHERE m.group_id=$1 AND m.account_id=$2 AND a.status='online' FOR UPDATE OF a,m", [run.group_id, account.rows[0].account_id]);
      if (!lockedAccount.rowCount) {
        await client.query('ROLLBACK');
        return { result: { code: 'SEND_FAILED', message: 'Selected account became unavailable' }, auditVerdict: verdict };
      }
      await client.query("INSERT INTO messages(group_id,client_msg_id,text,sender_platform_user_id,sent_at,delivery_status,is_own,outbound_account_id,trace_id) VALUES($1,$2,$3,$4,now(),'queued',true,$5,$6)", [run.group_id, clientMsgId, input.text, lockedAccount.rows[0].platform_user_id, lockedAccount.rows[0].account_id, run.trace_id || null]);
      await client.query("INSERT INTO agent_tool_effects(run_id,idempotency_key,tool_name,status,client_msg_id) VALUES($1,$2,'send_message','queued',$3)", [run.id, input.idempotency_key, clientMsgId]);
      await client.query('COMMIT');
    } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      const message = await pool.query('SELECT delivery_status,fail_code FROM messages WHERE client_msg_id=$1', [clientMsgId]);
      const status = message.rows[0].delivery_status;
      if (status === 'accepted' || status === 'sent') return { result: { clientMsgId, deliveryStatus: status }, auditVerdict: verdict };
      if (status === 'failed' || status === 'cancelled') return { result: { code: status === 'failed' && message.rows[0].fail_code === 'GROUP_UNREACHABLE' ? 'GROUP_UNREACHABLE' : 'SEND_FAILED', message: 'Message delivery failed' }, auditVerdict: verdict };
      await sleep(100);
    }
    return { result: { code: 'SEND_TIMEOUT', message: 'Delivery is still unconfirmed' }, auditVerdict: verdict };
  }
  if (name === 'kick_user') {
    // A model retry uses a new tool_use.id. Persist the target within this run
    // so a 504 or a process restart can be reconciled before another kick.
    const effectKey = `kick:${input.platform_user_id}`;
    const previous = await pool.query('SELECT * FROM agent_tool_effects WHERE run_id=$1 AND idempotency_key=$2', [run.id, effectKey]);
    if (!group.auto_kick_enabled && !previous.rowCount) return { result: { code: 'POLICY_DENIED', message: 'Auto kick is disabled' } };
    if (previous.rowCount) {
      if (previous.rows[0].status === 'done') return { result: { kicked: true } };
      // A timed-out kick may still complete. The gateway promises convergence within two seconds.
      await sleep(2500);
      const current = await fetch(`${gatewayUrl}/groups/${group.gateway_group_id}/members`, { headers: run.trace_id ? { 'x-trace-id': run.trace_id } : undefined, signal: AbortSignal.timeout(5000) });
      if (!current.ok) throw new UnknownKickOutcome(`kick reconciliation unavailable: ${current.status}`);
      const members = await current.json() as { platformUserId: string }[];
      if (!members.some(member => member.platformUserId === input.platform_user_id)) {
        await pool.query("UPDATE agent_tool_effects SET status='done',result=$3 WHERE run_id=$1 AND idempotency_key=$2", [run.id, effectKey, { kicked: true }]);
        return { result: { kicked: true }, auditVerdict: 'pass' };
      }
    }
    if (!group.auto_kick_enabled) return { result: { code: 'POLICY_DENIED', message: 'Auto kick is disabled' } };
    const account = await pool.query("SELECT m.account_id FROM group_members m JOIN accounts a ON a.id=m.account_id WHERE m.group_id=$1 AND m.role IN ('creator','admin') AND a.status='online' ORDER BY (m.role='creator') DESC LIMIT 1", [run.group_id]);
    if (!account.rowCount) return { result: { code: 'NO_AVAILABLE_ACCOUNT', message: 'No online admin account' } };
    const verdict = previous.rowCount ? 'pass' : await audit(agentUrl, JSON.stringify({ action: 'kick', platform_user_id: input.platform_user_id, reason: input.reason }), run.group_id, run.trace_id);
    if (verdict === 'blocked') return { result: { code: 'AUDIT_REJECTED', message: 'Audit unavailable' }, auditVerdict: verdict, blocked: true };
    if (verdict === 'fail') return { result: { code: 'AUDIT_REJECTED', message: 'Audit rejected kick' }, auditVerdict: verdict };
    await pool.query("INSERT INTO agent_tool_effects(run_id,idempotency_key,tool_name,status) VALUES($1,$2,'kick_user','pending') ON CONFLICT DO NOTHING", [run.id, effectKey]);
    let response: Response;
    try {
      response = await fetch(`${gatewayUrl}/groups/${group.gateway_group_id}/kick`, { method: 'POST', headers: { 'content-type': 'application/json', ...(run.trace_id ? { 'x-trace-id': run.trace_id } : {}) }, body: JSON.stringify({ byAccountId: account.rows[0].account_id, targetPlatformUserId: input.platform_user_id }), signal: AbortSignal.timeout(15000) });
    } catch (error) { throw new UnknownKickOutcome(String(error)); }
    if (!response.ok) {
      if (response.status === 504 || response.status === 503) throw new UnknownKickOutcome(`kick outcome uncertain: ${response.status}`);
      const body = await response.json().catch(() => ({})) as Json;
      await pool.query('DELETE FROM agent_tool_effects WHERE run_id=$1 AND idempotency_key=$2', [run.id, effectKey]);
      return { result: { code: body.code || 'NO_PERMISSION', message: 'Kick failed' }, auditVerdict: verdict };
    }
    await pool.query("UPDATE agent_tool_effects SET status='done',result=$3 WHERE run_id=$1 AND idempotency_key=$2", [run.id, effectKey, { kicked: true }]);
    return { result: { kicked: true }, auditVerdict: verdict };
  }
  return { result: { code: 'UNKNOWN_TOOL', message: `Unknown tool ${name}` } };
}

export function startAgentProcessor(dep: Dependencies): void {
  const { pool, agentUrl, publish } = dep;
  const localBusy = new Set<string>();
  async function startRuns() {
    const groups = await pool.query(
      `SELECT DISTINCT p.group_id FROM agent_pending_messages p
       JOIN groups g ON g.id=p.group_id
       LEFT JOIN messages m ON m.id=p.message_id
       WHERE g.agent_enabled=true AND g.status='active'
         AND (p.message_id IS NULL OR m.media_url IS NULL OR m.local_file_path IS NOT NULL OR m.media_status IN ('failed','missing','deleted'))`,
    );
    for (const row of groups.rows) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query('SELECT id FROM groups WHERE id=$1 FOR UPDATE', [row.group_id]);
        const active = await client.query("SELECT 1 FROM agent_runs WHERE group_id=$1 AND status='running'", [row.group_id]);
        if (active.rowCount) { await client.query('COMMIT'); continue; }
        // Atomically claim the queue. A message inserted after this statement
        // starts remains queued for the next run; it cannot be deleted without
        // being included in this run's triggerMessages.
        const pending = await client.query(`
          WITH claimed AS (
            SELECT p.group_id,p.msg_id
            FROM agent_pending_messages p
            LEFT JOIN messages m ON m.id=p.message_id
            WHERE p.group_id=$1
              AND (p.message_id IS NULL OR m.media_url IS NULL OR m.local_file_path IS NOT NULL OR m.media_status IN ('failed','missing','deleted'))
            ORDER BY p.sent_at,p.msg_id
            FOR UPDATE OF p SKIP LOCKED
          ), deleted AS (
            DELETE FROM agent_pending_messages p
            USING claimed c
            WHERE p.group_id=c.group_id AND p.msg_id=c.msg_id
            RETURNING p.*
          )
          SELECT * FROM deleted ORDER BY sent_at,msg_id
        `, [row.group_id]);
        if (!pending.rowCount) { await client.query('COMMIT'); continue; }
        const mediaMessageIds = pending.rows.map((message: Json) => message.message_id).filter((id: unknown): id is string => typeof id === 'string').sort();
        for (const messageId of mediaMessageIds) await client.query('SELECT pg_advisory_xact_lock(82947,hashtext($1))', [messageId]);
        const mediaRows = mediaMessageIds.length ? await client.query(
          `SELECT id,media_url,local_file_path,media_file_name,media_content_type,media_size,media_status
           FROM messages WHERE id=ANY($1::uuid[])`,
          [mediaMessageIds],
        ) : { rows: [] as Json[] };
        const mediaById = new Map(mediaRows.rows.map((message: Json) => [String(message.id), message]));
        const triggers = pending.rows.map((message: Json) => {
          const mediaRow = mediaById.get(String(message.message_id));
          return {
            ...(message.message_id ? { messageId: message.message_id } : {}),
            msgId: message.msg_id,
            senderPlatformUserId: message.sender_platform_user_id,
            isOwn: false,
            text: message.text,
            sentAt: message.sent_at,
            ...(mediaRow && mediaFromRow(mediaRow) ? { media: mediaFromRow(mediaRow) } : {}),
          };
        });
        const run = await client.query("INSERT INTO agent_runs(group_id,status,trigger_messages,history,trace_id) VALUES($1,'running',$2,'[]',$3) RETURNING id", [row.group_id, JSON.stringify(triggers), pending.rows[0].trace_id || `agent-${row.group_id}`]);
        if (mediaMessageIds.length) await client.query(
          `INSERT INTO agent_run_media_refs(run_id,message_id)
           SELECT $1,id FROM messages WHERE id=ANY($2::uuid[]) AND local_file_path IS NOT NULL
           ON CONFLICT DO NOTHING`,
          [run.rows[0].id, mediaMessageIds],
        );
        await client.query('INSERT INTO trace_events(trace_id,service,event_type,payload) VALUES($1,$2,$3,$4)', [pending.rows[0].trace_id || `agent-${row.group_id}`, 'backend', 'agent_run_created', JSON.stringify({ runId: run.rows[0].id, groupId: row.group_id, triggerCount: triggers.length })]);
        await client.query('COMMIT');
        publish('agent_run', { runId: run.rows[0].id, groupId: row.group_id, status: 'running', endReason: null });
      } catch (error) { await client.query('ROLLBACK'); console.error(JSON.stringify({ event: 'agent_start_failed', groupId: row.group_id, error: String(error) })); }
      finally { client.release(); }
    }
  }
  async function processOne(id: string) {
    if (localBusy.has(id)) return;
    localBusy.add(id);
    const lock = await pool.connect();
    let acquired = false;
    try {
      const lockResult = await lock.query('SELECT pg_try_advisory_lock(82946,hashtext($1)) AS acquired', [id]);
      acquired = lockResult.rows[0].acquired;
      if (!acquired) return;
      const claim = await pool.query("SELECT * FROM agent_runs WHERE id=$1 AND status='running'", [id]);
      if (!claim.rowCount) return;
      const started = Date.now();
      const run = claim.rows[0] as Json;
    let status = 'running'; let endReason: string | null = null; let summary: string | null = null;
    let steps = run.steps as Json[]; let history = run.history as Json[];
    let protocolErrors = run.protocol_errors as number;
    try {
      const groupQuery = await pool.query('SELECT * FROM groups WHERE id=$1', [run.group_id]);
      const group = groupQuery.rows[0] as Json;
      if (!group || !group.agent_enabled || group.status !== 'active') { status = 'cancelled'; endReason = 'cancelled'; }
      else if (steps.length >= 12) { status = 'failed'; endReason = 'budget_exhausted'; }
      else {
        if (!history.length) {
          const own = await pool.query('SELECT platform_user_id FROM group_members WHERE group_id=$1', [run.group_id]);
          history = [{ role: 'user', content: [{ type: 'text', text: JSON.stringify({ groupId: run.group_id, triggerMessages: run.trigger_messages, policy: { autoKickEnabled: group.auto_kick_enabled }, ownPlatformUserIds: own.rows.map((a: Json) => a.platform_user_id) }) }] }];
          // The Agent service binds runId to this exact first context. Persist
          // it before the outbound request so a restart never recomputes a
          // different context after policy or membership changes.
          await pool.query('UPDATE agent_runs SET history=$2 WHERE id=$1 AND history=$3::jsonb', [id, JSON.stringify(history), '[]']);
        }
        let raw = ''; let response: Json | undefined; let protocolCode: string | null = null;
        if (run.pending_turn) {
          raw = run.pending_turn.raw;
          response = run.pending_turn.response;
        } else {
          try {
            const timeoutMs = Math.min(15000, Math.max(10000, Number(process.env.AGENT_TURN_TIMEOUT_MS || 15000)));
            const result = await fetch(`${agentUrl}/agent/turn`, { method: 'POST', headers: { 'content-type': 'application/json', ...(run.trace_id ? { 'x-trace-id': run.trace_id } : {}) }, body: JSON.stringify({ runId: id, tools, messages: history }), signal: AbortSignal.timeout(timeoutMs) });
            raw = await result.text();
            response = JSON.parse(raw);
            if (!result.ok || !isRecord(response) || !['tool_use', 'end_turn'].includes(response.stop_reason) || !Array.isArray(response.content) || response.content.length !== 1 || !isRecord(response.content[0]) || response.content[0].type !== (response.stop_reason === 'end_turn' ? 'text' : 'tool_use')) protocolCode = 'BAD_JSON';
            else if (response.stop_reason === 'end_turn' && typeof response.content[0].text !== 'string') protocolCode = 'BAD_JSON';
            else if (response.stop_reason === 'tool_use' && (typeof response.content[0].id !== 'string' || !response.content[0].id || typeof response.content[0].name !== 'string' || !isRecord(response.content[0].input))) protocolCode = 'BAD_JSON';
          } catch (error) { protocolCode = (error as Error).name === 'TimeoutError' ? 'TURN_TIMEOUT' : 'BAD_JSON'; }
        }
        const block = response?.content?.[0] as Json | undefined;
        if (!protocolCode && block?.type === 'tool_use' && steps.some(step => step.toolUseId === block.id)) protocolCode = 'DUPLICATE_TOOL_USE_ID';
        if (!protocolCode && response?.stop_reason === 'tool_use' && !run.pending_turn) await pool.query('UPDATE agent_runs SET pending_turn=$2 WHERE id=$1', [id, JSON.stringify({ raw, response })]);
        if (protocolCode) {
          protocolErrors++;
          steps.push({ kind: 'protocol_error', toolUseId: null, name: null, input: null, resultSummary: protocolCode, isError: true, errorCode: protocolCode, auditVerdict: null, rawResponse: boundedRawResponse(raw) });
          history.push({ role: 'user', content: [{ type: 'text', text: `PROTOCOL_ERROR ${protocolCode}: Please return one valid tool call or final text.` }] });
          if (protocolErrors >= 3) { status = 'failed'; endReason = 'protocol_errors'; }
        } else if (response?.stop_reason === 'end_turn') {
          protocolErrors = 0; status = 'finished'; endReason = 'final'; summary = block?.text || '';
          steps.push({ kind: 'final', toolUseId: null, name: null, input: null, resultSummary: (summary || '').slice(0, 200), isError: false, errorCode: null, auditVerdict: null, rawResponse: boundedRawResponse(raw) });
        } else if (block) {
          protocolErrors = 0;
          const name = block.name as string; const input = block.input;
          let outcome: Awaited<ReturnType<typeof executeTool>>;
          if (!TOOL_NAMES.includes(name as any)) outcome = { result: { code: 'UNKNOWN_TOOL', message: `Unknown tool ${name}` } };
          else if (!validInput(name, input)) outcome = { result: { code: 'INVALID_INPUT', message: 'Invalid tool input' } };
          else {
            try {
              outcome = await executeTool(dep, run, group, name, input, block.id);
            } catch (error) {
              // A transport or database failure does not prove that a side effect
              // failed. Keep the persisted turn so restart/retry reconciles the
              // same operation instead of telling the model to issue it again.
              console.error(JSON.stringify({ event: 'agent_tool_uncertain', runId: id, toolUseId: block.id, error: String(error) }));
              const remainingMs = Math.max(0, Number(run.remaining_ms) - (Date.now() - started));
              if (remainingMs > 0) {
                await pool.query('UPDATE agent_runs SET remaining_ms=$2 WHERE id=$1', [id, remainingMs]);
              } else {
                steps.push({ kind: 'tool_use', toolUseId: block.id, name, input, resultSummary: '工具结果尚未确认，运行时间已耗尽', isError: false, errorCode: null, auditVerdict: name === 'kick_user' ? 'pass' : null, rawResponse: boundedRawResponse(raw) });
                await pool.query("UPDATE agent_runs SET status='failed',end_reason='wall_clock',steps=$2,remaining_ms=0,pending_turn=NULL WHERE id=$1", [id, JSON.stringify(steps)]);
                publish('agent_run', { runId: id, groupId: run.group_id, status: 'failed', endReason: 'wall_clock', stepCount: steps.length });
              }
              return;
            }
          }
          await recordTrace(pool, run.trace_id, 'backend', 'agent_tool', { runId: id, toolUseId: block.id, name, errorCode: outcome.result.code || null });
          const isError = typeof outcome.result.code === 'string';
          steps.push({ kind: 'tool_use', toolUseId: block.id, name, input, resultSummary: boundedContent(outcome.result).slice(0, 200), isError, errorCode: isError ? outcome.result.code : null, auditVerdict: outcome.auditVerdict || null, rawResponse: boundedRawResponse(raw) });
          history.push({ role: 'assistant', content: [block] }, { role: 'user', content: [{ type: 'tool_result', tool_use_id: block.id, is_error: isError, content: boundedContent(outcome.result) }] });
          if (outcome.blocked) { status = 'blocked'; endReason = 'audit_blocked'; }
          else if (name === 'finish' && !isError) { status = 'finished'; endReason = 'final'; summary = input.summary; }
        }
      }
      if (status === 'running' && steps.length >= 12) { status = 'failed'; endReason = 'budget_exhausted'; }
      if (status !== 'cancelled') {
        const latest = await pool.query('SELECT status,agent_enabled FROM groups WHERE id=$1', [run.group_id]);
        if (!latest.rows[0] || latest.rows[0].status !== 'active' || !latest.rows[0].agent_enabled) { status = 'cancelled'; endReason = 'cancelled'; }
      }
      const remainingMs = Math.max(0, Number(run.remaining_ms) - (Date.now() - started));
      if (status === 'running' && remainingMs === 0) { status = 'failed'; endReason = 'wall_clock'; }
      await pool.query('UPDATE agent_runs SET status=$2,end_reason=$3,summary=$4,steps=$5,history=$6,protocol_errors=$7,remaining_ms=$8,lease_until=NULL,pending_turn=NULL WHERE id=$1', [id, status, endReason, summary, JSON.stringify(steps), JSON.stringify(history), protocolErrors, remainingMs]);
      // Publish after persistence so an open detail view can fetch each new step.
      publish('agent_run', { runId: id, groupId: run.group_id, status, endReason, stepCount: steps.length });
    } catch (error) { console.error(JSON.stringify({ event: 'agent_step_failed', runId: id, error: String(error) })); }
    } finally {
      if (acquired) await lock.query('SELECT pg_advisory_unlock(82946,hashtext($1))', [id]);
      lock.release();
      localBusy.delete(id);
    }
  }
  async function tick() {
    try {
      await startRuns();
      const running = await pool.query("SELECT id FROM agent_runs WHERE status='running' ORDER BY created_at LIMIT 20");
      for (const row of running.rows) void processOne(row.id);
    } catch (error) { console.error(JSON.stringify({ event: 'agent_tick_failed', error: String(error) })); }
    setTimeout(tick, 500);
  }
  void tick();
}
