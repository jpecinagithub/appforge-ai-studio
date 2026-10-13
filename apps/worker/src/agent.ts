/**
 * Single orchestrator agent (CONTRACT.md §6). Loop:
 *   build context → LLM with tools → execute tool → record event → repeat
 * until the model answers without tool calls, a limit is hit, or the user
 * cancels. Never deletes project files on failure.
 */

import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type {
  AgentLimits,
  FileNode,
  LlmMessage,
  RunEventKind,
  RunStats,
} from 'appforge-shared';
import { StubLlm, chatLlm, isStubMode, type LlmConfig } from './llm.js';
import { createTools, nowIso, type ToolContext } from './tools.js';
import { TOOL_DEFS } from './tools.js';
import { clearCancel, isCancelRequested } from './cancel.js';

export interface AgentSettings {
  provider: 'groq' | 'openrouter';
  model: string;
  temperature: number;
  maxTokens: number;
  maxIterations: number;
  llmTimeoutMs: number;
  cmdTimeoutMs: number;
  runTimeoutMs: number;
  language: 'es' | 'en';
  autoRevision: boolean;
}

export interface RunAgentOptions {
  dataDir: string;
  settings: AgentSettings;
}

const DEFAULT_LIMITS: AgentLimits = {
  maxIterations: 8,
  maxRepairAttempts: 2,
  llmTimeoutMs: 120_000,
  cmdTimeoutMs: 180_000,
  runTimeoutMs: 900_000,
};

function systemPrompt(lang: 'es' | 'en', toolNames: string[]): string {
  const userLang = lang === 'es' ? 'Spanish' : 'English';
  return [
    'You are AppForge, an AI coding agent inside AppForge AI Studio. You operate on REAL files of a single project directory.',
    '',
    'PROJECT LAYOUT:',
    '- All file tools (list_files, read_file, write_file, patch_file, create_directory) work RELATIVE TO frontend/ — e.g. use "src/App.tsx", NOT "frontend/src/App.tsx".',
    '- frontend/ holds the Vite+React+TypeScript app. ALL source code goes there.',
    '- PROJECT_CONTEXT.md (at the project root, outside frontend/) has project notes; read it first via read_file with path "../PROJECT_CONTEXT.md" is NOT allowed — instead it is injected in your context.',
    '',
    `Available tools: ${toolNames.join(', ')}.`,
    '- To explore files, use list_files (NOT run_command with ls/cat — only npm, npx, node are allowlisted in run_command, which runs with cwd=frontend/).',
    '',
    'RULES:',
    '1. Keep an internal plan of at most 5 tasks. Do not narrate the plan; just work.',
    '2. Prefer patch_file over rewriting whole files. Read only the files you actually need.',
    '3. After generating or editing code, validate: run typecheck (run_command with npx tsc --noEmit -p tsconfig.app.json, or rely on the build) and then run_build. Fix failures (max 2 repair attempts per distinct failure).',
    '4. Verify the build output exists (frontend/dist/index.html), then call start_preview.',
    '5. NEVER claim something is finished without verifying it (build output, preview URL). No fake progress.',
    '6. Loop guard: if you catch yourself repeating the same tool call or the same build error, stop and report a diagnosis. NEVER delete project files.',
    '7. NEVER run "npm run dev" (it starts a server that never exits and wastes the run). To build: run_build. To preview: start_preview.',
    '8. write_file content must ALWAYS be a string with the complete file text. For .json files, write the JSON text — never pass a JSON object/array as content.',
    `9. Your final message to the user must be a SHORT Markdown summary in ${userLang}: what was built, features, test/build results, preview status, limitations.`,
  ].join('\n');
}

function renderTree(nodes: FileNode[], depth = 0): string[] {
  const out: string[] = [];
  for (const n of nodes.slice(0, 400)) {
    out.push(`${'  '.repeat(depth)}${n.type === 'dir' ? '📁' : '📄'} ${n.name}`);
    if (n.children) out.push(...renderTree(n.children, depth + 1));
  }
  return out;
}

