import { readFileSync, readdirSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const sourceRoot = resolve(root, 'frontend/src');
const errors = [];
function walk(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.name === 'generated') continue;
    const file = join(directory, entry.name);
    if (entry.isDirectory()) walk(file);
    else if (/\.tsx?$/.test(entry.name)) {
      const source = readFileSync(file, 'utf8');
      const name = relative(sourceRoot, file).replaceAll('\\', '/');
      if (name !== 'api/gateway.ts' && /GATEWAY_URL|GATEWAY_PORT|gateway-service|\bEventSource\b/.test(source)) errors.push(`${name}: direct Gateway access belongs only in api/gateway.ts`);
      if (!['api/client.ts', 'api/gateway.ts'].includes(name) && /\bfetch\s*\(/.test(source)) errors.push(`${name}: browser HTTP access belongs in the Backend or Gateway API client`);
      if (!['hooks/useEvents.ts', 'api/gateway.ts'].includes(name) && /\b(?:WebSocket|EventSource|XMLHttpRequest|sendBeacon)\b/.test(source)) errors.push(`${name}: browser streaming belongs in the Backend WS or Gateway SSE client`);
    }
  }
}
walk(sourceRoot);
const client = readFileSync(resolve(sourceRoot, 'api/client.ts'), 'utf8');
if (!client.includes('requestUrl.origin !== window.location.origin') || !client.includes("requestUrl.pathname.startsWith('/api/')")) errors.push('api/client.ts: missing same-origin Backend API guard');
const events = readFileSync(resolve(sourceRoot, 'hooks/useEvents.ts'), 'utf8');
if (!events.includes('location.host}/ws')) errors.push('hooks/useEvents.ts: WebSocket must use same-origin /ws');
const html = readFileSync(resolve(root, 'frontend/index.html'), 'utf8');
if (!html.includes("connect-src 'self' http: https: ws: wss:")) errors.push('frontend/index.html: Gateway management page requires cross-origin Gateway connections');
const runtime = readFileSync(resolve(sourceRoot, 'generated/runtime.ts'), 'utf8');
if (!runtime.includes('export const BASE_PATH = "";')) errors.push('generated/runtime.ts: default API base path must be same-origin');
const vite = readFileSync(resolve(root, 'frontend/vite.config.ts'), 'utf8');
if (!vite.includes("'/api': backendUrl") || !vite.includes("'/ws': backendUrl")) errors.push('vite.config.ts: /api and /ws must proxy only to Backend');
if (errors.length) { console.error(errors.join('\n')); process.exitCode = 1; }
else console.log('Frontend boundary OK: platform uses Backend /api and /ws; Gateway management page uses the direct Gateway client.');
