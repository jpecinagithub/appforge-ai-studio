/**
 * LLM client (OpenAI-compatible chat completions) for the AppForge agent.
 *
 * Providers: Groq (https://api.groq.com/openai/v1) and OpenRouter
 * (https://api.openrouter.ai/api/v1), selected via settings/env.
 * API keys always come from server-side env vars — never from the frontend.
 *
 * Transport: we POST via the `curl` binary (execFile, no shell) instead of
 * undici fetch, because undici's fetch intermittently hangs forever on these
 * endpoints in proxied environments while curl is 100% reliable. curl honors
 * the standard HTTPS_PROXY/NO_PROXY env vars.
 *
 * Retries happen on HTTP 429 / 5xx and on timeouts (max 3 attempts,
 * exponential backoff honoring Retry-After). Other network errors and 4xx
 * fail fast.
 */

import type { LlmMessage, LlmResponse, LlmToolCall, LlmUsage } from 'appforge-shared';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export interface LlmConfig {
  provider: 'groq' | 'openrouter';
  model: string;
  temperature: number;
  maxTokens: number;
  timeoutMs: number;
  apiKey: string;
}

export interface ToolDef {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions';
// NOTE: use the bare openrouter.ai host — the api.openrouter.ai hostname
// hangs/stalls in some proxied environments.
const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';
const MAX_ATTEMPTS = 3;

export class LlmError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'LlmError';
  }
}

function toOpenAIMessage(m: LlmMessage): Record<string, unknown> {
  if (m.role === 'tool') {
    return { role: 'tool', tool_call_id: m.toolCallId ?? '', content: m.content ?? '' };
  }
  if (m.role === 'assistant' && m.toolCalls && m.toolCalls.length > 0) {
    return {
      role: 'assistant',
      content: m.content ?? null,
      tool_calls: m.toolCalls.map((tc) => ({
        id: tc.id,
        type: 'function',
        function: { name: tc.name, arguments: JSON.stringify(tc.arguments) },
      })),
    };
  }
  return { role: m.role, content: m.content ?? '' };
}

