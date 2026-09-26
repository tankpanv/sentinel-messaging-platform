import { Configuration, DefaultApi } from '../generated';

export type Session = { token: string; role: 'admin' | 'viewer' };
let session: Session | null = (() => { try { return JSON.parse(localStorage.getItem('sentinel.auth') || 'null'); } catch { return null; } })();
let refreshFlight: Promise<string | null> | null = null;
function roleFromToken(token: string): Session['role'] { try { const claims = JSON.parse(atob(token.split('.')[1])); return claims.role === 'admin' ? 'admin' : 'viewer'; } catch { return 'viewer'; } }
export function currentSession() { return session; }
export function setSession(token: string) { session = { token, role: roleFromToken(token) }; localStorage.setItem('sentinel.auth', JSON.stringify(session)); }
export function clearSession() { session = null; localStorage.removeItem('sentinel.auth'); }
async function renew(): Promise<string | null> {
  if (!refreshFlight) refreshFlight = (async () => {
    const response = await fetch('/api/auth/refresh', { method: 'POST', credentials: 'include' });
    if (!response.ok) { clearSession(); return null; }
    const body = await response.json(); setSession(body.accessToken); return body.accessToken as string;
  })().finally(() => { refreshFlight = null; });
  return refreshFlight;
}
const fetchWithRefresh: typeof fetch = async (input, init) => {
  const options = { ...init, credentials: 'include' as RequestCredentials };
  let response = await fetch(input, options);
  if (response.status === 401 && session && !String(input).includes('/api/auth/')) {
    const fresh = await renew();
    if (fresh) { const headers = new Headers(options.headers); headers.set('Authorization', `Bearer ${fresh}`); response = await fetch(input, { ...options, headers }); }
  }
  return response;
};
export const client = new DefaultApi(new Configuration({ basePath: '', credentials: 'include', accessToken: () => session?.token || '', fetchApi: fetchWithRefresh }));
export async function errorText(error: unknown): Promise<string> {
  const value = error as { response?: Response; message?: string };
  if (value.response) { const body = await value.response.json().catch(() => ({})); return body.error?.message || body.error?.code || value.message || '请求失败'; }
  return value.message || '请求失败';
}
