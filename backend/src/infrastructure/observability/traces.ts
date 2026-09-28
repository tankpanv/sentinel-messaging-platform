import type { Pool } from 'pg';

export async function recordTrace(pool: Pool, traceId: string | undefined, service: string, eventType: string, payload: Record<string, unknown>): Promise<void> {
  if (!traceId) return;
  try {
    await pool.query('INSERT INTO trace_events(trace_id,service,event_type,payload) VALUES($1,$2,$3,$4)', [traceId, service, eventType, JSON.stringify(payload)]);
  } catch (error) {
    console.error(JSON.stringify({ event: 'trace_record_failed', traceId, error: String(error) }));
  }
}