function emit(db: Database.Database, runId: string, kind: RunEventKind, data: unknown): void {
  const seq = (db.prepare('SELECT COALESCE(MAX(seq),0) AS m FROM run_events WHERE run_id=?').get(runId) as { m: number }).m + 1;
  db.prepare('INSERT INTO run_events(run_id, seq, kind, payload_json, created_at) VALUES (?,?,?,?,?)').run(
    runId,
    seq,
    kind,
    JSON.stringify(data ?? null),
    nowIso(),
  );
}

function updateRun(db: Database.Database, runId: string, patch: { status: string; finishedAt: string; stats: RunStats; error: string | null }): void {
  db.prepare('UPDATE runs SET status=?, finished_at=?, stats_json=?, error=? WHERE id=?').run(
    patch.status,
    patch.finishedAt,
    JSON.stringify(patch.stats),
    patch.error,
    runId,
  );
}

function addAssistantMessage(db: Database.Database, projectId: string, content: string): void {
  db.prepare('INSERT INTO messages(id, project_id, role, content, created_at, tokens) VALUES (?,?,?,?,?,?)').run(
    randomUUID(),
    projectId,
    'assistant',
    content,
    nowIso(),
    null,
  );
}

function readProjectContext(projectDir: string): string {
  try {
    return fs.readFileSync(path.join(projectDir, 'PROJECT_CONTEXT.md'), 'utf8');
  } catch {
    return '(no PROJECT_CONTEXT.md yet)';
  }
}

function rewriteProjectContext(opts: {
  projectDir: string;
  projectName: string;
  prompt: string;
  modifiedFiles: string[];
  summary: string;
  lastError: string | null;
  runId: string;
  status: string;
}): void {
  const pkgPath = path.join(opts.projectDir, 'frontend', 'package.json');
  let stack = 'unknown';
  try {
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8')) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
    stack = [...Object.keys(pkg.dependencies ?? {}), ...Object.keys(pkg.devDependencies ?? {})].slice(0, 20).join(', ');
  } catch {
    /* ignore */
  }
  const topLevel = (() => {
    try {
      return fs
        .readdirSync(opts.projectDir, { withFileTypes: true })
        .map((e) => `${e.isDirectory() ? 'dir' : 'file'}: ${e.name}`)
        .join('\n');
    } catch {
      return '(unreadable)';
    }
  })();
  const content = [
    `# PROJECT_CONTEXT.md — ${opts.projectName} (internal, auto-generated by the agent)`,
    '',
    `- Updated: ${nowIso()} (run ${opts.runId}, status ${opts.status})`,
    `- Goal: ${opts.prompt.slice(0, 500)}`,
    `- Stack: ${stack}`,
    '',
    '## Structure (project root)',
    topLevel,
    '',
    '## Recent changes',
    opts.modifiedFiles.length > 0 ? opts.modifiedFiles.map((f) => `- ${f}`).join('\n') : '(none this run)',
    '',
    '## Last run summary',
    opts.summary.slice(0, 1500),
    '',
    '## Known errors',
    opts.lastError ?? '(none)',
    '',
  ].join('\n');
  fs.writeFileSync(path.join(opts.projectDir, 'PROJECT_CONTEXT.md'), content, 'utf8');
}

