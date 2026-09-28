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
export function renewSession(): Promise<string | null> { return renew(); }
const fetchWithRefresh: typeof fetch = async (input, init) => {
  const requestUrl = new URL(input instanceof Request ? input.url : String(input), window.location.href);
  if (requestUrl.origin !== window.location.origin || !requestUrl.pathname.startsWith('/api/')) {
    throw new Error('控制台仅允许通过同源 Backend API 访问服务');
  }
  // Keep a replayable copy for the 401 retry and remember which credential the
  // failed request actually used. Another parallel request may already have
  // rotated the session by the time this 401 arrives.
  const requestInput = input instanceof Request ? input.clone() : input;
  const requestHeaders = new Headers(requestInput instanceof Request ? requestInput.headers : undefined);
  new Headers(init?.headers).forEach((value, name) => requestHeaders.set(name, value));
  const attemptedToken = requestHeaders.get('authorization')?.replace(/^Bearer\s+/i, '') || null;
  const options = { ...init, credentials: 'include' as RequestCredentials };
  let response = await fetch(requestInput, options);
  if (response.status === 401 && session && !requestUrl.pathname.startsWith('/api/auth/')) {
    // If a sibling request already renewed this token, reuse that access token
    // instead of rotating the HttpOnly cookie a second time.
    const fresh = session.token !== attemptedToken ? session.token : await renew();
    if (fresh) {
      const headers = new Headers(options.headers);
      headers.set('Authorization', `Bearer ${fresh}`);
      response = await fetch(requestInput instanceof Request ? requestInput.clone() : requestInput, { ...options, headers });
    }
  }
  return response;
};
export const client = new DefaultApi(new Configuration({ basePath: '', credentials: 'include', accessToken: () => session?.token || '', fetchApi: fetchWithRefresh }));
export async function errorText(error: unknown): Promise<string> {
  const value = error as { response?: Response; message?: string };
  if (value.response) { const body = await value.response.json().catch(() => ({})); return body.error?.message || body.error?.code || value.message || '请求失败'; }
  return value.message || '请求失败';
}
