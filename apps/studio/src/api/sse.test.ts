import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseSseBlock, sseBlockToEvent, subscribeRunEvents } from './sse';
import type { StreamEvent } from './sse';

afterEach(() => vi.unstubAllGlobals());

describe('parseSseBlock / sseBlockToEvent', () => {
  it('parses id, event and data lines', () => {
    const parsed = parseSseBlock('id: 7\nevent: done\ndata: {"ok":true}');
    expect(parsed).toEqual({ id: '7', kind: 'done', dataLines: ['{"ok":true}'] });
    expect(sseBlockToEvent('id: 7\nevent: done\ndata: {"ok":true}')).toEqual({
      seq: 7,
      kind: 'done',
      data: { ok: true },
    });
  });

  it('ignores comment lines (:ping) and yields no event for them', () => {
    expect(parseSseBlock(':ping')).toEqual({ id: '', kind: '', dataLines: [] });
    expect(sseBlockToEvent(':ping')).toBeNull();
    expect(sseBlockToEvent('')).toBeNull();
  });

  it('defaults kind to message and keeps non-JSON data as text', () => {
    expect(sseBlockToEvent('data: hola')).toEqual({ seq: 0, kind: 'message', data: 'hola' });
  });

  it('joins multi-line data with newlines before parsing', () => {
    const ev = sseBlockToEvent('id: 3\nevent: log\ndata: {"a":\ndata: 1}');
    expect(ev).toEqual({ seq: 3, kind: 'log', data: { a: 1 } });
  });
});

function streamResponse(chunks: string[]): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
  return new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
}

async function collectRunEvents(chunks: string[]) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => streamResponse(chunks)),
  );
  const events: StreamEvent[] = [];
  const errors: Error[] = [];
  let closes = 0;
  const closed = new Promise<void>((resolve) => {
    subscribeRunEvents('run-1', {
      onEvent: (ev) => events.push(ev),
      onError: (err) => errors.push(err),
      onClose: () => {
        closes += 1;
        resolve();
      },
    });
  });
  await closed;
  return { events, errors, closes };
}

describe('subscribeRunEvents stream flush', () => {
  it('dispatches a terminal block that arrives without the final blank line', async () => {
    const { events, errors, closes } = await collectRunEvents([
      'id: 1\nevent: status\ndata: {"phase":"working"}\n\n',
      'id: 2\nevent: done\ndata: {"final":true}', // sin `\n\n` final: el servidor cierra aquí
    ]);
    expect(errors).toEqual([]);
    expect(closes).toBe(1);
    expect(events).toEqual([
      { seq: 1, kind: 'status', data: { phase: 'working' } },
      { seq: 2, kind: 'done', data: { final: true } },
    ]);
  });

  it('flushes a terminal block split across chunks at close', async () => {
    const { events, closes } = await collectRunEvents([
      'id: 5\nevent: error\nda',
      'ta: {"code":"X"}',
    ]);
    expect(closes).toBe(1);
    expect(events).toEqual([{ seq: 5, kind: 'error', data: { code: 'X' } }]);
  });

  it('does not invent an event when only a ping is left in the buffer', async () => {
    const { events, errors, closes } = await collectRunEvents([':ping']);
    expect(errors).toEqual([]);
    expect(closes).toBe(1);
    expect(events).toEqual([]);
  });
});