function toOpenAITools(tools: ToolDef[]): unknown[] {
  return tools.map((t) => ({
    type: 'function',
    function: { name: t.name, description: t.description, parameters: t.parameters },
  }));
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * POST JSON via curl (see module docstring for why not undici fetch).
 * Returns { status, bodyText }. Throws LlmError('LLM_TIMEOUT') on timeout.
 */
async function postJsonCurl(
  url: string,
  headers: Record<string, string>,
  payload: string,
  timeoutMs: number,
): Promise<{ status: number; bodyText: string; responseHeaders: Record<string, string> }> {
  const tmp = path.join(os.tmpdir(), `appforge-llm-${randomUUID()}.json`);
  await fs.promises.writeFile(tmp, payload, 'utf8');
  try {
    const args: string[] = [
      '-sS',
      '--max-time',
      String(Math.max(1, Math.ceil(timeoutMs / 1000))),
      '-X',
      'POST',
      '-D',
      '-', // dump response headers to stdout before the body
      '-o',
      '-', // body to stdout (after headers)
    ];
    for (const [k, v] of Object.entries(headers)) args.push('-H', `${k}: ${v}`);
    // Disable "Expect: 100-continue" (curl sends it for bodies >1KB and some
    // proxies/servers drop the connection instead of answering 100).
    args.push('-H', 'Expect:');
    args.push('--data-binary', `@${tmp}`, url);
    const out = await new Promise<{ stdout: string; stderr: string; timedOut: boolean }>((resolve) => {
      execFile('curl', args, { timeout: timeoutMs + 15000, maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => {
        const timedOut = !!err && (/timed out/i.test(String((err as Error)?.message ?? '')) || (err as { killed?: boolean })?.killed === true);
        resolve({ stdout: String(stdout ?? ''), stderr: String(stderr ?? ''), timedOut });
      });
    });
    if (out.timedOut) throw new LlmError('LLM_TIMEOUT', `LLM call timed out after ${timeoutMs}ms`);
    // -D - prints headers, then a blank line, then the body (both to stdout).
    // NOTE: when going through a proxy, curl prints the CONNECT handshake
    // headers ("HTTP/1.1 200 Connection Established") first, so there may be
    // several header blocks — the real one is the LAST.
    const chunks = out.stdout.split('\r\n\r\n');
    const bodyText = chunks.pop() ?? '';
    const headerText = chunks.pop() ?? '';
    if (!headerText) throw new LlmError('LLM_REQUEST_FAILED', `curl produced no parseable response: ${out.stderr.slice(0, 300)}`);
    const statusLine = headerText.split('\r\n')[0] ?? '';
    const status = Number((statusLine.match(/HTTP\/\S+\s+(\d{3})/) ?? [])[1] ?? 0);
    const responseHeaders: Record<string, string> = {};
    for (const line of headerText.split('\r\n').slice(1)) {
      const ci = line.indexOf(':');
      if (ci > 0) responseHeaders[line.slice(0, ci).trim().toLowerCase()] = line.slice(ci + 1).trim();
    }
    if (!status) throw new LlmError('LLM_REQUEST_FAILED', `curl returned no HTTP status: ${out.stderr.slice(0, 300)}`);
    return { status, bodyText, responseHeaders };
  } finally {
    await fs.promises.unlink(tmp).catch(() => {});
  }
}

function backoffMs(attempt: number, retryAfter: string | null): number {
  if (retryAfter) {
    const s = Number(retryAfter);
    if (Number.isFinite(s) && s >= 0) return Math.min(s * 1000, 30_000);
  }
  return Math.min(1000 * 2 ** (attempt - 1), 15_000);
}

function parseResponse(body: unknown): LlmResponse {
  const choice = (body as { choices?: Array<any> })?.choices?.[0];
  if (!choice) throw new LlmError('LLM_EMPTY', 'LLM returned no choices');
  const msg = choice.message ?? {};
  const toolCalls: LlmToolCall[] = [];
  for (const tc of msg.tool_calls ?? []) {
    let args: Record<string, unknown> = {};
    try {
      args = tc.function?.arguments ? JSON.parse(tc.function.arguments) : {};
    } catch {
      throw new LlmError('LLM_BAD_TOOL_ARGS', `Invalid JSON arguments for tool ${tc.function?.name}`);
    }
    toolCalls.push({ id: String(tc.id ?? ''), name: String(tc.function?.name ?? ''), arguments: args });
  }
  const usage = (body as { usage?: any }).usage ?? {};
  const llmUsage: LlmUsage = {
    promptTokens: Number(usage.prompt_tokens ?? 0),
    completionTokens: Number(usage.completion_tokens ?? 0),
  };
  return { content: typeof msg.content === 'string' ? msg.content : null, toolCalls, usage: llmUsage };
}

export async function chatLlm(cfg: LlmConfig, messages: LlmMessage[], tools: ToolDef[]): Promise<LlmResponse> {
  const url = cfg.provider === 'groq' ? GROQ_URL : OPENROUTER_URL;
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${cfg.apiKey}`,
  };
  if (cfg.provider === 'openrouter') {
    headers['HTTP-Referer'] = process.env.APPFORGE_APP_URL ?? 'https://appforge.local';
    headers['X-Title'] = 'AppForge AI Studio';
  }
  const payload = JSON.stringify({
    model: cfg.model,
    temperature: cfg.temperature,
    max_tokens: cfg.maxTokens,
    messages: messages.map(toOpenAIMessage),
    tools: toOpenAITools(tools),
    tool_choice: 'auto',
  });

  let lastError: unknown = null;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const res = await postJsonCurl(url, headers, payload, cfg.timeoutMs);
      if (res.status === 429 || res.status >= 500) {
        lastError = new LlmError(
          res.status === 429 ? 'LLM_RATE_LIMIT' : 'LLM_SERVER_ERROR',
          `LLM HTTP ${res.status} (attempt ${attempt}/${MAX_ATTEMPTS})`,
        );
        if (attempt < MAX_ATTEMPTS) {
          await sleep(backoffMs(attempt, res.responseHeaders['retry-after'] ?? null));
          continue;
        }
        throw lastError;
      }
      if (res.status < 200 || res.status >= 300) {
        throw new LlmError('LLM_HTTP_ERROR', `LLM HTTP ${res.status}: ${res.bodyText.slice(0, 500)}`);
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(res.bodyText);
      } catch {
        throw new LlmError('LLM_REQUEST_FAILED', `LLM returned invalid JSON: ${res.bodyText.slice(0, 300)}`);
      }
      return parseResponse(parsed);
    } catch (err) {
      if (err instanceof LlmError && (err.code === 'LLM_RATE_LIMIT' || err.code === 'LLM_SERVER_ERROR')) throw err;
      if (err instanceof LlmError && err.code === 'LLM_TIMEOUT') {
        // Timeouts are transient (provider-side stalls): retry with backoff
        // like 429/5xx instead of failing the whole run on the first stall.
        lastError = new LlmError('LLM_TIMEOUT', `${err.message} (attempt ${attempt}/${MAX_ATTEMPTS})`);
        if (attempt < MAX_ATTEMPTS) {
          await sleep(backoffMs(attempt, null));
          continue;
        }
        throw lastError;
      }
      // Any other error (network, parse): fail fast per contract (retries only on 429/5xx).
      throw err instanceof LlmError ? err : new LlmError('LLM_REQUEST_FAILED', String((err as Error)?.message ?? err));
    }
  }
  throw lastError;
}

// ---------------------------------------------------------------------------
// Deterministic stub provider — TESTS ONLY.
// ---------------------------------------------------------------------------

/**
 * Returns true when the deterministic test stub must be used instead of a
 * real LLM. The stub executes a FIXED sequence of tool calls:
 *   1. read_file src/App.tsx (paths are relative to frontend/)
 *   2. patch_file — retitle to "Stub App"
 *   3. patch_file — add a paragraph
 *   4. install_dependencies
 *   5. run_build
 *   6. start_preview
 *   7. final summary (no tool calls → run ends)
 *
 * It personalizes the copied template, installs, builds and previews it for
 * real — but it is NOT artificial intelligence. Never present stub output as
 * an AI-generated result. Activate only with APPFORGE_LLM_STUB=1 in
 * automated tests.
 */
export function isStubMode(): boolean {
  return process.env.APPFORGE_LLM_STUB === '1';
}

function stubTool(id: string, name: string, args: Record<string, unknown>): LlmResponse {
  return { content: null, toolCalls: [{ id, name, arguments: args }], usage: { promptTokens: 0, completionTokens: 0 } };
}

export class StubLlm {
  private step = 0;

  async chat(_messages: LlmMessage[], _tools: ToolDef[]): Promise<LlmResponse> {
    this.step += 1;
    switch (this.step) {
      case 1:
        return stubTool('stub-1', 'read_file', { path: 'src/App.tsx' });
      case 2:
        return stubTool('stub-2', 'patch_file', {
          path: 'src/App.tsx',
          search: 'Welcome to your new app',
          replace: 'Stub App',
        });
      case 3:
        return stubTool('stub-3', 'patch_file', {
          path: 'src/App.tsx',
          search: '</h1>',
          replace: '</h1>\n        <p className="max-w-md text-slate-400">Personalized by the deterministic AppForge stub (tests only).</p>',
        });
      case 4:
        return stubTool('stub-4', 'install_dependencies', {});
      case 5:
        return stubTool('stub-5', 'run_build', {});
      case 6:
        return stubTool('stub-6', 'start_preview', {});
      default:
        return {
          content:
            'Stub run complete. I personalized the template (title "Stub App" plus a paragraph), installed dependencies, built the production bundle and prepared the preview.',
          toolCalls: [],
          usage: { promptTokens: 0, completionTokens: 0 },
        };
    }
  }
}