export async function runAgentOnce(db: Database.Database, runId: string, opts: RunAgentOptions): Promise<void> {
  const settings = opts.settings;
  const limits: AgentLimits = {
    maxIterations: settings.maxIterations || DEFAULT_LIMITS.maxIterations,
    maxRepairAttempts: DEFAULT_LIMITS.maxRepairAttempts,
    llmTimeoutMs: settings.llmTimeoutMs || DEFAULT_LIMITS.llmTimeoutMs,
    cmdTimeoutMs: settings.cmdTimeoutMs || DEFAULT_LIMITS.cmdTimeoutMs,
    runTimeoutMs: settings.runTimeoutMs || DEFAULT_LIMITS.runTimeoutMs,
  };

  const run = db.prepare('SELECT * FROM runs WHERE id=?').get(runId) as Record<string, any> | undefined;
  if (!run) return;
  if (run.status !== 'queued' && run.status !== 'running') return;

  const project = db.prepare('SELECT * FROM projects WHERE id=?').get(run.project_id) as Record<string, any> | undefined;
  const t = (key: string) => (settings.language === 'es' ? ES[key] : EN[key]);

  const finishError = (message: string, code?: string) => {
    stats.errors += 1;
    emit(db, runId, 'error', { code: code ?? 'AGENT_ERROR', message });
    addAssistantMessage(db, run.project_id, `⚠️ ${t('errorPrefix')}\n\n${message}`);
    updateRun(db, runId, { status: 'error', finishedAt: nowIso(), stats, error: message });
    db.prepare('UPDATE projects SET updated_at=? WHERE id=?').run(nowIso(), run.project_id);
    clearCancel(runId);
  };

  const stats: RunStats = { iterations: 0, llmCalls: 0, llmMs: 0, buildMs: 0, tokensIn: 0, tokensOut: 0, toolCalls: 0, errors: 0 };

  if (!project) {
    finishError(t('noProject'));
    return;
  }

  const projectDir = path.join(opts.dataDir, 'projects', project.id);
  const frontendDir = path.join(projectDir, 'frontend');

  if (run.status === 'queued') {
    db.prepare("UPDATE runs SET status='running', started_at=? WHERE id=?").run(nowIso(), runId);
  }
  emit(db, runId, 'status', { phase: 'started', projectId: project.id });

  // LLM configuration (stub mode bypasses keys entirely)
  let llmConfig: LlmConfig | null = null;
  let stub: StubLlm | null = null;
  if (isStubMode()) {
    stub = new StubLlm();
    emit(db, runId, 'log', { text: 'LLM stub mode (deterministic, tests only)' });
  } else {
    const apiKey = settings.provider === 'groq' ? process.env.GROQ_API_KEY ?? '' : process.env.OPENROUTER_API_KEY ?? '';
    if (!apiKey) {
      finishError(t('noKey'));
      return;
    }
    const defaultModel = settings.provider === 'groq' ? 'llama-3.3-70b-versatile' : 'meta-llama/llama-3.3-70b-instruct';
    llmConfig = {
      provider: settings.provider,
      model: settings.model || defaultModel,
      temperature: settings.temperature,
      maxTokens: settings.maxTokens,
      timeoutMs: limits.llmTimeoutMs,
      apiKey,
    };
  }

  const tools = createTools();
  const ctx: ToolContext = {
    db,
    projectId: project.id,
    projectDir,
    frontendDir,
    cmdTimeoutMs: limits.cmdTimeoutMs,
    buildTimeoutMs: 600_000,
  };

  // Optional checkpoint before touching files
  if (settings.autoRevision) {
    try {
      const r = await tools.create_revision(ctx, { label: 'before run' });
      emit(db, runId, 'log', { text: `pre-run checkpoint: ${r.ok ? JSON.stringify(r.data) : r.error}` });
    } catch {
      /* non-fatal */
    }
  }

  // Context: PROJECT_CONTEXT.md + file tree + last 20 messages
  const tree = await tools.list_files(ctx, {});
  const treeText = renderTree((tree.data as FileNode[] | undefined) ?? []).slice(0, 120).join('\n');
  const recent = (
    db.prepare('SELECT role, content FROM messages WHERE project_id=? ORDER BY created_at DESC LIMIT 20').all(project.id) as Array<{ role: string; content: string }>
  )
    .reverse()
    .map((m) => `${m.role}: ${m.content.slice(0, 2000)}`)
    .join('\n---\n');

  const history: LlmMessage[] = [
    { role: 'system', content: systemPrompt(settings.language, TOOL_DEFS.map((d) => d.name)) },
    {
      role: 'user',
      content: [
        `PROJECT CONTEXT:\n${readProjectContext(projectDir).slice(0, 4000)}`,
        `\nFILE TREE (frontend/):\n${treeText || '(empty)'}`,
        `\nRECENT CONVERSATION:\n${recent || '(none)'}`,
        `\nUSER REQUEST:\n${run.prompt}`,
      ].join('\n'),
    },
  ];

  const modifiedFiles: string[] = [];
  const repairCounts = new Map<string, number>();
  const recentSigs: string[] = [];
  let lastError: string | null = null;
  const criticalFailures = new Map<string, string>();
  let previewReady = false;
  const startedAt = Date.now();

  const dbStatus = () => (db.prepare('SELECT status FROM runs WHERE id=?').get(runId) as { status: string } | undefined)?.status;

  const cancelledNow = () => isCancelRequested(runId) || dbStatus() === 'cancelled';

  for (let iter = 1; iter <= limits.maxIterations; iter++) {
    if (cancelledNow()) {
      emit(db, runId, 'status', { phase: 'cancelled' });
      addAssistantMessage(db, project.id, t('cancelled'));
      updateRun(db, runId, { status: 'cancelled', finishedAt: nowIso(), stats, error: null });
      clearCancel(runId);
      return;
    }
    if (Date.now() - startedAt > limits.runTimeoutMs) {
      finishError(t('runTimeout'));
      return;
    }

    stats.iterations = iter;
    emit(db, runId, 'status', { phase: 'thinking', iteration: iter });

    let resp;
    const llmT0 = Date.now();
    try {
      resp = stub ? await stub.chat(history, TOOL_DEFS) : await chatLlm(llmConfig!, history, TOOL_DEFS);
    } catch (e) {
      finishError(`${t('llmFailed')}: ${(e as Error).message}`, 'LLM_ERROR');
      return;
    }
    stats.llmCalls += 1;
    stats.llmMs += Date.now() - llmT0;
    stats.tokensIn += resp.usage.promptTokens;
    stats.tokensOut += resp.usage.completionTokens;

    history.push({ role: 'assistant', content: resp.content, toolCalls: resp.toolCalls });
    if (resp.content) emit(db, runId, 'log', { text: resp.content.slice(0, 2000) });

    if (resp.toolCalls.length === 0) {
      const summary = resp.content ?? t('emptySummary');
      if (criticalFailures.size > 0 || (modifiedFiles.length > 0 && !previewReady)) {
        const detail = [...criticalFailures.values()].join('; ') || t('previewNotVerified');
        finishError(`${t('unverifiedCompletion')} ${detail}`, 'UNVERIFIED_COMPLETION');
        return;
      }
      emit(db, runId, 'done', { summary: summary.slice(0, 4000) });
      addAssistantMessage(db, project.id, summary);
      if (modifiedFiles.length > 0) {
        try {
          rewriteProjectContext({ projectDir, projectName: project.name, prompt: run.prompt, modifiedFiles, summary, lastError, runId, status: 'done' });
        } catch {
          /* non-fatal */
        }
      }
      updateRun(db, runId, { status: 'done', finishedAt: nowIso(), stats, error: null });
      db.prepare('UPDATE projects SET updated_at=? WHERE id=?').run(nowIso(), project.id);
      clearCancel(runId);
      return;
    }

    // Loop detection: 3 identical tool calls in a row (same name + args)
    for (const tc of resp.toolCalls) {
      recentSigs.push(`${tc.name}:${JSON.stringify(tc.arguments)}`);
      if (recentSigs.length > 3) recentSigs.shift();
    }
    if (recentSigs.length === 3 && recentSigs[0] === recentSigs[1] && recentSigs[1] === recentSigs[2]) {
      finishError(t('loopDetected'), 'LOOP_DETECTED');
      return;
    }

    for (const tc of resp.toolCalls) {
      if (cancelledNow()) break;
      emit(db, runId, 'tool_call', { id: tc.id, name: tc.name, arguments: tc.arguments });
      const handler = tools[tc.name];
      const callT0 = Date.now();
      let result;
      try {
        result = handler
          ? await handler(ctx, tc.arguments)
          : { ok: false, code: 'UNKNOWN_TOOL', error: `unknown tool: ${tc.name}`, durationMs: 0 };
      } catch (e) {
        result = { ok: false, code: 'TOOL_EXCEPTION', error: (e as Error).message, durationMs: Date.now() - callT0 };
      }
      stats.toolCalls += 1;
      if (tc.name === 'run_build') stats.buildMs += result.durationMs;

      if ((tc.name === 'run_build' || tc.name === 'install_dependencies') && !result.ok) {
        stats.errors += 1;
        lastError = result.error ?? result.code ?? 'build failed';
        const sig = `${result.code}|${(result.output ?? result.error ?? '').slice(-400)}`;
        const n = (repairCounts.get(sig) ?? 0) + 1;
        repairCounts.set(sig, n);
        if (n > limits.maxRepairAttempts) {
          finishError(`${t('repairLimit')}\n\n${lastError}`, 'REPAIR_LIMIT');
          return;
        }
      }

      if (['install_dependencies', 'run_build', 'start_preview'].includes(tc.name)) {
        if (result.ok) {
          criticalFailures.delete(tc.name);
          if (tc.name === 'run_build') {
            criticalFailures.delete('install_dependencies');
          }
          if (tc.name === 'start_preview') {
            previewReady = true;
            criticalFailures.delete('install_dependencies');
            criticalFailures.delete('run_build');
          }
        } else {
          criticalFailures.set(tc.name, result.error ?? result.code ?? `${tc.name} failed`);
        }
      }

      emit(db, runId, 'tool_result', {
        id: tc.id,
        name: tc.name,
        ok: result.ok,
        code: result.code,
        error: result.error,
        output: (result.output ?? '').slice(-4000),
        durationMs: result.durationMs,
      });
      history.push({
        role: 'tool',
        toolCallId: tc.id,
        name: tc.name,
        content: JSON.stringify(result).slice(0, 8000),
      });

      if (result.ok && ['write_file', 'patch_file', 'delete_file'].includes(tc.name) && typeof tc.arguments.path === 'string') {
        modifiedFiles.push(tc.arguments.path as string);
        previewReady = false;
      }
    }
  }

  finishError(t('maxIterations'), 'MAX_ITERATIONS');
}

