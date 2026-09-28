/** Browser client for the Gateway administration page. It talks to Gateway directly. */
export type GatewayUser = { id: string; platformUserId: string; displayName: string; status: string; capabilities: Array<'edit' | 'delete' | 'join' | 'leave' | 'send' | 'create_group' | 'operate_group'> };
export type GatewayGroup = { id: string; owner: string; members: string[]; admins: string[]; writable: boolean; messageCount: number };
export type GatewayMedia = { id: string; url: string; fileName: string; contentType: string; size: number };
export type GatewayMessage = { groupId: string; msgId: string; clientMsgId?: string; senderPlatformUserId: string; text: string; sentAt: string; mediaUrl?: string; media?: GatewayMedia };
export type GatewayEvent = { eventId: number; type: string; groupId?: string; [key: string]: unknown };

const configured = import.meta.env.VITE_GATEWAY_URL as string | undefined;
const port = import.meta.env.VITE_GATEWAY_PORT || '28081';
export const gatewayOrigin = (configured?.trim() || `${window.location.protocol}//${window.location.hostname}:${port}`).replace(/\/$/, '');

async function request<T>(path: string, body?: object, method?: 'GET' | 'POST' | 'PATCH' | 'DELETE'): Promise<T> {
  const response = await fetch(`${gatewayOrigin}${path}`, {
    method: method || (body === undefined ? 'GET' : 'POST'),
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    cache: 'no-store',
  });
  if (!response.ok) {
    let detail: { code?: string; retryAfterSeconds?: number } = {};
    try { detail = await response.json(); } catch { /* Gateway may return an empty 404/500. */ }
    throw new Error(`${response.status} ${detail.code || response.statusText}${detail.retryAfterSeconds ? ` · ${detail.retryAfterSeconds}s 后重试` : ''}`);
  }
  return response.json() as Promise<T>;
}

const groupPath = (id: string) => `/groups/${encodeURIComponent(id)}`;
async function uploadMedia(file: File): Promise<{ media: GatewayMedia; mediaUrl: string }> {
  const body = new FormData();
  body.append('file', file, file.name);
  const response = await fetch(`${gatewayOrigin}/media`, { method: 'POST', body, cache: 'no-store' });
  if (!response.ok) {
    const detail = await response.json().catch(() => ({})) as { code?: string };
    throw new Error(`${response.status} ${detail.code || response.statusText}`);
  }
  return response.json();
}
export const gateway = {
  health: () => request<{ ok: boolean; eventId: number }>('/health'),
  users: () => request<GatewayUser[]>('/users'),
  createUser: (displayName: string, platformUserId?: string) => request<GatewayUser>('/users', { displayName, ...(platformUserId ? { platformUserId } : {}) }),
  user: (id: string) => request<GatewayUser>(`/users/${encodeURIComponent(id)}`),
  updateUser: (id: string, displayName: string) => request<GatewayUser>(`/users/${encodeURIComponent(id)}`, { displayName }, 'PATCH'),
  deleteUser: (id: string) => request<{ deleted: boolean }>(`/users/${encodeURIComponent(id)}`, undefined, 'DELETE'),
  userJoin: (id: string, groupId: string, inviteLink?: string) => request<{ joined: boolean }>(`/users/${encodeURIComponent(id)}/groups/${encodeURIComponent(groupId)}/join`, inviteLink ? { inviteLink } : {}),
  userLeave: (id: string, groupId: string) => request<{ left: boolean }>(`/users/${encodeURIComponent(id)}/groups/${encodeURIComponent(groupId)}/leave`, {}),
  uploadMedia,
  userSend: (id: string, groupId: string, text: string, clientMsgId: string, mediaId?: string) => request<{ accepted: boolean; deliveryStatus?: string; msgId?: string; sentAt?: string }>(`/users/${encodeURIComponent(id)}/groups/${encodeURIComponent(groupId)}/messages`, { text, clientMsgId, ...(mediaId ? { mediaId } : {}) }),
  groups: () => request<GatewayGroup[]>('/groups'),
  group: (id: string) => request<GatewayGroup>(groupPath(id)),
  messages: (id: string) => request<GatewayMessage[]>(`${groupPath(id)}/messages`),
  createGroup: (creatorUserId: string) => request<{ groupId: string }>(`/users/${encodeURIComponent(creatorUserId)}/groups`, {}),
  invite: (id: string) => request<{ inviteLink: string; readyAfterMs: number }>(`${groupPath(id)}/invite`, {}),
  join: (id: string, accountId: string, inviteLink: string) => request<{ accepted: boolean }>(`${groupPath(id)}/join`, { accountId, inviteLink }),
  promote: (id: string, byAccountId: string, accountId: string) => request<object>(`${groupPath(id)}/promote`, { byAccountId, accountId }),
  promoteUser: (id: string, byUserId: string, targetUserId: string) => request<object>(`${groupPath(id)}/promote-user`, { byUserId, targetUserId }),
  kick: (id: string, byAccountId: string, targetPlatformUserId: string) => request<{ kicked: boolean }>(`${groupPath(id)}/kick`, { byAccountId, targetPlatformUserId }),
  kickUser: (id: string, byUserId: string, targetUserId: string) => request<{ kicked: boolean }>(`${groupPath(id)}/kick-user`, { byUserId, targetUserId }),
  leave: (id: string, accountId: string) => request<object>(`${groupPath(id)}/leave`, { accountId }),
  members: (id: string) => request<{ platformUserId: string }[]>(`${groupPath(id)}/members`),
  send: (id: string, accountId: string, clientMsgId: string, text: string) => request<{ accepted: boolean }>(`${groupPath(id)}/send`, { accountId, clientMsgId, text }),
  byClientId: (id: string, clientMsgId: string) => request<{ msgId: string; sentAt: string }>(`${groupPath(id)}/messages/by-client-id/${encodeURIComponent(clientMsgId)}`),
  externalMessage: (id: string, senderPlatformUserId: string, text: string) => request<{ msgId: string; sentAt: string }>(`${groupPath(id)}/external-message`, { senderPlatformUserId, text }),
  externalMember: (id: string, platformUserId: string, action: 'joined' | 'left') => request<object>(`${groupPath(id)}/external-member`, { platformUserId, action }),
  writeStatus: (id: string, writable: boolean) => request<{ writable: boolean }>(`${groupPath(id)}/write-status`, { writable }),
};

export function gatewayEvents(since: number, onEvent: (event: GatewayEvent) => void, onError: () => void, onOpen: () => void) {
  const source = new EventSource(`${gatewayOrigin}/events?since=${since}`);
  for (const type of ['message', 'message_sent', 'message_failed', 'member_joined', 'member_left', 'account_status']) {
    source.addEventListener(type, message => {
      try { onEvent(JSON.parse((message as MessageEvent).data) as GatewayEvent); } catch { /* Bad frame must not break the stream. */ }
    });
  }
  source.onerror = onError;
  source.onopen = onOpen;
  return () => source.close();
}
