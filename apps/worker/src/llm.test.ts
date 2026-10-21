import { describe, expect, it } from 'vitest';
import { LlmError, callWithTransientRetries, findMalformedToolCalls, isTransientLlmError, isUnusableEmptyResponse, parseResponse, type LlmRetryInfo } from './llm.js';
import { TOOL_DEFS } from './tools.js';
import { DYNAMIC_TOOL_DEFS } from './dynamicTools.js';
import type { LlmResponse, LlmToolCall } from 'appforge-shared';
it('rejects truncated tool calls before they can write incomplete files', () => {
  expect(() => parseResponse({ choices: [{ finish_reason: 'length', message: { content: 'partial' } }] })).toThrow('truncated');
});
it('rejects malformed tool arguments with a recoverable error', () => {
  expect(() => parseResponse({ choices: [{ message: { tool_calls: [{ function: { name: 'write_file', arguments: '{broken' } }] } }] })).toThrow('Invalid JSON');
});
it.each(['null', '[]', '"a string"', '42'])('rejects non-object tool arguments: %s', (argumentsValue) => {
  expect(() => parseResponse({choices:[{message:{tool_calls:[{function:{name:'write_file',arguments:argumentsValue}}]}}]})).toThrow('expected a JSON object');
});

// ---------------------------------------------------------------------------
// Malformed tool calls: marking at parse time + pure detection (the loop
// retries the completion instead of executing calls with no arguments).
// ---------------------------------------------------------------------------

const bodyWithCall = (call: Record<string, unknown>) => ({
  choices: [{ message: { tool_calls: [call] } }],
});

describe('parseResponse argument marking', () => {
  it('marks a tool call whose arguments field is absent', () => {
    const resp = parseResponse(bodyWithCall({ id: '1', function: { name: 'read_file' } }));
    expect(resp.toolCalls).toHaveLength(1);
    expect(resp.toolCalls[0]!.arguments).toEqual({});
    expect(resp.toolCalls[0]!.malformed).toBe('empty-arguments');
    expect(resp.toolCalls[0]!.rawArguments).toBeUndefined();
  });

  it('marks a tool call whose arguments are an empty string and keeps the raw string', () => {
    const resp = parseResponse(bodyWithCall({ id: '1', function: { name: 'read_file', arguments: '' } }));
    expect(resp.toolCalls[0]!.arguments).toEqual({});
    expect(resp.toolCalls[0]!.malformed).toBe('empty-arguments');
    expect(resp.toolCalls[0]!.rawArguments).toBe('');
  });

  it('marks whitespace-only arguments as empty', () => {
    const resp = parseResponse(bodyWithCall({ id: '1', function: { name: 'read_file', arguments: '   ' } }));
    expect(resp.toolCalls[0]!.malformed).toBe('empty-arguments');
    expect(resp.toolCalls[0]!.rawArguments).toBe('   ');
  });

  it('does not mark a call with real JSON arguments and preserves the raw string', () => {
    const resp = parseResponse(bodyWithCall({ id: '1', function: { name: 'read_file', arguments: '{"path":"a.ts"}' } }));
    expect(resp.toolCalls[0]!.arguments).toEqual({ path: 'a.ts' });
    expect(resp.toolCalls[0]!.malformed).toBeUndefined();
    expect(resp.toolCalls[0]!.rawArguments).toBe('{"path":"a.ts"}');
  });

  it('does not mark an explicit "{}" at parse level', () => {
    const resp = parseResponse(bodyWithCall({ id: '1', function: { name: 'read_file', arguments: '{}' } }));
    expect(resp.toolCalls[0]!.arguments).toEqual({});
    expect(resp.toolCalls[0]!.malformed).toBeUndefined();
    expect(resp.toolCalls[0]!.rawArguments).toBe('{}');
  });
});

