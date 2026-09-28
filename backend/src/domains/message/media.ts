import type { Pool, PoolClient } from 'pg';
import fs from 'node:fs/promises';
import path from 'node:path';

type MessageMedia = { id: string; media_url: string; local_file_path: string | null; media_download_attempts: number };
type StoredRun = { id: string; trigger_messages: unknown; history: unknown; steps: unknown; pending_turn: unknown; summary: string | null };
const mediaDir = path.resolve(process.env.MEDIA_DIR || path.join(process.cwd(), 'media'));
const configuredRetention = Number(process.env.MEDIA_RETENTION_DAYS ?? 30);
const retentionDays = Number.isFinite(configuredRetention) ? Math.max(0, configuredRetention) : 30;
const maxBytes = Math.max(1024, Number(process.env.MEDIA_MAX_BYTES || 10 * 1024 * 1024));
const maxAttempts = Math.max(1, Number(process.env.MEDIA_DOWNLOAD_MAX_ATTEMPTS || 5));

async function withMediaLock<T>(client: PoolClient, messageId: string, action: () => Promise<T>): Promise<T> {
  await client.query('SELECT pg_advisory_xact_lock(82947,hashtext($1))', [messageId]);
  return action();
}

function scrubReferences(value: unknown, references: string[]): unknown {
  if (typeof value === 'string') {
    if (references.includes(value)) return null;
    return references.reduce((result, reference) => result.replaceAll(reference, '[media deleted]'), value);
  }
  if (Array.isArray(value)) return value.map(item => scrubReferences(item, references));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, scrubReferences(item, references)]));
  return value;
}

export function startMediaWorker(pool: Pool, gatewayUrl: string): void {
  const expectedOrigin = new URL(gatewayUrl).origin;
  let busy = false;
  async function download(message: MessageMedia) {
    const url = new URL(message.media_url, gatewayUrl);
    if (url.origin !== expectedOrigin || !/^\/media\/[A-Za-z0-9-]+$/.test(url.pathname) || url.search || url.hash) throw new Error('Media URL is outside gateway media endpoint');
    const response = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(10000) });
    if (!response.ok) throw new Error(`Media download returned ${response.status}`);
    if (Number(response.headers.get('content-length') || 0) > maxBytes) throw new Error('Media file exceeds size limit');
    if (!response.body) throw new Error('Media response has no body');
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of response.body) {
      size += chunk.byteLength;
      if (size > maxBytes) { await response.body.cancel().catch(() => {}); throw new Error('Media file exceeds size limit'); }
      chunks.push(Buffer.from(chunk));
    }
    const bytes = Buffer.concat(chunks);
    const contentType = String(response.headers.get('content-type') || 'application/octet-stream').split(';')[0];
    await fs.mkdir(mediaDir, { recursive: true });
    const destination = path.join(mediaDir, message.id);
    const temporary = `${destination}.${process.pid}.${Date.now()}.tmp`;
    await fs.writeFile(temporary, bytes, { flag: 'wx' });
    let moved = false;
    try {
      await fs.rename(temporary, destination);
      moved = true;
      const saved = await pool.query(
        `UPDATE messages SET local_file_path=$2,media_url=NULL,media_content_type=COALESCE(media_content_type,$3),media_size=$4,
           media_status='ready',media_retry_after=NULL
         WHERE id=$1 AND media_url=$5`,
        [message.id, destination, contentType, bytes.length, message.media_url],
      );
      if (!saved.rowCount) throw new Error('Media message changed before download was saved');
    } catch (error) {
      await fs.unlink(temporary).catch(() => {});
      if (moved) await fs.unlink(destination).catch(() => {});
      throw error;
    }
  }
  async function tick() {
    if (busy) return;
    busy = true;
    try {
      const claimed = await pool.query<MessageMedia>(
        `UPDATE messages SET media_retry_after=now()+interval '30 seconds',media_download_attempts=media_download_attempts+1,media_status='downloading'
         WHERE id=(SELECT id FROM messages WHERE media_url IS NOT NULL AND local_file_path IS NULL
           AND sent_at>=now()-($1::double precision*interval '1 day')
           AND media_download_attempts<$2
           AND (media_retry_after IS NULL OR media_retry_after<=now())
           ORDER BY sent_at,id FOR UPDATE SKIP LOCKED LIMIT 1)
         RETURNING id,media_url,local_file_path,media_download_attempts`,
        [retentionDays, maxAttempts],
      );
      if (claimed.rowCount) {
        const message = claimed.rows[0];
        try { await download(message); }
        catch (error) {
          const exhausted = message.media_download_attempts >= maxAttempts;
          await pool.query("UPDATE messages SET media_status=$2,media_retry_after=CASE WHEN $2='failed' THEN NULL ELSE now()+interval '30 seconds' END WHERE id=$1 AND local_file_path IS NULL AND media_url=$3", [message.id, exhausted ? 'failed' : 'pending', message.media_url]);
          console.error(JSON.stringify({ event: 'media_download_failed', messageId: message.id, attempts: message.media_download_attempts, exhausted, error: String(error) }));
        }
      }
      await cleanupExpiredMedia(pool);
    } catch (error) { console.error(JSON.stringify({ event: 'media_worker_failed', error: String(error) })); }
    finally { busy = false; }
  }
  setInterval(() => { void tick(); }, 2000).unref();
  void tick();
}

