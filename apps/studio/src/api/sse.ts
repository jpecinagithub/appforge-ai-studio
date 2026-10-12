import { API_BASE, getToken, isDemoMode } from './client';
import { demoSimulateRunEvents } from './demo';
import type { RunEventKind } from './types';

export interface StreamEvent {
  seq: number;
  kind: RunEventKind;
  data: unknown;
}

export interface SseHandlers {
  onEvent: (ev: StreamEvent) => void;
  onError: (err: Error) => void;
  onClose: () => void;
}

/**
 * Suscripción a GET /api/runs/:runId/events (SSE).
 * Usa fetch+stream para poder enviar el header Authorization (EventSource no lo permite).
 * Contrato: primero replay de run_events por seq, luego live; `:ping` cada 15 s;
 * cierra al llegar a kind done|error.
 */
export function subscribeRunEvents(runId: string, handlers: SseHandlers): () => void {
  const ctrl = new AbortController();
  if (isDemoMode()) {
    demoSimulateRunEvents(
      runId,
      (seq, kind, data) => {
        handlers.onEvent({ seq, kind: kind as RunEventKind, data });
        if (kind === 'done' || kind === 'error') handlers.onClose();
      },
      ctrl.signal,
    );
    return () => ctrl.abort();
  }
  void runStream(runId, handlers, ctrl.signal);
  return () => ctrl.abort();
}

async function runStream(
  runId: string,
  handlers: SseHandlers,
  signal: AbortSignal,
): Promise<void> {
  let res: Response;
  try {
    const headers: Record<string, string> = { Accept: 'text/event-stream' };
    const token = getToken();
    if (token) headers['Authorization'] = `Bearer ${token}`;
    res = await fetch(`${API_BASE}/api/runs/${runId}/events`, { headers, signal });
  } catch (e) {
    if (!signal.aborted) handlers.onError(e instanceof Error ? e : new Error(String(e)));
    handlers.onClose();
    return;
  }
  if (!res.ok || !res.body) {
    handlers.onError(new Error(`HTTP ${res.status}`));
    handlers.onClose();
    return;
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let evId = '';
  let evKind = '';
  let dataLines: string[] = [];
  let finished = false;

  const dispatch = () => {
    if (evKind === '' && dataLines.length === 0) return;
    const kind = (evKind || 'message') as RunEventKind;
    const raw = dataLines.join('\n');
    let data: unknown = raw;
    try {
      data = raw ? (JSON.parse(raw) as unknown) : null;
    } catch {
      /* deja el texto tal cual */
    }
    handlers.onEvent({ seq: Number(evId) || 0, kind, data });
    evId = '';
    evKind = '';
    dataLines = [];
    if (kind === 'done' || kind === 'error') {
      finished = true;
      void reader.cancel();
    }
  };

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done || finished) break;
      buf += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n');
      let idx: number;
      while ((idx = buf.indexOf('\n\n')) >= 0) {
        const block = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        for (const line of block.split('\n')) {
          if (line.startsWith(':')) continue; // :ping
          else if (line.startsWith('id:')) evId = line.slice(3).trim();
          else if (line.startsWith('event:')) evKind = line.slice(6).trim();
          else if (line.startsWith('data:')) dataLines.push(line.slice(5).replace(/^\s/, ''));
        }
        dispatch();
        if (finished) break;
      }
    }
  } catch (e) {
    if (!signal.aborted && !finished) handlers.onError(e instanceof Error ? e : new Error(String(e)));
  }
  handlers.onClose();
}
