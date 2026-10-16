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
  ToolResult,
} from 'appforge-shared';
import { LlmError, StubLlm, chatLlm, isStubMode, type LlmConfig } from './llm.js';
import { createTools, nowIso, type ToolContext } from './tools.js';
import { sourceFingerprint } from './fingerprint.js';
import { TOOL_DEFS } from './tools.js';
import { clearCancel, isCancelRequested } from './cancel.js';
import { extractMissingLocalImages, imageQueryVariants, isUsableRasterAsset, patchImageReferences, repairStateKey } from './recovery.js';

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
    '2. For a new app, use write_files to create ALL related files in ONE call. Keep simple apps in App.tsx + index.css; split only when useful. For edits, read the relevant file then patch_file.',
    '3. run_build installs dependencies automatically and checks strict TypeScript. Do not spend turns installing first, listing files already in context, or running a separate typecheck. Fix ALL reported errors together before rebuilding.',
    '4. Call test_preview with interaction steps for EVERY distinct visible control: search, filters, details, main actions, then reload to verify persistence. Use click/fill/select followed by exact expect_text assertions of the changed result. Split independent cases into separate calls if needed. Then start_preview. A successful compile does not prove that buttons work. Interactive apps cannot finish without a successful interaction test of the current source.',
    '5. NEVER claim something is finished without verifying it (build output, preview URL). No fake progress.',
    '6. Do not repeat a failed build without editing its cause. Do not give up after the first failure: diagnostics are returned so you can repair them. NEVER delete project files.',
    '7. NEVER run "npm run dev" (it starts a server that never exits and wastes the run). To build: run_build. To preview: start_preview.',
    '8. write_file content must ALWAYS be a string with the complete file text. For .json files, write the JSON text — never pass a JSON object/array as content.',
    `9. Your final message to the user must be a SHORT Markdown summary in ${userLang}: what was built, features, test/build results, preview status, limitations.`,
    '10. React uses the automatic JSX runtime: import only hooks you use; use import type for interfaces. Do not give a component and an imported data type the same name (CarCard vs CarData). noUnusedLocals/noUnusedParameters/verbatimModuleSyntax are enabled. Never weaken tsconfig or the build script to hide errors.',
    '11. Only import packages declared in package.json; prefer native React and CSS for interface chrome and icons. Keep Vite base="./". For routing use hash routing or an explicit /p/<projectId>/ basename; apps are not hosted at the domain root.',
    '12. Implement every visible button/search/filter. No placeholder controls or fake success messages. Persist likes/tasks in a project-specific localStorage key when appropriate. Label example data clearly; never claim simulated data or bank connections are real.',
    '13. For content-led cards, catalogs, destinations, products, people or hero sections, use acquire_image to obtain relevant real photography instead of drawing the subject with generic SVG/CSS. Search specifically, use the returned local publicUrl, preserve the .license.json receipt, and show a discreet visible creator/source credit. Never invent external photo URLs, hotlink random search results, or imply that a representative photo depicts the exact item for sale. If acquisition fails, use a polished neutral placeholder clearly labeled as illustrative — never a childish drawing of the product.',
    '14. This template uses plain CSS only. Do not install or use Tailwind, shadcn, CSS-in-JS, Sass, PostCSS plugins, UI frameworks, or utility-class libraries. Write semantic className values in React and define every class in src/index.css (or imported .css files). Prefer a small design-token block with CSS custom properties and ordinary responsive CSS.',
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
  const modifiedFiles: string[] = [];
  let lastError: string | null = null;

  const finishError = (message: string, code?: string) => {
    stats.errors += 1;
    addAssistantMessage(db, run.project_id, `⚠️ ${t('errorPrefix')}\n\n${message}`);
    updateRun(db, runId, { status: 'error', finishedAt: nowIso(), stats, error: message });
    if (project) {
      try { rewriteProjectContext({ projectDir: path.join(opts.dataDir, 'projects', project.id), projectName: project.name, prompt: run.prompt, modifiedFiles, summary: message, lastError: lastError ?? message, runId, status: 'error' }); } catch { /* best effort */ }
    }
    emit(db, runId, 'error', { code: code ?? 'AGENT_ERROR', message });
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

  let history: LlmMessage[] = [
    { role: 'system', content: systemPrompt(settings.language, TOOL_DEFS.map((d) => d.name)) },
    {
      role: 'user',
      content: [
        `PROJECT CONTEXT:\n${readProjectContext(projectDir).slice(0, 4000)}`,
        `\nFILE TREE (frontend/):\n${treeText || '(empty)'}`,
        `\nCURRENT CORE FILES:\n${['package.json', 'tsconfig.app.json', 'src/App.tsx', 'src/index.css'].map((file) => {
          try { return `--- ${file} ---\n${fs.readFileSync(path.join(frontendDir, file), 'utf8').slice(0, 14000)}`; } catch { return `--- ${file}: missing ---`; }
        }).join('\n')}`,
        `\nRECENT CONVERSATION:\n${recent || '(none)'}`,
        `\nUSER REQUEST:\n${run.prompt}`,
      ].join('\n'),
    },
  ];

  const criticalFailures = new Map<string, string>();
  const startedAt = Date.now();
  // The run timeout is an inactivity watchdog. A repair may legitimately take
  // longer than one window as long as verified source/diagnostic progress is
  // still being made; stagnant repair attempts remain independently bounded.
  let lastProgressAt = startedAt;

  const dbStatus = () => (db.prepare('SELECT status FROM runs WHERE id=?').get(runId) as { status: string } | undefined)?.status;

  const cancelledNow = () => isCancelRequested(runId) || dbStatus() === 'cancelled';

  // Installation/build/browser checks do not consume generation turns. A separate,
  // bounded repair phase remains available even when the last generation turn fails.
  const maxStagnantRepairs = 6;
  let repairing = false;
  let stagnantRepairs = 0;
  let lastRepairState = '';
  let proposedSummary = '';
  const initialFingerprint = sourceFingerprint(frontendDir);

  const perform = async (name: string, args: Record<string, unknown>, id: string = randomUUID()): Promise<ToolResult> => {
    if (cancelledNow()) return { ok: false, code: 'CANCELLED', error: t('cancelled'), durationMs: 0 };
    const beforeFingerprint = sourceFingerprint(frontendDir);
    const remaining = limits.runTimeoutMs - (Date.now() - lastProgressAt);
    if (remaining <= 0) return { ok: false, code: 'RUN_TIMEOUT', error: t('runTimeout'), durationMs: 0 };
    ctx.cmdTimeoutMs = Math.min(limits.cmdTimeoutMs, remaining);
    ctx.buildTimeoutMs = Math.min(600_000, remaining);
    emit(db, runId, 'tool_call', { id, name, arguments: args });
    let result: ToolResult;
    try {
      result = tools[name] ? await tools[name](ctx, args) : { ok: false, code: 'UNKNOWN_TOOL', error: `unknown tool: ${name}`, durationMs: 0 };
    } catch (error) {
      result = { ok: false, code: 'TOOL_EXCEPTION', error: (error as Error).message, durationMs: 0 };
    }
    stats.toolCalls++;
    if (name === 'run_build' || name === 'start_preview') stats.buildMs += result.durationMs;
    const tracked = ['write_file', 'write_files', 'patch_file', 'acquire_image', 'install_dependencies', 'run_build', 'test_preview', 'start_preview'].includes(name);
    const fileTool = ['write_file', 'write_files', 'patch_file', 'delete_file', 'acquire_image'].includes(name);
    const filePaths = name === 'write_files'
      ? ((args.files as Array<{ path?: string }> | undefined) ?? []).map((file) => file.path ?? '?')
      : [String(args.path ?? '?')];
    if (!result.ok) {
      stats.errors++;
      lastError = `${result.error ?? result.code}\n${result.output ?? ''}`.slice(0, 12000);
      if (tracked) {
        if (fileTool) for (const file of filePaths) criticalFailures.set(`file:${file}`, lastError);
        else criticalFailures.set(name, lastError);
      }
    } else {
      criticalFailures.delete(name);
      if (fileTool) for (const file of filePaths) criticalFailures.delete(`file:${file}`);
      if (name === 'run_build' || name === 'start_preview') {
        criticalFailures.delete('install_dependencies');
        criticalFailures.delete('run_build');
      }
      if (['write_file', 'patch_file', 'delete_file'].includes(name) && typeof args.path === 'string') modifiedFiles.push(args.path);
      if (name === 'write_files') modifiedFiles.push(...((result.data as { paths?: string[] })?.paths ?? []));
      if (name === 'acquire_image') {
        const asset = result.data as { path?: string; attributionPath?: string } | undefined;
        if (asset?.path) modifiedFiles.push(asset.path);
        if (asset?.attributionPath) modifiedFiles.push(asset.attributionPath);
      }
      if (fileTool && sourceFingerprint(frontendDir) !== beforeFingerprint) lastProgressAt = Date.now();
    }
    emit(db, runId, 'tool_result', { id, name, ok: result.ok, code: result.code, error: result.error, output: (result.output ?? '').slice(0, 12000), durationMs: result.durationMs });
    return result;
  };

  const compactRecoveryHistory = (reason: string): LlmMessage[] => [{
    role: 'system',
    content: systemPrompt(settings.language, TOOL_DEFS.map((d) => d.name)),
  }, {
    role: 'user',
    content: [
      'RECOVERY MODE. Continue from the current files; do not restart or rewrite working parts.',
      `The previous model call failed transiently: ${reason}`,
      `Original goal:\n${String(run.prompt).slice(0, 3500)}`,
      `Current diagnostic:\n${(lastError ?? '(none)').slice(0, 8000)}`,
      ...['src/App.tsx', 'src/index.css', 'package.json'].map((file) => {
        try { return `--- ${file} ---\n${fs.readFileSync(path.join(frontendDir, file), 'utf8').slice(0, file.endsWith('.tsx') ? 18000 : 7000)}`; }
        catch { return `--- ${file}: missing ---`; }
      }),
      'Take the smallest concrete next action with tools. After edits, rebuild and verify interactions.',
    ].join('\n\n'),
  }];

  const repairMissingImages = async (diagnostic: string): Promise<boolean> => {
    const issues = extractMissingLocalImages(diagnostic, project.id);
    if (issues.length === 0) return false;
    emit(db, runId, 'status', { phase: 'repairing_assets', count: issues.length });
    let changed = false;
    for (const issue of issues) {
      if (cancelledNow() || Date.now() - lastProgressAt >= limits.runTimeoutMs) break;
      let publicUrl: string | null = null;
      const requestedAsset = path.join(frontendDir, 'public', ...issue.publicRelativePath.split('/'));
      if (fs.existsSync(requestedAsset) && isUsableRasterAsset(requestedAsset)) {
        publicUrl = `./${issue.publicRelativePath}`;
      } else {
        if (fs.existsSync(requestedAsset)) await perform('delete_file', { path: `public/${issue.publicRelativePath}` });
        for (const query of imageQueryVariants(issue)) {
          const acquired = await perform('acquire_image', { query, path: issue.acquisitionPath });
          if (acquired.ok) {
            publicUrl = String((acquired.data as { publicUrl?: string } | undefined)?.publicUrl ?? '') || null;
            break;
          }
        }
      }
      if (!publicUrl) continue;
      const patched = patchImageReferences(frontendDir, issue.requestPath, publicUrl);
      if (patched.length > 0) {
        modifiedFiles.push(...patched);
        changed = true;
        emit(db, runId, 'log', { text: `Recovered missing image ${issue.requestPath} -> ${publicUrl}; updated ${patched.join(', ')}` });
      }
    }
    return changed;
  };

  const complete = () => {
    const summary = proposedSummary || t('verifiedSummary');
    addAssistantMessage(db, project.id, summary);
    try { rewriteProjectContext({ projectDir, projectName: project.name, prompt: run.prompt, modifiedFiles: [...new Set(modifiedFiles)], summary, lastError: null, runId, status: 'done' }); } catch { /* best effort */ }
    updateRun(db, runId, { status: 'done', finishedAt: nowIso(), stats, error: null });
    db.prepare('UPDATE projects SET updated_at=? WHERE id=?').run(nowIso(), project.id);
    emit(db, runId, 'done', { summary: summary.slice(0, 4000) });
    clearCancel(runId);
  };

  const verify = async (): Promise<boolean> => {
    emit(db, runId, 'status', { phase: 'validating' });
    let result: ToolResult = modifiedFiles.length === 0 && sourceFingerprint(frontendDir) === initialFingerprint
      ? { ok: false, error: 'No implementation was made. Complete the requested changes first.', durationMs: 0 }
      : await perform('start_preview', {});
    if (!result.ok && result.code === 'BROWSER_FAILED' && await repairMissingImages(result.error ?? result.output ?? '')) {
      result = await perform('start_preview', {});
    }
    if (!result.ok && modifiedFiles.length === 0) lastError = result.error ?? lastError;
    if (cancelledNow()) return false;
    if (result.ok && (ctx.interactiveControls ?? 0) > 0 && ctx.interactionFingerprint !== ctx.builtFingerprint) {
      lastError = 'Interaction verification missing for the current source. Use test_preview with real click/fill/select actions and exact expect_text assertions of their results. Exercise each distinct visible control, including search and detail buttons; a rendering smoke test is insufficient.';
      criticalFailures.set('interactions', lastError);
    } else if (result.ok) {
      criticalFailures.delete('interactions');
    }
    if (result.ok && criticalFailures.size === 0 && Date.now() - lastProgressAt < limits.runTimeoutMs) {
      complete();
      return true;
    }
    repairing = true;
    const state = repairStateKey(sourceFingerprint(frontendDir), [...criticalFailures.values()].join('\n') || lastError || 'unknown');
    if (state === lastRepairState) stagnantRepairs++;
    else {
      lastRepairState = state;
      stagnantRepairs = 0;
      lastProgressAt = Date.now();
    }
    // Include actual diagnostics, not just "exit code 2", and keep JSON intact.
    history.push({ role: 'user', content: `AUTOMATIC VERIFICATION FAILED. Fix the existing app, keeping the user's requirements. repair turns are progress-aware and continue while diagnostics improve; ${maxStagnantRepairs - stagnantRepairs} unchanged attempts remain before recovery is considered stalled. Batch related fixes with write_files or multiple patch_file calls. Then test_preview with real interactions and start_preview.\n${[...criticalFailures.values()].join('\n').slice(0, 18000) || lastError}` });
    emit(db, runId, 'status', { phase: 'repairing', stagnantAttempts: stagnantRepairs, progressAware: true });
    return false;
  };

  for (let iter = 1; ; iter++) {
    if (cancelledNow()) {
      addAssistantMessage(db, project.id, t('cancelled'));
      updateRun(db, runId, { status: 'cancelled', finishedAt: nowIso(), stats, error: null });
      emit(db, runId, 'status', { phase: 'cancelled' });
      clearCancel(runId);
      return;
    }
    if (Date.now() - lastProgressAt > limits.runTimeoutMs) {
      finishError(t('runTimeout'));
      return;
    }

    stats.iterations = iter;
    if (repairing) {
      if (stagnantRepairs >= maxStagnantRepairs) break;
    }
    emit(db, runId, 'status', { phase: repairing ? 'repairing' : 'thinking', iteration: iter });

    let resp;
    const llmT0 = Date.now();
    try {
      resp = stub ? await stub.chat(history, TOOL_DEFS) : await chatLlm({ ...llmConfig!, deadline: lastProgressAt + limits.runTimeoutMs }, history, TOOL_DEFS);
    } catch (e) {
      if (e instanceof LlmError && ['LLM_TRUNCATED', 'LLM_BAD_TOOL_ARGS'].includes(e.code)) {
        stats.errors++;
        lastError = e.message;
        history.push({ role: 'user', content: `${e.message} The invalid response made no file changes. Retry with smaller complete files or patches.` });
        emit(db, runId, 'log', { text: e.message });
        if (iter >= limits.maxIterations) repairing = true;
        continue;
      }
      if (e instanceof LlmError && ['LLM_TIMEOUT', 'LLM_RATE_LIMIT', 'LLM_SERVER_ERROR', 'LLM_REQUEST_FAILED'].includes(e.code)) {
        stats.errors++;
        stats.llmCalls++;
        stats.llmMs += Date.now() - llmT0;
        lastError = e.message;
        repairing = true;
        history = compactRecoveryHistory(e.message);
        emit(db, runId, 'log', { text: `${e.message}. Retrying from a compact recovery context.` });
        emit(db, runId, 'status', { phase: 'recovering_model', code: e.code });
        continue;
      }
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
      proposedSummary = resp.content ?? '';
      if (sourceFingerprint(frontendDir) === initialFingerprint && modifiedFiles.length === 0 && !ctx.builtFingerprint) {
        lastError = 'No implementation was made. Execute the requested changes with the file tools; a description alone is not a completed app.';
        criticalFailures.set('implementation', lastError);
        history.push({ role: 'user', content: lastError });
        if ((repairing || iter >= limits.maxIterations) && await verify()) return;
      } else if (await verify()) return;
    }

    for (const tc of resp.toolCalls) {
      if (cancelledNow()) break;
      proposedSummary = '';
      const result = await perform(tc.name, tc.arguments, tc.id);
      history.push({
        role: 'tool',
        toolCallId: tc.id,
        name: tc.name,
        content: JSON.stringify({ ...result, output: result.output?.slice(0, 16000) }),
      });
    }
    // Repair turns must receive fresh compiler/browser diagnostics after each
    // response, not only after spending the entire repair reserve on patches.
    if ((!repairing && iter >= limits.maxIterations) || (repairing && resp.toolCalls.length > 0)) {
      if (await verify()) return;
      if (stagnantRepairs >= maxStagnantRepairs) break;
    }
  }

  finishError(`${t('repairLimit')}\n\n${lastError ?? t('maxIterations')}`, 'REPAIR_LIMIT');
}

