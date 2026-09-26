import { Registry, collectDefaultMetrics, Counter, Histogram, Gauge } from 'prom-client';
import type { Pool } from 'pg';

const registry = new Registry();
collectDefaultMetrics({ register: registry, prefix: 'sentinel_' });
export const requests = new Counter({ name: 'sentinel_http_requests_total', help: 'HTTP requests by route and status', labelNames: ['method', 'route', 'status'], registers: [registry] });
export const duration = new Histogram({ name: 'sentinel_http_request_duration_seconds', help: 'HTTP request duration', labelNames: ['method', 'route'], buckets: [.005, .01, .025, .05, .1, .25, .5, 1, 2.5, 5, 10], registers: [registry] });
const pendingMessages = new Gauge({ name: 'sentinel_outbox_messages', help: 'Outbound messages by delivery status', labelNames: ['status'], registers: [registry] });
const runningJobs = new Gauge({ name: 'sentinel_running_jobs', help: 'Running jobs by type', labelNames: ['kind'], registers: [registry] });
const gatewayLag = new Gauge({ name: 'sentinel_gateway_cursor_gap', help: 'Persisted events after the contiguous cursor', registers: [registry] });
const oldestUnknown = new Gauge({ name: 'sentinel_oldest_unknown_seconds', help: 'Age of oldest unknown outbound message', registers: [registry] });
export const gatewaySseConnected = new Gauge({ name: 'sentinel_gateway_sse_connected', help: 'One while the gateway event stream is connected', registers: [registry] });
export const gatewaySseReconnects = new Counter({ name: 'sentinel_gateway_sse_reconnects_total', help: 'Gateway event stream reconnect attempts', registers: [registry] });

export async function metricsText(pool: Pool): Promise<string> {
  const status = await pool.query("SELECT delivery_status,count(*)::int AS count FROM messages WHERE delivery_status IN ('queued','accepted','unknown','failed') GROUP BY delivery_status");
  for (const name of ['queued','accepted','unknown','failed']) pendingMessages.set({ status: name }, Number(status.rows.find(row => row.delivery_status === name)?.count || 0));
  const jobs = await pool.query("SELECT kind,count(*)::int AS count FROM jobs WHERE status='running' GROUP BY kind");
  for (const kind of ['create','leave_all']) runningJobs.set({ kind }, Number(jobs.rows.find(row => row.kind === kind)?.count || 0));
  const gap = await pool.query('SELECT COALESCE(MAX(event_id),0)-(SELECT event_id FROM gateway_cursor WHERE id=true) AS gap FROM gateway_events');
  gatewayLag.set(Math.max(0, Number(gap.rows[0].gap)));
  const age = await pool.query("SELECT EXTRACT(EPOCH FROM now()-MIN(attempted_at)) AS age FROM messages WHERE delivery_status='unknown'");
  oldestUnknown.set(Number(age.rows[0].age || 0));
  return registry.metrics();
}
