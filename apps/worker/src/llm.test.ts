import { expect, it } from 'vitest';
import { parseResponse } from './llm.js';
it('rejects truncated tool calls before they can write incomplete files', () => {
  expect(() => parseResponse({ choices: [{ finish_reason: 'length', message: { content: 'partial' } }] })).toThrow('truncated');
});
it('rejects malformed tool arguments with a recoverable error', () => {
  expect(() => parseResponse({ choices: [{ message: { tool_calls: [{ function: { name: 'write_file', arguments: '{broken' } }] } }] })).toThrow('Invalid JSON');
});