const ES: Record<string, string> = {
  verifiedSummary: 'Cambios completados. Compilación y carga en Chromium verificadas para escritorio y móvil. La web está disponible en Preview y en la Librería.',
  errorPrefix: 'La ejecución ha fallado:',
  noProject: 'El proyecto ya no existe.',
  noKey: 'Falta la API key del proveedor LLM. Configura GROQ_API_KEY u OPENROUTER_API_KEY en el servidor (variables de entorno) y vuelve a intentarlo.',
  cancelled: 'Ejecución cancelada por el usuario.',
  runTimeout: 'La ejecución superó el tiempo máximo permitido y se detuvo. Los archivos generados se conservan.',
  llmFailed: 'Fallo la llamada al modelo',
  emptySummary: 'Trabajo terminado.',
  loopDetected: 'Detecté que el agente repetía la misma operación sin avanzar y lo detuve. Los archivos generados se conservan; puedes continuar desde este estado.',
  repairLimit: 'La verificación sigue fallando después de la fase automática de reparación. Los archivos se conservan. Diagnóstico:',
  maxIterations: 'Se alcanzó el máximo de iteraciones sin completar el trabajo. Los archivos generados se conservan; puedes continuar desde este estado.',
  unverifiedCompletion: 'El agente intentó terminar sin un build y una preview verificados.',
  previewNotVerified: 'la preview no fue verificada',
};

const EN: Record<string, string> = {
  verifiedSummary: 'Changes completed. Build and Chromium rendering verified on desktop and mobile. The app is available in Preview and the Library.',
  errorPrefix: 'The run failed:',
  noProject: 'The project no longer exists.',
  noKey: 'Missing LLM provider API key. Set GROQ_API_KEY or OPENROUTER_API_KEY as server environment variables and retry.',
  cancelled: 'Run cancelled by the user.',
  runTimeout: 'The run exceeded the maximum allowed time and was stopped. Generated files are preserved.',
  llmFailed: 'Model call failed',
  emptySummary: 'Work finished.',
  loopDetected: 'I detected the agent repeating the same operation without progress and stopped it. Generated files are preserved; you can continue from this state.',
  repairLimit: 'Verification still fails after the automatic repair phase. Files are preserved. Diagnosis:',
  maxIterations: 'Reached the maximum number of iterations without completing the work. Generated files are preserved; you can continue from this state.',
  unverifiedCompletion: 'The agent tried to finish without a verified build and preview.',
  previewNotVerified: 'the preview was not verified',
};
