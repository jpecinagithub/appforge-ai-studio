import { describe, expect, it } from 'vitest';
import { findMalformedToolCalls, parseResponse } from './llm.js';
import { TOOL_DEFS } from './tools.js';
import { DYNAMIC_TOOL_DEFS } from './dynamicTools.js';
import type { LlmToolCall } from 'appforge-shared';
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
