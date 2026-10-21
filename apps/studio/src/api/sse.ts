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

/** Líneas `id:`/`event:`/`data:` de un bloque SSE (sin el separador `\n\n`). */
export interface ParsedSseBlock {
  id: string;
  kind: string;
  dataLines: string[];
}

/** Parseo puro de un bloque SSE; las líneas `:` (p. ej. `:ping`) se ignoran. */
export function parseSseBlock(block: string): ParsedSseBlock {
  const parsed: ParsedSseBlock = { id: '', kind: '', dataLines: [] };
  for (const line of block.split('\n')) {
    if (line.startsWith(':')) continue; // :ping
    else if (line.startsWith('id:')) parsed.id = line.slice(3).trim();
    else if (line.startsWith('event:')) parsed.kind = line.slice(6).trim();
    else if (line.startsWith('data:')) parsed.dataLines.push(line.slice(5).replace(/^\s/, ''));
  }
  return parsed;
}

/** Convierte un bloque SSE en StreamEvent; null si el bloque no lleva evento. */
export function sseBlockToEvent(block: string): StreamEvent | null {
  const { id, kind, dataLines } = parseSseBlock(block);
  if (kind === '' && dataLines.length === 0) return null;
  const raw = dataLines.join('\n');
  let data: unknown = raw;
  try {
    data = raw ? (JSON.parse(raw) as unknown) : null;
  } catch {
    /* deja el texto tal cual */
  }
  return { seq: Number(id) || 0, kind: (kind || 'message') as RunEventKind, data };
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
  let finished = false;

  const dispatchBlock = (block: string) => {
    const ev = sseBlockToEvent(block);
    if (!ev) return;
    handlers.onEvent(ev);
    if (ev.kind === 'done' || ev.kind === 'error') {
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
        dispatchBlock(block);
        if (finished) break;
      }
    }
  } catch (e) {
    if (!signal.aborted && !finished) handlers.onError(e instanceof Error ? e : new Error(String(e)));
  }
  // Flush del bloque final: si el servidor cierra el stream justo tras el
  // evento terminal y el último bloque quedó en el buffer sin su `\n\n`,
  // despáchalo antes de onClose o ese evento (done/error) se perdería.
  if (!finished) {
    buf += decoder.decode().replace(/\r\n/g, '\n');
    if (buf.trim() !== '') dispatchBlock(buf);
    buf = '';
  }
  handlers.onClose();
}
