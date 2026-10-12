/**
 * LLM client (OpenAI-compatible chat completions) for the AppForge agent.
 *
 * Providers: Groq (https://api.groq.com/openai/v1) and OpenRouter
 * (https://api.openrouter.ai/api/v1), selected via settings/env.
 * API keys always come from server-side env vars — never from the frontend.
 *
 * Retries happen ONLY on HTTP 429 / 5xx (max 3 attempts, exponential
 * backoff honoring Retry-After). Network errors and 4xx fail fast.
 */

import type { LlmMessage, LlmResponse, LlmToolCall, LlmUsage } from 'appforge-shared';

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
const OPENROUTER_URL = 'https://api.openrouter.ai/api/v1/chat/completions';
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
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), cfg.timeoutMs);
    try {
      const res = await fetch(url, { method: 'POST', headers, body: payload, signal: ctrl.signal });
      if (res.status === 429 || res.status >= 500) {
        lastError = new LlmError(
          res.status === 429 ? 'LLM_RATE_LIMIT' : 'LLM_SERVER_ERROR',
          `LLM HTTP ${res.status} (attempt ${attempt}/${MAX_ATTEMPTS})`,
        );
        if (attempt < MAX_ATTEMPTS) {
          await sleep(backoffMs(attempt, res.headers.get('retry-after')));
          continue;
        }
        throw lastError;
      }
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new LlmError('LLM_HTTP_ERROR', `LLM HTTP ${res.status}: ${text.slice(0, 500)}`);
      }
      return parseResponse(await res.json());
    } catch (err) {
      if (err instanceof LlmError && (err.code === 'LLM_RATE_LIMIT' || err.code === 'LLM_SERVER_ERROR')) throw err;
      if (err instanceof Error && err.name === 'AbortError') {
        // Timeouts are transient (provider-side stalls): retry with backoff
        // like 429/5xx instead of failing the whole run on the first stall.
        lastError = new LlmError('LLM_TIMEOUT', `LLM call timed out after ${cfg.timeoutMs}ms (attempt ${attempt}/${MAX_ATTEMPTS})`);
        if (attempt < MAX_ATTEMPTS) {
          await sleep(backoffMs(attempt, null));
          continue;
        }
        throw lastError;
      }
      // Any other error (network, parse): fail fast per contract (retries only on 429/5xx).
      throw err instanceof LlmError ? err : new LlmError('LLM_REQUEST_FAILED', String((err as Error)?.message ?? err));
    } finally {
      clearTimeout(timer);
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