const ES: Record<string, string> = {
  errorPrefix: 'La ejecución ha fallado:',
  noProject: 'El proyecto ya no existe.',
  noKey: 'Falta la API key del proveedor LLM. Configura GROQ_API_KEY u OPENROUTER_API_KEY en el servidor (variables de entorno) y vuelve a intentarlo.',
  cancelled: 'Ejecución cancelada por el usuario.',
  runTimeout: 'La ejecución superó el tiempo máximo permitido y se detuvo. Los archivos generados se conservan.',
  llmFailed: 'Fallo la llamada al modelo',
  emptySummary: 'Trabajo terminado.',
  loopDetected: 'Detecté que el agente repetía la misma operación sin avanzar y lo detuve. Los archivos generados se conservan; puedes continuar desde este estado.',
  repairLimit: 'El mismo fallo se repitió tras varios intentos de reparación y detuve el agente. Diagnóstico:',
  maxIterations: 'Se alcanzó el máximo de iteraciones sin completar el trabajo. Los archivos generados se conservan; puedes continuar desde este estado.',
  unverifiedCompletion: 'El agente intentó terminar sin un build y una preview verificados.',
  previewNotVerified: 'la preview no fue verificada',
};

const EN: Record<string, string> = {
  errorPrefix: 'The run failed:',
  noProject: 'The project no longer exists.',
  noKey: 'Missing LLM provider API key. Set GROQ_API_KEY or OPENROUTER_API_KEY as server environment variables and retry.',
  cancelled: 'Run cancelled by the user.',
  runTimeout: 'The run exceeded the maximum allowed time and was stopped. Generated files are preserved.',
  llmFailed: 'Model call failed',
  emptySummary: 'Work finished.',
  loopDetected: 'I detected the agent repeating the same operation without progress and stopped it. Generated files are preserved; you can continue from this state.',
  repairLimit: 'The same failure repeated after several repair attempts, so I stopped the agent. Diagnosis:',
  maxIterations: 'Reached the maximum number of iterations without completing the work. Generated files are preserved; you can continue from this state.',
  unverifiedCompletion: 'The agent tried to finish without a verified build and preview.',
  previewNotVerified: 'the preview was not verified',
};
