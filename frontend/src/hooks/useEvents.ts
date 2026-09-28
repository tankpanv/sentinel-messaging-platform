import { useEffect, useRef } from 'react';
import { currentSession, renewSession } from '../api/client';

type Listener = (type: string, payload: unknown) => void;
const cursorKey = 'sentinel.ws.seq';
const listeners = new Set<Listener>();
let socket: WebSocket | null = null;
let reconnectTimer: number | undefined;
let retryMs = 250;
let renewal: Promise<string | null> | null = null;

function scheduleReconnect(): void {
  if (!listeners.size || reconnectTimer !== undefined || !currentSession()) return;
  const wait = retryMs;
  retryMs = Math.min(retryMs * 2, 2000);
  reconnectTimer = window.setTimeout(() => { reconnectTimer = undefined; connect(); }, wait);
}

function connect(): void {
  if (!listeners.size || socket || !currentSession()) return;
  const active = new WebSocket(`${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/ws`);
  socket = active;
  active.onopen = () => active.send(JSON.stringify({ type: 'auth', accessToken: currentSession()?.token, sinceSeq: Number(localStorage.getItem(cursorKey) || 0) }));
  active.onmessage = event => {
    let frame: { type?: string; success?: boolean; seq?: number; payload?: unknown };
    try { frame = JSON.parse(event.data); } catch { return; }
    if (frame.type === 'auth') {
      if (frame.success) { retryMs = 250; return; }
      renewal ||= renewSession().finally(() => { renewal = null; });
      active.close();
      return;
    }
    const previous = Number(localStorage.getItem(cursorKey) || 0);
    if (!Number.isSafeInteger(frame.seq) || frame.seq! <= previous) return;
    localStorage.setItem(cursorKey, String(frame.seq));
    for (const listener of listeners) listener(frame.type || '', frame.payload);
  };
  active.onclose = () => {
    if (socket === active) socket = null;
    if (renewal) void renewal.then(token => { if (token) scheduleReconnect(); });
    else scheduleReconnect();
  };
  active.onerror = () => active.close();
}

export function useEvents(onEvent: Listener, enabled = true): void {
  const handler = useRef(onEvent);
  handler.current = onEvent;
  useEffect(() => {
    if (!enabled) return;
    const listener: Listener = (type, payload) => handler.current(type, payload);
    listeners.add(listener);
    connect();
    return () => {
      listeners.delete(listener);
      if (!listeners.size) {
        window.clearTimeout(reconnectTimer);
        reconnectTimer = undefined;
        socket?.close();
        socket = null;
        retryMs = 250;
      }
    };
  }, [enabled]);
}
