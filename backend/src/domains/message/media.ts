import type { Pool } from 'pg';
import fs from 'node:fs/promises';
import path from 'node:path';

type MessageMedia = { id: string; media_url: string; local_file_path: string | null };
const mediaDir = path.resolve(process.env.MEDIA_DIR || path.join(process.cwd(), 'media'));
const retentionDays = Math.max(1, Number(process.env.MEDIA_RETENTION_DAYS || 30));
const maxBytes = Math.max(1024, Number(process.env.MEDIA_MAX_BYTES || 10 * 1024 * 1024));

export function startMediaWorker(pool: Pool, gatewayUrl: string): void {
  const expectedOrigin = new URL(gatewayUrl).origin;
  let busy = false;
  async function download(message: MessageMedia) {
    const url = new URL(message.media_url, gatewayUrl);
    if (url.origin !== expectedOrigin || !/^\/media\/[A-Za-z0-9-]+$/.test(url.pathname)) throw new Error('Media URL is outside gateway media endpoint');
    const response = await fetch(url, { signal: AbortSignal.timeout(10000) });
    if (!response.ok) throw new Error(`Media download returned ${response.status}`);
    if (Number(response.headers.get('content-length') || 0) > maxBytes) throw new Error('Media file exceeds size limit');
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length > maxBytes) throw new Error('Media file exceeds size limit');
    const contentType = String(response.headers.get('content-type') || 'application/octet-stream').split(';')[0];
    await fs.mkdir(mediaDir, { recursive: true });
    const destination = path.join(mediaDir, message.id);
    const temporary = `${destination}.${process.pid}.tmp`;
    await fs.writeFile(temporary, bytes, { flag: 'wx' });
    await fs.rename(temporary, destination);
    await pool.query('UPDATE messages SET local_file_path=$2,media_content_type=$3 WHERE id=$1', [message.id, destination, contentType]);
  }
  async function cleanup() {
    const old = await pool.query<{ id: string; local_file_path: string }>(
      `SELECT m.id,m.local_file_path FROM messages m
       WHERE m.local_file_path IS NOT NULL AND m.sent_at<now()-($1::int*interval '1 day')
       AND NOT EXISTS (SELECT 1 FROM agent_runs r WHERE r.group_id=m.group_id AND r.status='running') LIMIT 100`, [retentionDays],
    );
    for (const item of old.rows) {
      await pool.query('UPDATE messages SET local_file_path=NULL,media_content_type=NULL WHERE id=$1 AND local_file_path=$2', [item.id, item.local_file_path]);
      await fs.unlink(item.local_file_path).catch(error => { if (error.code !== 'ENOENT') throw error; });
    }
  }
  async function tick() {
    if (busy) return;
    busy = true;
    try {
      const claimed = await pool.query<MessageMedia>(
        `UPDATE messages SET media_retry_after=now()+interval '30 seconds',media_download_attempts=media_download_attempts+1
         WHERE id=(SELECT id FROM messages WHERE media_url IS NOT NULL AND local_file_path IS NULL
           AND (media_retry_after IS NULL OR media_retry_after<=now())
           ORDER BY sent_at,id FOR UPDATE SKIP LOCKED LIMIT 1)
         RETURNING id,media_url,local_file_path`,
      );
      if (claimed.rowCount) {
        try { await download(claimed.rows[0]); }
        catch (error) { console.error(JSON.stringify({ event: 'media_download_failed', messageId: claimed.rows[0].id, error: String(error) })); }
      }
      await cleanup();
    } catch (error) { console.error(JSON.stringify({ event: 'media_worker_failed', error: String(error) })); }
    finally { busy = false; }
  }
  setInterval(() => { void tick(); }, 2000).unref();
  void tick();
}

export async function mediaFile(pool: Pool, id: string): Promise<{ path: string; contentType: string } | null> {
  const query = await pool.query('SELECT local_file_path,media_content_type FROM messages WHERE id=$1', [id]);
  if (!query.rows[0]?.local_file_path) return null;
  return { path: query.rows[0].local_file_path, contentType: query.rows[0].media_content_type || 'application/octet-stream' };
}