export async function cleanupExpiredMedia(pool: Pool): Promise<void> {
    await pool.query(
      `UPDATE messages SET media_url=NULL,media_status='deleted',media_retry_after=NULL
       WHERE local_file_path IS NULL AND media_url IS NOT NULL
         AND sent_at<now()-($1::double precision*interval '1 day')`,
      [retentionDays],
    );
    const old = await pool.query<{ id: string }>(
      `SELECT m.id FROM messages m
       WHERE m.local_file_path IS NOT NULL AND m.sent_at<now()-($1::double precision*interval '1 day')
         AND NOT EXISTS (
           SELECT 1 FROM agent_run_media_refs ref
           JOIN agent_runs run ON run.id=ref.run_id
           WHERE ref.message_id=m.id AND run.status='running'
         )
       ORDER BY m.sent_at,m.id LIMIT 100`, [retentionDays],
    );
    for (const candidate of old.rows) {
      const client = await pool.connect();
      let item: { local_file_path: string; media_url: string | null } | undefined;
      try {
        await client.query('BEGIN');
        item = await withMediaLock(client, candidate.id, async () => {
          const existing = await client.query<{ local_file_path: string; media_url: string | null }>(
            `SELECT m.local_file_path,m.media_url FROM messages m
             WHERE m.id=$1 AND m.local_file_path IS NOT NULL
               AND m.sent_at<now()-($2::double precision*interval '1 day')
               AND NOT EXISTS (
                 SELECT 1 FROM agent_run_media_refs ref
                 JOIN agent_runs run ON run.id=ref.run_id
                 WHERE ref.message_id=m.id AND run.status='running'
               ) FOR UPDATE OF m`,
            [candidate.id, retentionDays],
          );
          if (!existing.rowCount) return undefined;
          const references = [existing.rows[0].local_file_path, existing.rows[0].media_url].filter((value): value is string => !!value);
          const runs = await client.query<StoredRun>(
            `SELECT r.id,r.trigger_messages,r.history,r.steps,r.pending_turn,r.summary
             FROM agent_runs r JOIN agent_run_media_refs ref ON ref.run_id=r.id
             WHERE ref.message_id=$1 AND r.status<>'running' FOR UPDATE OF r`,
            [candidate.id],
          );
          for (const run of runs.rows) await client.query(
            `UPDATE agent_runs SET trigger_messages=$2,history=$3,steps=$4,pending_turn=$5,summary=$6 WHERE id=$1`,
            [run.id,
              JSON.stringify(scrubReferences(run.trigger_messages, references)),
              JSON.stringify(scrubReferences(run.history, references)),
              JSON.stringify(scrubReferences(run.steps, references)),
              run.pending_turn === null ? null : JSON.stringify(scrubReferences(run.pending_turn, references)),
              scrubReferences(run.summary, references)],
          );
          await client.query(
            "UPDATE messages SET local_file_path=NULL,media_url=NULL,media_status='deleted',media_retry_after=NULL WHERE id=$1",
            [candidate.id],
          );
          return existing.rows[0];
        });
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally { client.release(); }
      if (item?.local_file_path) await fs.unlink(item.local_file_path).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'ENOENT') throw error; });
    }
}

export async function mediaFile(pool: Pool, id: string): Promise<{ path: string; contentType: string; fileName: string | null } | null> {
  const query = await pool.query('SELECT local_file_path,media_content_type,media_file_name FROM messages WHERE id=$1', [id]);
  const row = query.rows[0];
  if (!row?.local_file_path) return null;
  try { await fs.access(row.local_file_path); }
  catch {
    await pool.query("UPDATE messages SET local_file_path=NULL,media_url=NULL,media_status='missing' WHERE id=$1 AND local_file_path=$2", [id, row.local_file_path]);
    return null;
  }
  return { path: row.local_file_path, contentType: row.media_content_type || 'application/octet-stream', fileName: row.media_file_name || null };
}
