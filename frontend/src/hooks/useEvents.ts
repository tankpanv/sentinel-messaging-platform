import { useEffect, useRef } from 'react';
import { currentSession } from '../api/client';

const cursorKey = 'sentinel.ws.seq';
export function useEvents(onEvent: (type: string, payload: unknown) => void, enabled = true): void {
  const handler = useRef(onEvent);
  handler.current = onEvent;
  useEffect(() => {
    if (!enabled) return;
    let disposed = false;
    let socket: WebSocket | null = null;
    let timer: number | undefined;
    let retryMs = 250;
    function connect() {
      if (disposed) return;
      socket = new WebSocket(`${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/ws`);
      socket.onopen = () => socket?.send(JSON.stringify({ type: 'auth', accessToken: currentSession()?.token, sinceSeq: Number(localStorage.getItem(cursorKey) || 0) }));
      socket.onmessage = message => {
        const frame = JSON.parse(message.data);
        if (frame.type === 'auth') { if (frame.success) retryMs = 250; return; }
        const previous = Number(localStorage.getItem(cursorKey) || 0);
        if (typeof frame.seq !== 'number' || frame.seq <= previous) return;
        localStorage.setItem(cursorKey, String(frame.seq));
        handler.current(frame.type, frame.payload);
      };
      socket.onclose = () => {
        if (disposed) return;
        timer = window.setTimeout(connect, retryMs);
        retryMs = Math.min(retryMs * 2, 2000);
      };
      socket.onerror = () => socket?.close();
    }
    connect();
    return () => { disposed = true; window.clearTimeout(timer); socket?.close(); };
  }, [enabled]);
}
