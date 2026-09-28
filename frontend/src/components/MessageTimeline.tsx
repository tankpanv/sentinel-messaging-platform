import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowLeft, RefreshCw } from 'lucide-react';
import { client, errorText } from '../api/client';
import type { Message } from '../generated';
import { useEvents } from '../hooks/useEvents';
import { Button } from './ui/button';

const keyOf = (message: Message) => message.id || `${message.msgId || ''}:${message.clientMsgId || ''}`;
function mergeMessages(...pages: Message[][]): Message[] {
  const unique = new Map<string, Message>();
  for (const page of pages) for (const message of page) unique.set(keyOf(message), { ...unique.get(keyOf(message)), ...message });
  return [...unique.values()].sort((a, b) => Date.parse(a.sentAt || '') - Date.parse(b.sentAt || '') || String(a.id).localeCompare(String(b.id)));
}

export function MessageTimeline({ groupId, groupName, onBack }: { groupId: string; groupName: string; onBack: () => void }) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadingEarlier, setLoadingEarlier] = useState(false);
  const [error, setError] = useState('');
  const requestId = useRef(0);
  const cursorRef = useRef<string | null>(null);

  const refresh = useCallback(async () => {
    const request = ++requestId.current;
    setLoading(true); setError('');
    try {
      const page = await client.listMessages({ id: groupId, limit: 50 });
      if (request !== requestId.current) return;
      setMessages(old => mergeMessages(page.items, old));
      if (!cursorRef.current) { cursorRef.current = page.nextCursor || null; setCursor(cursorRef.current); }
    } catch (value) { if (request === requestId.current) setError(await errorText(value)); }
    finally { if (request === requestId.current) setLoading(false); }
  }, [groupId]);

  useEffect(() => { setMessages([]); cursorRef.current = null; setCursor(null); void refresh(); return () => { requestId.current++; }; }, [refresh]);
  useEvents((type, payload) => {
    if (type !== 'message' || !payload || typeof payload !== 'object' || (payload as { groupId?: string }).groupId !== groupId) return;
    // Refetch the newest page on a committed message event; merge by database id so
    // an overlapping older-page request cannot duplicate or replace older rows.
    void refresh();
  });

  async function loadEarlier() {
    if (!cursor || loadingEarlier) return;
    const pageCursor = cursor;
    setLoadingEarlier(true); setError('');
    try {
      const page = await client.listMessages({ id: groupId, before: pageCursor, limit: 50 });
      setMessages(old => mergeMessages(old, page.items));
      // Keep the cursor from the page actually requested. A concurrent refresh
      // can update the head cursor independently and must not rewind history.
      if (cursorRef.current === pageCursor) { cursorRef.current = page.nextCursor || null; setCursor(cursorRef.current); }
    } catch (value) { setError(await errorText(value)); }
    finally { setLoadingEarlier(false); }
  }

  return <section className="message-timeline">
    <header className="section-title"><div><Button variant="ghost" onClick={onBack}><ArrowLeft size={15}/>返回群组</Button><h2>群组消息时间线</h2><p className="section-kicker">{groupName} · Backend 持久化消息 · 实时同步</p></div><Button variant="outline" disabled={loading} onClick={() => void refresh()}><RefreshCw size={15}/>刷新</Button></header>
    {error && <p role="alert" className="error">{error}</p>}
    <div className="message-timeline-list" aria-live="polite">
      {cursor && <div className="message-timeline-earlier"><Button variant="outline" disabled={loadingEarlier} onClick={() => void loadEarlier()}>{loadingEarlier ? '加载中…' : '加载更早'}</Button></div>}
      {messages.length === 0 && !loading ? <div className="empty-state">暂无已记录消息</div> : messages.map(message => <article className={`message-timeline-item${message.isOwn ? ' own' : ''}`} data-message-id={message.id} key={keyOf(message)}><div><strong>{message.senderPlatformUserId || '未知发送者'}</strong><p>{message.text}</p>{message.media?.localUrl && <a href={message.media.localUrl} target="_blank" rel="noreferrer">{message.media.fileName || '查看附件'}</a>}<small>{message.sentAt ? new Date(message.sentAt).toLocaleString() : '时间未知'}{message.deliveryStatus ? ` · ${message.deliveryStatus}` : ''}{message.failCode ? ` · ${message.failCode}` : ''}</small></div></article>)}
    </div>
  </section>;
}
