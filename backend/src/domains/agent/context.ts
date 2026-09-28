export type AgentContextMessage = {
  messageId?: string;
  msgId: string;
  senderPlatformUserId: string;
  isOwn: boolean;
  text: string;
  sentAt: string;
  media?: {
    mediaUrl: string | null;
    localFilePath: string | null;
    fileName: string | null;
    contentType: string | null;
    size: number | null;
    status: string | null;
  };
};

type UnknownMessage = Partial<AgentContextMessage> & Record<string, unknown>;

function normalize(value: UnknownMessage): AgentContextMessage | null {
  if (typeof value.msgId !== 'string' || !value.msgId) return null;
  if (typeof value.senderPlatformUserId !== 'string') return null;
  if (typeof value.text !== 'string') return null;
  const rawSentAt: unknown = value.sentAt;
  const sentAt = rawSentAt instanceof Date
    ? rawSentAt.toISOString()
    : typeof rawSentAt === 'string' ? rawSentAt : null;
  if (!sentAt) return null;
  const result: AgentContextMessage = {
    ...(typeof value.messageId === 'string' ? { messageId: value.messageId } : {}),
    msgId: value.msgId,
    senderPlatformUserId: value.senderPlatformUserId,
    isOwn: value.isOwn === true,
    text: value.text,
    sentAt,
  };
  const rawMedia = value.media;
  if (rawMedia && typeof rawMedia === 'object' && !Array.isArray(rawMedia)) {
    const media = rawMedia as Record<string, unknown>;
    result.media = {
      mediaUrl: typeof media.mediaUrl === 'string' ? media.mediaUrl : null,
      localFilePath: typeof media.localFilePath === 'string' ? media.localFilePath : null,
      fileName: typeof media.fileName === 'string' ? media.fileName : null,
      contentType: typeof media.contentType === 'string' ? media.contentType : null,
      size: typeof media.size === 'number' && Number.isSafeInteger(media.size) ? media.size : null,
      status: typeof media.status === 'string' ? media.status : null,
    };
  }
  return result;
}

function compareMessages(a: AgentContextMessage, b: AgentContextMessage): number {
  const time = Date.parse(a.sentAt) - Date.parse(b.sentAt);
  return Number.isNaN(time) || time === 0 ? a.msgId.localeCompare(b.msgId) : time;
}

function byteLength(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value));
}

/**
 * Builds the context returned by get_recent_messages.
 * Trigger messages are retained before filling the remaining slots with the
 * newest database messages. The result is chronological and de-duplicated.
 */
export function buildRecentAgentMessages(input: {
  triggerMessages: unknown;
  recentMessages: UnknownMessage[];
  limit: number;
  maxBytes?: number;
}): { messages: AgentContextMessage[]; truncated: boolean } {
  const limit = Math.min(50, Math.max(1, Math.trunc(input.limit)));
  const maxBytes = input.maxBytes ?? 8192;
  const triggerMessages = Array.isArray(input.triggerMessages)
    ? input.triggerMessages.map(value => normalize((value || {}) as UnknownMessage)).filter((value): value is AgentContextMessage => !!value)
    : [];
  const triggerIds = new Set(triggerMessages.map(message => message.msgId));

  // Database rows are authoritative when available (for example, if a text
  // was normalized while being persisted), while the run payload is the
  // fallback that guarantees the original trigger remains visible.
  const byId = new Map<string, AgentContextMessage>();
  for (const message of triggerMessages) byId.set(message.msgId, message);
  for (const raw of input.recentMessages) {
    const message = normalize(raw);
    if (message) byId.set(message.msgId, message);
  }

  const triggers = triggerMessages
    .map(message => byId.get(message.msgId) || message)
    .sort(compareMessages);
  const recent = [...byId.values()]
    .filter(message => !triggerIds.has(message.msgId))
    .sort((a, b) => compareMessages(b, a));

  let truncated = triggers.length > limit;
  // Keep the trigger batch first. Normally it contains one or a few messages;
  // if an unusually large batch exceeds the requested limit, the response is
  // bounded and explicitly marked truncated.
  const selected = triggers.slice(0, limit);
  for (const message of recent) {
    if (selected.length >= limit) {
      truncated = true;
      break;
    }
    selected.push(message);
  }

  const result = selected
    .sort(compareMessages)
    .map(message => {
      if (message.text.length <= 500) return { ...message };
      truncated = true;
      return { ...message, text: message.text.slice(0, 500) };
    });

  // Keep the trigger messages while removing supplemental recent messages if
  // the serialized tool result exceeds its 8 KiB protocol budget.
  while (byteLength({ messages: result, truncated }) > maxBytes && result.length > 1) {
    const supplementalIndex = result.findIndex(message => !triggerIds.has(message.msgId));
    result.splice(supplementalIndex >= 0 ? supplementalIndex : result.length - 1, 1);
    truncated = true;
  }
  return { messages: result, truncated };
}