describe('findMalformedToolCalls', () => {
  const defs = [...TOOL_DEFS, ...DYNAMIC_TOOL_DEFS];
  const call = (name: string, args: Record<string, unknown>, extra: Partial<LlmToolCall> = {}): LlmToolCall => ({
    id: 'tc', name, arguments: args, ...extra,
  });

  it('flags read_file {} as missing path', () => {
    expect(findMalformedToolCalls([call('read_file', {})], defs)).toEqual([{ name: 'read_file', missing: ['path'] }]);
  });

  it('flags a parser-marked empty-arguments read_file as missing path', () => {
    expect(findMalformedToolCalls([call('read_file', {}, { malformed: 'empty-arguments', rawArguments: '' })], defs))
      .toEqual([{ name: 'read_file', missing: ['path'] }]);
  });

  it('accepts get_dynamic_status {} (no required parameters)', () => {
    expect(findMalformedToolCalls([call('get_dynamic_status', {})], defs)).toEqual([]);
  });

  it('accepts a parser-marked no-argument tool (provider omitted the payload, nothing is required)', () => {
    expect(findMalformedToolCalls([call('get_dynamic_status', {}, { malformed: 'empty-arguments' })], defs)).toEqual([]);
  });

  it('flags write_file with only path as missing content', () => {
    expect(findMalformedToolCalls([call('write_file', { path: 'src/App.tsx' })], defs))
      .toEqual([{ name: 'write_file', missing: ['content'] }]);
  });

  it('flags read_file with a wrong key ({file}) as missing path', () => {
    expect(findMalformedToolCalls([call('read_file', { file: 'x' })], defs)).toEqual([{ name: 'read_file', missing: ['path'] }]);
  });

  it('flags an empty-string required parameter', () => {
    expect(findMalformedToolCalls([call('read_file', { path: '  ' })], defs)).toEqual([{ name: 'read_file', missing: ['path'] }]);
  });

  it('accepts complete calls', () => {
    expect(findMalformedToolCalls([
      call('read_file', { path: 'src/App.tsx' }),
      call('write_file', { path: 'src/App.tsx', content: 'x' }),
    ], defs)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Transient provider failures: classification + bounded in-call retries.
// Production run 8a141027 died on a single "LLM returned no choices"; a
// transient hiccup is not a fact and must be absorbed by the retry driver
// in llm.ts instead of killing the run.
// ---------------------------------------------------------------------------

const thrownCode = (fn: () => unknown): string => {
  try {
    fn();
  } catch (e) {
    return (e as LlmError).code;
  }
  throw new Error('expected the function to throw');
};

describe('transient failure classification', () => {
  it('parseResponse reports a missing or empty choices array as LLM_EMPTY', () => {
    expect(thrownCode(() => parseResponse({}))).toBe('LLM_EMPTY');
    expect(thrownCode(() => parseResponse({ choices: [] }))).toBe('LLM_EMPTY');
    expect(() => parseResponse({})).toThrow('LLM returned no choices');
  });

  it.each(['LLM_EMPTY', 'LLM_TIMEOUT', 'LLM_RATE_LIMIT', 'LLM_SERVER_ERROR', 'LLM_REQUEST_FAILED'])(
    'classifies %s as transient',
    (code) => {
      expect(isTransientLlmError(new LlmError(code, 'boom'))).toBe(true);
    },
  );

  it.each(['LLM_HTTP_ERROR', 'LLM_TRUNCATED', 'LLM_BAD_TOOL_ARGS', 'RUN_TIMEOUT'])(
    'classifies %s as NOT transient (fails fast)',
    (code) => {
      expect(isTransientLlmError(new LlmError(code, 'boom'))).toBe(false);
    },
  );

  it('does not classify foreign exceptions as transient', () => {
    expect(isTransientLlmError(new Error('LLM_EMPTY'))).toBe(false);
    expect(isTransientLlmError('LLM_EMPTY')).toBe(false);
  });

  it('flags responses with neither content nor tool calls as unusable-empty', () => {
    const usage = { promptTokens: 3, completionTokens: 0 };
    expect(isUnusableEmptyResponse({ content: null, toolCalls: [], usage })).toBe(true);
    expect(isUnusableEmptyResponse({ content: '   ', toolCalls: [], usage })).toBe(true);
    expect(isUnusableEmptyResponse({ content: 'a summary', toolCalls: [], usage })).toBe(false);
    expect(isUnusableEmptyResponse({ content: null, toolCalls: [{ id: '1', name: 'read_file', arguments: {} }], usage })).toBe(false);
  });
});

describe('callWithTransientRetries', () => {
  const okResponse: LlmResponse = { content: 'done', toolCalls: [], usage: { promptTokens: 10, completionTokens: 2 } };

  /** Scripted attempt: replays the given failures, then succeeds. Records attempts, retry notices and backoff waits. */
  const scripted = (failures: LlmError[]) => {
    const state = {
      attempts: 0,
      retries: [] as LlmRetryInfo[],
      waits: [] as number[],
    };
    const attemptOnce = async (): Promise<LlmResponse> => {
      state.attempts += 1;
      const failure = failures[state.attempts - 1];
      if (failure) throw failure;
      return okResponse;
    };
    const onRetry = (info: LlmRetryInfo) => { state.retries.push(info); };
    const sleepFn = async (ms: number) => { state.waits.push(ms); };
    return { state, attemptOnce, onRetry, sleepFn };
  };

  it('absorbs two "no choices" hiccups and continues on the third attempt, logging each retry', async () => {
    const { state, attemptOnce, onRetry, sleepFn } = scripted([
      new LlmError('LLM_EMPTY', 'LLM returned no choices'),
      new LlmError('LLM_EMPTY', 'LLM returned no choices'),
    ]);
    const resp = await callWithTransientRetries(attemptOnce, onRetry, sleepFn);
    expect(resp).toBe(okResponse);
    expect(state.attempts).toBe(3);
    expect(state.retries.map((r) => [r.attempt, r.maxAttempts, r.code])).toEqual([
      [1, 3, 'LLM_EMPTY'],
      [2, 3, 'LLM_EMPTY'],
    ]);
    expect(state.retries.map((r) => r.message)).toEqual(['LLM returned no choices', 'LLM returned no choices']);
    expect(state.waits).toEqual([1000, 2000]);
  });

  it('absorbs a mixed transient sequence (timeout, then 5xx) the same way', async () => {
    const { state, attemptOnce, onRetry, sleepFn } = scripted([
      new LlmError('LLM_TIMEOUT', 'LLM call timed out after 30000ms'),
      new LlmError('LLM_SERVER_ERROR', 'LLM HTTP 502'),
    ]);
    const resp = await callWithTransientRetries(attemptOnce, onRetry, sleepFn);
    expect(resp).toBe(okResponse);
    expect(state.attempts).toBe(3);
    expect(state.retries.map((r) => r.code)).toEqual(['LLM_TIMEOUT', 'LLM_SERVER_ERROR']);
  });

  it('honors the provider Retry-After header over the exponential backoff', async () => {
    const rateLimited = new LlmError('LLM_RATE_LIMIT', 'LLM HTTP 429');
    rateLimited.retryAfter = '7';
    const { state, attemptOnce, onRetry, sleepFn } = scripted([rateLimited]);
    const resp = await callWithTransientRetries(attemptOnce, onRetry, sleepFn);
    expect(resp).toBe(okResponse);
    expect(state.waits).toEqual([7000]);
    expect(state.retries[0]!.backoffMs).toBe(7000);
  });

  it('gives up after exactly 3 attempts on a persistent transient, with the attempt count in the final message', async () => {
    const { state, attemptOnce, onRetry, sleepFn } = scripted([
      new LlmError('LLM_EMPTY', 'LLM returned no choices'),
      new LlmError('LLM_EMPTY', 'LLM returned no choices'),
      new LlmError('LLM_EMPTY', 'LLM returned no choices'),
      new LlmError('LLM_EMPTY', 'LLM returned no choices'),
    ]);
    const err = await callWithTransientRetries(attemptOnce, onRetry, sleepFn).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LlmError);
    expect((err as LlmError).code).toBe('LLM_EMPTY');
    expect((err as LlmError).message).toContain('LLM returned no choices');
    expect((err as LlmError).message).toContain('attempt 3/3');
    expect(state.attempts).toBe(3);
    expect(state.retries).toHaveLength(2);
  });

  it.each([401, 402])('fails immediately on a non-transient HTTP %i: zero retries, error untouched', async (status) => {
    const httpError = new LlmError('LLM_HTTP_ERROR', `LLM HTTP ${status}: provider says no`);
    const { state, attemptOnce, onRetry, sleepFn } = scripted([httpError, httpError, httpError]);
    const err = await callWithTransientRetries(attemptOnce, onRetry, sleepFn).catch((e: unknown) => e);
    expect(err).toBe(httpError);
    expect(state.attempts).toBe(1);
    expect(state.retries).toEqual([]);
    expect(state.waits).toEqual([]);
  });
});
