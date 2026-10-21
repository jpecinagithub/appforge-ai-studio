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
import type { DeploymentDriver } from './deploy/driver.js';
import { createTools, nowIso, restoreRevision, type BestDynamicStateInfo, type ToolContext } from './tools.js';
import { sourceFingerprint } from './fingerprint.js';
import { TOOL_DEFS } from './tools.js';
import { DYNAMIC_CHECK_ORDER, DYNAMIC_TOOL_DEFS, checkScopeFingerprint, createDynamicTools, dynamicGateStatus, invalidateDynamicChecks, validDynamicPrefixLength, type DynamicCheckKey } from './dynamicTools.js';
import { implementationEvidence } from './implementationEvidence.js';
import { deleteVerificationReceipts, recordVerificationReceipt } from './deploy/receipts.js';
import { clearCancel, isCancelRequested } from './cancel.js';
import { extractMissingLocalImages, imageQueryVariants, isUsableRasterAsset, patchImageReferences, repairErrorSignature, repairStateKey } from './recovery.js';

export interface AgentSettings {
  provider: 'groq' | 'openrouter';
  model: string;
  temperature: number;
  maxTokens: number;
  maxIterations: number;
  /** Fase 1: hard cap that actually stops the loop (maxIterations only forces verify()). */
  maxHardIterations?: number;
  /** Fase 1: max failed repair verifications before the run is stopped. */
  maxRepairAttempts?: number;
  llmTimeoutMs: number;
  cmdTimeoutMs: number;
  runTimeoutMs: number;
  language: 'es' | 'en';
  autoRevision: boolean;
}

export interface RunAgentOptions {
  dataDir: string;
  settings: AgentSettings;
  /** Fase 6: explicitly-configured deployment driver (never a default). */
  deploymentDriver?: DeploymentDriver;
}

const DEFAULT_LIMITS: AgentLimits = {
  maxIterations: 8,
  maxHardIterations: 60,
  // Until Fase 1 this value (2) was dead configuration: defined here and in
  // appforge-shared but never read anywhere. It now bounds the number of
  // FAILED repair verifications per run. 2 was calibrated for a limit that
  // never fired; as a real budget it must leave room for legitimate
  // multi-step repairs (the identical-signature circuit breaker, at 3, is
  // the tight net for true loops), so the effective default is 12.
  maxRepairAttempts: 12,
  llmTimeoutMs: 120_000,
  cmdTimeoutMs: 180_000,
  runTimeoutMs: 900_000,
};

/** Consecutive failed verifications with the SAME diagnostic signature stop the run. */
const MAX_REPEATED_ERROR_SIGNATURE = 3;

function systemPrompt(lang: 'es' | 'en', toolNames: string[], isDynamic: boolean): string {
  const userLang = lang === 'es' ? 'Spanish' : 'English';
  const dynamicSection = isDynamic ? [
    '',
    'DYNAMIC PROJECT (type=dynamic): this project uses the dynamic full-stack template.',
    '- Project root layout: frontend/ (Vite+React app), backend/ (Fastify+SQLite API), migrations/ (SQL files), tests/ (*.test.mjs API tests).',
    '- File tools accept an explicit "area" on this project: {"area":"backend","path":"src/routes/items.ts"}. Areas: frontend (frontend/**/*), backend (backend/src/**/*), migrations (migrations/*.sql), tests (tests/*.test.mjs). Default area is frontend. Never invent paths outside an area: package.json, lockfiles, Dockerfile, docker-compose.yml, scripts/, .env, data/, dist/ and node_modules/ are AppForge-controlled and rejected.',
    '- Preserve the template session/authentication modules, runtime configuration and relative API URL resolver. Extend domain routes rather than replacing these working contracts. Keep auth-screen, auth-toggle-mode, auth-email, auth-password, auth-submit, user-email and logout-button data-testid selectors. Domain CRUD, isolation and transactions require app-specific API tests; the generic authentication check does not test business behavior.',
    '- MANDATORY ORDER for a dynamic app: run_frontend_build → run_backend_build → run_migrations → run_api_tests → start_fullstack_preview → test_authenticated_flow. The dynamic tools take no arguments: paths and commands are fixed and confined to the active project.',
    '- Do NOT declare a dynamic app finished until all six succeed on the CURRENT sources. If you edit any source afterwards, the affected checks are invalidated automatically and you must re-run them in order. Never claim completion from the static checks (run_build/test_preview) alone.',
    '- run_migrations always runs against a temporary verification database; it never touches a live database.',
    '- start_fullstack_preview launches an ephemeral local preview (temporary SQLite, loopback only) published at /a/:projectId/ through the Studio proxy. test_authenticated_flow verifies it via API calls and real Chromium using stable data-testid selectors. Previews are provisional, never deployments.',
    '- During repair, consult get_dynamic_status BEFORE acting: it shows the current gate (valid/stale/missing checks, current prefix and best state reached this run), so you fix the earliest broken check instead of guessing.',
  ] : [];
  return [
    'You are AppForge, an AI coding agent inside AppForge AI Studio. You operate on REAL files of a single project directory.',
    '',
    'PROJECT LAYOUT:',
    isDynamic ? '- File tools resolve paths relative to an explicit area. For backend code use area=backend, path=src/routes/shop.ts. Never write backend/src/... inside frontend.' : '- File tools resolve paths relative to frontend/: use src/App.tsx, never frontend/src/App.tsx.',
    isDynamic ? '- Frontend code belongs in area=frontend, API code in area=backend, SQL in area=migrations and domain integration tests in area=tests. Paths never include the area prefix.' : '- frontend/ holds all static application source code.',
    '- PROJECT_CONTEXT.md (at the project root, outside frontend/) has project notes; read it first via read_file with path "../PROJECT_CONTEXT.md" is NOT allowed — instead it is injected in your context.',
    '',
    `Available tools: ${toolNames.join(', ')}.`,
    '- To explore files, use list_files (NOT run_command with ls/cat — only npm, npx, node are allowlisted in run_command, which runs with cwd=frontend/).',
    '',
    'RULES:',
    '1. Keep an internal plan of at most 5 tasks. Do not narrate the plan; just work.',
    '2. For a new app, use write_files to create ALL related files in ONE call. Keep simple apps in App.tsx + index.css; split only when useful. For edits, read the relevant file then patch_file.',
    isDynamic ? '3. run_frontend_build and run_backend_build install their dependencies and report strict compiler diagnostics. Repair the reported source in its correct area before repeating a failed build.' : '3. run_build installs dependencies automatically and checks strict TypeScript. Do not spend turns installing first, listing files already in context, or running a separate typecheck. Fix ALL reported errors together before rebuilding.',
    isDynamic ? '4. Implement domain integration tests in area=tests for the requested business operations, persistence and cross-user isolation. Then run the six mandatory dynamic checks. The example todo tests alone do not verify a different business domain.' : '4. Call test_preview with interaction steps for EVERY distinct visible control: search, filters, details, main actions, then reload to verify persistence. Use click/fill/select followed by exact expect_text assertions of the changed result. Split independent cases into separate calls if needed. Then start_preview. A successful compile does not prove that buttons work. Interactive apps cannot finish without a successful interaction test of the current source.',
    '5. NEVER claim something is finished without verifying it (build output, preview URL). No fake progress.',
    '6. Do not repeat a failed build without editing its cause. Do not give up after the first failure: diagnostics are returned so you can repair them. NEVER delete project files.',
    isDynamic ? '7. Do not start long-lived processes with run_command. Use start_fullstack_preview after the four build/migration/API checks, then test_authenticated_flow. Deployment is a separate operation.' : '7. NEVER run "npm run dev" (it starts a server that never exits and wastes the run). To build: run_build. To preview: start_preview.',
    '8. write_file content must ALWAYS be a string with the complete file text. For .json files, write the JSON text — never pass a JSON object/array as content.',
    `9. Your final message to the user must be a SHORT Markdown summary in ${userLang}: what was built, features, test/build results, preview status, limitations.`,
    '10. React uses the automatic JSX runtime: import only hooks you use; use import type for interfaces. Do not give a component and an imported data type the same name (CarCard vs CarData). noUnusedLocals/noUnusedParameters/verbatimModuleSyntax are enabled. Never weaken tsconfig or the build script to hide errors.',
    isDynamic ? '11. Use only dependencies already declared in the selected area package.json. Keep Vite base="./" and resolveApiUrl(document.baseURI) from the template: this app is hosted below /a/<projectId>/, possibly behind another prefix. Absolute /api requests reach the wrong service.' : '11. Only import packages declared in package.json; prefer native React and CSS for interface chrome and icons. Keep Vite base="./". For routing use hash routing or an explicit /p/<projectId>/ basename; apps are not hosted at the domain root.',
    '12. Implement every visible button/search/filter. No placeholder controls or fake success messages. Persist likes/tasks in a project-specific localStorage key when appropriate. Label example data clearly; never claim simulated data or bank connections are real.',
    '13. For content-led cards, catalogs, destinations, products, people or hero sections, use acquire_image to obtain relevant real photography instead of drawing the subject with generic SVG/CSS. Search specifically, use the returned local publicUrl, preserve the .license.json receipt, and show a discreet visible creator/source credit. Never invent external photo URLs, hotlink random search results, or imply that a representative photo depicts the exact item for sale. If acquisition fails, use a polished neutral placeholder clearly labeled as illustrative — never a childish drawing of the product.',
    '14. This template uses plain CSS only. Do not install or use Tailwind, shadcn, CSS-in-JS, Sass, PostCSS plugins, UI frameworks, or utility-class libraries. Write semantic className values in React and define every class in src/index.css (or imported .css files). Prefer a small design-token block with CSS custom properties and ordinary responsive CSS.',
    ...dynamicSection,
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
    maxHardIterations: settings.maxHardIterations || DEFAULT_LIMITS.maxHardIterations,
    maxRepairAttempts: settings.maxRepairAttempts || DEFAULT_LIMITS.maxRepairAttempts,
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

  const tools = { ...createTools(), ...createDynamicTools() };
  const isDynamicProject = project?.type === 'dynamic';
  // Dynamic tool definitions are exposed ONLY to dynamic projects.
  const ALL_TOOL_DEFS = isDynamicProject ? [...TOOL_DEFS, ...DYNAMIC_TOOL_DEFS] : TOOL_DEFS;
  let singleFileMode = false;
  let malformedResponses = 0;
  const availableToolDefs = () => singleFileMode ? ALL_TOOL_DEFS.filter(tool => tool.name !== 'write_files') : ALL_TOOL_DEFS;
  const ctx: ToolContext = {
    db,
    projectId: project.id,
    projectDir,
    frontendDir,
    cmdTimeoutMs: limits.cmdTimeoutMs,
    buildTimeoutMs: 600_000,
    // Fase 5B: the Studio proxy publishes dynamic previews at /a/:projectId/.
    // Same-host loopback is preferred; override with APPFORGE_STUDIO_URL.
    studioBaseUrl:
      process.env.APPFORGE_STUDIO_URL ?? `http://127.0.0.1:${process.env.PORT ?? 3001}`,
    deploymentDriver: opts.deploymentDriver,
  };

  // ---------------------------------------------------------------------
  // Fase 2 — safety net for dynamic projects (Trabajos 6–8).
  //
  // The orchestrator (never the model) tracks the BEST state reached in
  // this run: the longest valid-check prefix, tie-broken by API tests
  // passed on those exact sources. Every prefix growth takes an automatic
  // Git photo of that state (Trabajo 6). If the run later ends in failure,
  // failRun() restores the best photo — and only that photo (Trabajo 7).
  // get_dynamic_status exposes this tracking to the agent (Trabajo 8).
  // Static projects are untouched by all of it.
  // ---------------------------------------------------------------------
  type BestState = BestDynamicStateInfo & { gitSha: string; fingerprint: string };
  let bestState: BestState | null = null;
  /** Check recorded by the tool currently executing (consumed in perform). */
  let pendingRecordedCheck: DynamicCheckKey | null = null;
  /** API tests passed on the CURRENT sources (reset by any source edit). */
  let apiTestsPassedCurrent = 0;
  ctx.onDynamicCheckRecorded = (key) => {
    pendingRecordedCheck = key as DynamicCheckKey;
  };
  ctx.getBestDynamicState = () =>
    bestState
      ? {
          prefixLength: bestState.prefixLength,
          lastCheck: bestState.lastCheck,
          apiTestsPassed: bestState.apiTestsPassed,
          revisionId: bestState.revisionId,
        }
      : null;
  const initialPrefixLength = isDynamicProject ? validDynamicPrefixLength(ctx) : 0;

  const isBetterState = (a: BestState, b: BestState | null): boolean =>
    !b || a.prefixLength > b.prefixLength || (a.prefixLength === b.prefixLength && a.apiTestsPassed > b.apiTestsPassed);

  /**
   * Trabajo 6: automatic photo of the state that just extended the valid
   * prefix. Non-fatal by design (same criterion as the pre-run photo): a
   * failed photo is logged and the run continues without it.
   */
  const takeAutoSnapshot = async (checkKey: DynamicCheckKey, prefixLength: number): Promise<void> => {
    const label = `auto: tras ${checkKey} (run ${runId})`;
    try {
      const r = await tools.create_revision(ctx, { label });
      if (!r.ok) {
        emit(db, runId, 'log', { text: `auto snapshot failed (non-fatal): ${label}: ${r.error ?? r.code}` });
        return;
      }
      const data = r.data as { id: string; sha: string };
      const candidate: BestState = {
        prefixLength,
        lastCheck: checkKey,
        apiTestsPassed: apiTestsPassedCurrent,
        revisionId: data.id,
        gitSha: data.sha,
        fingerprint: sourceFingerprint(projectDir),
      };
      if (isBetterState(candidate, bestState)) bestState = candidate;
      emit(db, runId, 'log', { text: `auto snapshot: ${label} — ${prefixLength}/6 checks valid` });
      emit(db, runId, 'status', { phase: 'auto_snapshot', check: checkKey, prefixLength, revisionId: data.id });
    } catch (e) {
      emit(db, runId, 'log', { text: `auto snapshot failed (non-fatal): ${label}: ${(e as Error).message}` });
    }
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
    { role: 'system', content: systemPrompt(settings.language, ALL_TOOL_DEFS.map((d) => d.name), isDynamicProject) },
    {
      role: 'user',
      content: [
        `PROJECT CONTEXT:\n${readProjectContext(projectDir).slice(0, 4000)}`,
        `\nFILE TREE (frontend/):\n${treeText || '(empty)'}`,
        `\nCURRENT CORE FILES:\n${['package.json', 'tsconfig.app.json', 'src/App.tsx', 'src/index.css'].map((file) => {
          try { return `--- ${file} ---\n${fs.readFileSync(path.join(frontendDir, file), 'utf8').slice(0, 14000)}`; } catch { return `--- ${file}: missing ---`; }
        }).join('\n')}`,
        ...(isDynamicProject ? [`\nDYNAMIC TEMPLATE CONTRACTS (project-relative paths; preserve these contracts):\n${['backend/package.json', 'backend/src/server.ts', 'backend/src/auth/routes.ts', 'backend/src/db/index.ts', 'frontend/src/api.ts', 'frontend/src/api-url.ts'].map(file => {
          try { return `--- ${file} ---\n${fs.readFileSync(path.join(projectDir, file), 'utf8').slice(0, 9000)}`; } catch { return `--- ${file}: missing ---`; }
        }).join('\n')}`] : []),
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
  // Fase 1 circuit breakers (independent of the fingerprint-based
  // stagnation key above, which any source edit resets): count failed
  // repair verifications, and how many of them in a row produced the SAME
  // diagnostic signature (repairErrorSignature ignores source changes).
  let lastToolError: string | null = null;
  let failedRepairVerifications = 0;
  let lastErrorSignature = '';
  let repeatedErrorSignature = 0;
  let repairAbortMessage: string | null = null;
  const initialFingerprint = sourceFingerprint(frontendDir);
  const initialProjectFingerprint = sourceFingerprint(projectDir);
  const isFirstRun = (db.prepare('SELECT COUNT(*) AS n FROM runs WHERE project_id=? AND id<>?').get(project.id, runId) as { n: number }).n === 0;
  const unchangedStarter = () => {
    const templatesDir = process.env.APPFORGE_TEMPLATES_DIR;
    if (!templatesDir) return false;
    const starter = path.join(templatesDir, 'dynamic-react-node');
    return ['frontend/src', 'backend/src', 'migrations', 'tests'].every(dir => {
      const original = path.join(starter, dir), current = path.join(projectDir, dir);
      return fs.existsSync(original) && fs.existsSync(current) && sourceFingerprint(original) === sourceFingerprint(current);
    });
  };

  const perform = async (name: string, args: Record<string, unknown>, id: string = randomUUID()): Promise<ToolResult> => {
    if (cancelledNow()) return { ok: false, code: 'CANCELLED', error: t('cancelled'), durationMs: 0 };
    const beforeFingerprint = sourceFingerprint(isDynamicProject ? projectDir : frontendDir);
    // Fase 2: valid prefix before this tool, to detect growth afterwards.
    const prefixBefore = isDynamicProject ? validDynamicPrefixLength(ctx) : 0;
    pendingRecordedCheck = null;
    const remaining = limits.runTimeoutMs - (Date.now() - lastProgressAt);
    if (remaining <= 0) return { ok: false, code: 'RUN_TIMEOUT', error: t('runTimeout'), durationMs: 0 };
    ctx.cmdTimeoutMs = Math.min(limits.cmdTimeoutMs, remaining);
    ctx.buildTimeoutMs = Math.min(600_000, remaining);
    ctx.isCancelled = cancelledNow;
    emit(db, runId, 'tool_call', { id, name, arguments: args });
    let result: ToolResult;
    try {
      result = tools[name] ? await tools[name](ctx, args) : { ok: false, code: 'UNKNOWN_TOOL', error: `unknown tool: ${name}`, durationMs: 0 };
    } catch (error) {
      result = { ok: false, code: 'TOOL_EXCEPTION', error: (error as Error).message, durationMs: 0 };
    }
    stats.toolCalls++;
    if (name === 'run_build' || name === 'start_preview') stats.buildMs += result.durationMs;
    const tracked = ['write_file', 'write_files', 'patch_file', 'acquire_image', 'install_dependencies', 'run_build', 'test_preview', 'start_preview', ...DYNAMIC_TOOL_DEFS.map(d => d.name)].includes(name);
    const fileTool = ['write_file', 'write_files', 'patch_file', 'delete_file', 'acquire_image'].includes(name);
    const filePaths = name === 'write_files'
      ? ((args.files as Array<{ path?: string }> | undefined) ?? []).map((file) => file.path ?? '?')
      : [String(args.path ?? '?')];
    if (!result.ok) {
      stats.errors++;
      lastError = `${result.error ?? result.code}\n${result.output ?? ''}`.slice(0, 12000);
      lastToolError = lastError;
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
      if (fileTool && sourceFingerprint(isDynamicProject ? projectDir : frontendDir) !== beforeFingerprint) lastProgressAt = Date.now();
      // A later source change invalidates dynamic verification receipts;
      // the agent must re-run the affected checks in order.
      if (isDynamicProject && fileTool) invalidateDynamicChecks(ctx);
    }
    emit(db, runId, 'tool_result', { id, name, ok: result.ok, code: result.code, error: result.error, output: (result.output ?? '').slice(0, 12000), durationMs: result.durationMs });
    // Fase 2 (Trabajos 6–7): the tool has finished and the workspace is
    // quiet, so this is the safe moment to photograph progress. A check
    // recorded by THIS tool that extended the valid prefix triggers the
    // automatic photo; repeating an already-valid check (no growth) does
    // not. API test counts are tracked per-source for the best-state
    // tie-break: any successful edit makes previous counts describe old
    // sources, so they are reset.
    if (isDynamicProject) {
      if (name === 'run_api_tests') {
        const counts = result.data as { pass?: unknown } | undefined;
        if (counts && typeof counts.pass === 'number') apiTestsPassedCurrent = counts.pass;
      }
      if (result.ok && fileTool) apiTestsPassedCurrent = 0;
      const recorded = pendingRecordedCheck;
      pendingRecordedCheck = null;
      if (recorded && result.ok) {
        const prefixNow = validDynamicPrefixLength(ctx);
        if (prefixNow > prefixBefore) await takeAutoSnapshot(recorded, prefixNow);
      }
      // Tie-break upkeep: an apiTests run (pass or fail) on the EXACT
      // sources of the best photo can only improve its recorded count.
      if (
        name === 'run_api_tests' &&
        bestState &&
        validDynamicPrefixLength(ctx) === bestState.prefixLength &&
        sourceFingerprint(projectDir) === bestState.fingerprint &&
        apiTestsPassedCurrent > bestState.apiTestsPassed
      ) {
        bestState = { ...bestState, apiTestsPassed: apiTestsPassedCurrent };
      }
    }
    return result;
  };

  const compactRecoveryHistory = (reason: string): LlmMessage[] => [{
    role: 'system',
    content: systemPrompt(settings.language, availableToolDefs().map((d) => d.name), isDynamicProject),
  }, {
    role: 'user',
    content: [
      'RECOVERY MODE. Continue from the current files; do not restart or rewrite working parts.',
      `The previous model call failed transiently: ${reason}`,
      `Original goal (preserve all requirements):\n${String(run.prompt).slice(0, 20000)}`,
      `Current diagnostic:\n${(lastError ?? '(none)').slice(0, 8000)}`,
      ...['src/App.tsx', 'src/index.css', 'package.json'].map((file) => {
        try { return `--- ${file} ---\n${fs.readFileSync(path.join(frontendDir, file), 'utf8').slice(0, file.endsWith('.tsx') ? 18000 : 7000)}`; }
        catch { return `--- ${file}: missing ---`; }
      }),
      'Take the smallest concrete next action with tools. After edits, rebuild and verify interactions.',
      ...(singleFileMode ? ['JSON RECOVERY: write_files is unavailable. Call write_file or patch_file for ONE small complete file per response. Keep each file under 150 lines; split code into modules. Return valid JSON tool arguments, with escaped newlines and quotes. Do not attempt to return the entire application in one response.'] : []),
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
    const summary = proposedSummary || t(isDynamicProject ? 'verifiedDynamicSummary' : 'verifiedSummary');
    addAssistantMessage(db, project.id, summary);
    try { rewriteProjectContext({ projectDir, projectName: project.name, prompt: run.prompt, modifiedFiles: [...new Set(modifiedFiles)], summary, lastError: null, runId, status: 'done' }); } catch { /* best effort */ }
    updateRun(db, runId, { status: 'done', finishedAt: nowIso(), stats, error: null });
    db.prepare('UPDATE projects SET updated_at=? WHERE id=?').run(nowIso(), project.id);
    emit(db, runId, 'done', { summary: summary.slice(0, 4000) });
    clearCancel(runId);
  };

  /**
   * Fase 1: account for one FAILED verification. Two independent circuit
   * breakers live here (the fingerprint-based stagnation counter remains
   * as a third net, inside verify()):
   *  - identical diagnostic signature MAX_REPEATED_ERROR_SIGNATURE times
   *    in a row → the repair is going in circles even though files change;
   *  - more than limits.maxRepairAttempts failed repair verifications in
   *    total → the repair budget is exhausted even if errors keep varying.
   * Tripping only RECORDS the abort; the loop performs it (checkRepairAbort)
   * so verify() keeps its boolean contract for every caller.
   */
  const noteFailedVerification = (diagnostic: string): void => {
    failedRepairVerifications++;
    const signature = repairErrorSignature(diagnostic);
    if (signature && signature === lastErrorSignature) repeatedErrorSignature++;
    else {
      lastErrorSignature = signature;
      repeatedErrorSignature = 1;
    }
    if (repairAbortMessage) return;
    if (repeatedErrorSignature >= MAX_REPEATED_ERROR_SIGNATURE) {
      repairAbortMessage = `${t('loopDetected')}\n\nThe same verification errors repeated ${repeatedErrorSignature} times in a row without change, so further repair turns would repeat them. Last diagnostic:\n${diagnostic.slice(0, 6000)}`;
    } else if (failedRepairVerifications > limits.maxRepairAttempts) {
      repairAbortMessage = `${t('repairLimit')}\n\nAutomatic repair stopped after ${failedRepairVerifications} failed verification attempts (maxRepairAttempts=${limits.maxRepairAttempts}). Last diagnostic:\n${diagnostic.slice(0, 6000)}`;
    }
  };

  /**
   * Fase 2 (Trabajo 7): restore the workspace to the best photo of this
   * run. Runs ONLY from failRun — i.e. after the agent loop has ended, on
   * a quiet workspace — and returns the note that the final run message
   * must carry (the restore, or the discrepancy if verification fails).
   * Receipt coherence is explicit, not left to fingerprint side effects:
   * persisted receipts after the restored prefix are deleted, the prefix
   * receipts are re-recorded on the restored sources (degradation-era
   * invalidation deletes receipts outright), and the in-memory gate is
   * rebuilt to the same prefix — so a gate recomputed on the restored
   * sources yields exactly the photo's state.
   */
  const restoreToBestState = async (target: BestState): Promise<string> => {
    const es = settings.language === 'es';
    emit(db, runId, 'status', { phase: 'restoring_best', check: target.lastCheck, prefixLength: target.prefixLength, revisionId: target.revisionId });
    emit(db, runId, 'log', { text: `restoring best state: tras ${target.lastCheck} (${target.prefixLength}/6, revision ${target.revisionId})` });
    const restored = await restoreRevision(ctx, target.gitSha);
    if (!restored.ok) {
      emit(db, runId, 'status', { phase: 'restore_failed', error: restored.error });
      return es
        ? `⚠️ Se intentó restaurar el mejor estado alcanzado (tras ${target.lastCheck}) pero la restauración falló: ${restored.error}`
        : `⚠️ Tried to restore the best state reached (after ${target.lastCheck}) but the restore failed: ${restored.error}`;
    }
    const actualFingerprint = sourceFingerprint(projectDir);
    if (actualFingerprint !== target.fingerprint) {
      emit(db, runId, 'status', { phase: 'restore_mismatch', check: target.lastCheck, prefixLength: target.prefixLength });
      return es
        ? `⚠️ Restaurado a la foto tras ${target.lastCheck}, pero la huella de las fuentes NO coincide con la registrada en la foto: la restauración no se da por verificada.`
        : `⚠️ Restored to the photo after ${target.lastCheck}, but the source fingerprint does NOT match the one recorded in the photo: the restore is not verified.`;
    }
    // Recibos coherentes con la foto, de forma explícita: se eliminan los
    // posteriores al prefijo restaurado Y se re-registran los del prefijo
    // con las huellas de las fuentes restauradas. Re-registrar es
    // imprescindible: la invalidación durante la degradación ya había
    // BORRADO todos los recibos (no los marca caducados), así que sin esto
    // la puerta recalculada daría prefijo 0 sobre unas fuentes que son
    // exactamente las de la foto.
    try {
      deleteVerificationReceipts(db, project.id, DYNAMIC_CHECK_ORDER.slice(target.prefixLength));
      for (let i = 0; i < target.prefixLength; i++) {
        const key = DYNAMIC_CHECK_ORDER[i]!;
        const fp = checkScopeFingerprint(projectDir, key);
        if (fp !== null) recordVerificationReceipt(db, project.id, key, fp, i);
      }
    } catch {
      /* los recibos se recalculan por huella igualmente; nunca romper el cierre */
    }
    {
      const keep = new Set<string>(DYNAMIC_CHECK_ORDER.slice(0, target.prefixLength));
      const rebuilt: NonNullable<ToolContext['dynamicChecks']> = {};
      for (let i = 0; i < target.prefixLength; i++) {
        const key = DYNAMIC_CHECK_ORDER[i]!;
        const fp = checkScopeFingerprint(projectDir, key);
        if (fp !== null) rebuilt[key] = fp;
      }
      ctx.dynamicChecks = rebuilt;
      ctx.dynamicChecksOrder = DYNAMIC_CHECK_ORDER.slice(0, target.prefixLength).filter((k) => keep.has(k));
    }
    emit(db, runId, 'status', { phase: 'restored_best', check: target.lastCheck, prefixLength: target.prefixLength, revisionId: target.revisionId });
    emit(db, runId, 'log', { text: `restored to best state: tras ${target.lastCheck} (${target.prefixLength}/6 checks valid)` });
    return es
      ? `♻️ Restaurado al mejor estado alcanzado en esta ejecución: tras ${target.lastCheck} (${target.prefixLength}/6 comprobaciones válidas${target.apiTestsPassed > 0 ? `, ${target.apiTestsPassed} tests de API superados` : ''}). Los archivos coinciden con esa foto (huella verificada).`
      : `♻️ Restored to the best state reached in this run: after ${target.lastCheck} (${target.prefixLength}/6 checks valid${target.apiTestsPassed > 0 ? `, ${target.apiTestsPassed} API tests passing` : ''}). The files match that photo (fingerprint verified).`;
  };

  /**
   * Fase 2: unified failure exit for the agent loop. When `restore` is set
   * (failure terminations only: repair limit, hard iteration limit,
   * inactivity timeout) and a photo STRICTLY better than the run's initial
   * state exists, the workspace is first restored to it; the final message
   * always says expressly whether that happened. Success never reaches
   * this path, and neither does cancellation.
   */
  const failRun = async (message: string, code: string | undefined, restore: boolean): Promise<void> => {
    let finalMessage = message;
    if (restore && isDynamicProject) {
      if (bestState && bestState.prefixLength > initialPrefixLength) {
        finalMessage = `${message}\n\n${await restoreToBestState(bestState)}`;
      } else {
        finalMessage =
          `${message}\n\n` +
          (settings.language === 'es'
            ? 'No se restauró ningún estado anterior: la ejecución no llegó a superar el estado inicial, así que los archivos quedan como quedaron.'
            : 'No earlier state was restored: the run never improved on its initial state, so the files are left as they ended.');
      }
    }
    finishError(finalMessage, code);
  };

  /** Performs a recorded circuit-breaker abort, if any. Returns true when the run was finished. */
  const checkRepairAbort = async (): Promise<boolean> => {
    if (!repairAbortMessage) return false;
    await failRun(repairAbortMessage, 'REPAIR_LIMIT', true);
    return true;
  };

  const verify = async (): Promise<boolean> => {
    emit(db, runId, 'status', { phase: 'validating' });
    if (isDynamicProject) {
      // Code-level completion gate: the model cannot finish a dynamic app
      // unless all six checks are valid on the CURRENT sources and were
      // completed in canonical order. This never depends on the prompt.
      const gate = dynamicGateStatus(ctx);
      // Puerta de implementación: the six checks prove the present code
      // works, not that the requested app exists — the starter template
      // passes them by design. Require structural evidence (key areas
      // changed + new route/frontend surface) instead of the old
      // any-area-changed guard, which a single migration file defeated
      // (live case "PcBox online", 2026-10-21). When the template cannot
      // be located, fall back to the legacy untouched checks.
      const evidence = implementationEvidence(projectDir, process.env.APPFORGE_TEMPLATES_DIR);
      const untouchedTemplate = evidence.checked
        ? !evidence.implemented
        : (unchangedStarter() || (isFirstRun && sourceFingerprint(projectDir) === initialProjectFingerprint));
      if (!gate.complete || untouchedTemplate) {
        const reasons: string[] = [];
        if (untouchedTemplate) reasons.push(evidence.checked
          ? `NO_IMPLEMENTATION: ${evidence.missing.join('; ')}. Implement the user request before finishing`
          : 'NO_IMPLEMENTATION: only the starter template was checked; implement the user request before finishing');
        if (gate.missing.length > 0) reasons.push(`missing or stale checks: ${gate.missing.join(', ')}`);
        if (!gate.orderValid) reasons.push('checks were not completed in the required order');
        const diagnostics = [...criticalFailures.entries()].filter(([key]) => key !== 'dynamicChecks').map(([, value]) => value).join('\n').slice(0, 12000);
        lastError = `DYNAMIC CHECKS INCOMPLETE (${reasons.join('; ')}). Run the missing tools now, in this exact order: run_frontend_build → run_backend_build → run_migrations → run_api_tests → start_fullstack_preview → test_authenticated_flow. Do not declare the app finished until all six succeed on the current sources.\n${diagnostics}`;
        criticalFailures.set('dynamicChecks', lastError);
        repairing = true;
        const state = repairStateKey(sourceFingerprint(projectDir), lastError);
        if (state === lastRepairState) stagnantRepairs++;
        else {
          lastRepairState = state;
          stagnantRepairs = 0;
          lastProgressAt = Date.now();
        }
        history.push({ role: 'user', content: `AUTOMATIC VERIFICATION FAILED. ${lastError} repair turns are progress-aware and continue while diagnostics improve; ${maxStagnantRepairs - stagnantRepairs} unchanged attempts remain before recovery is considered stalled.` });
        noteFailedVerification(`${lastError}\n${lastToolError ?? ''}`);
        emit(db, runId, 'status', { phase: 'repairing', stagnantAttempts: stagnantRepairs, errorSignatureRepeats: repeatedErrorSignature, failedRepairVerifications, progressAware: true });
        return false;
      }
      criticalFailures.delete('dynamicChecks');
      // The four dynamic tools ARE the verification for dynamic projects
      // (the static preview flow does not apply: the frontend is served by
      // the project backend, covered by run_api_tests).
      complete();
      return true;
    }
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
    noteFailedVerification([...criticalFailures.values()].join('\n') || lastError || 'unknown');
    emit(db, runId, 'status', { phase: 'repairing', stagnantAttempts: stagnantRepairs, errorSignatureRepeats: repeatedErrorSignature, failedRepairVerifications, progressAware: true });
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
      await failRun(t('runTimeout'), undefined, true);
      return;
    }
    // Fase 1: hard iteration cap. Unlike maxIterations (which only forces
    // verify() and lets the repair phase run on), this always stops the
    // loop, so a runaway repair cannot iterate indefinitely.
    if (iter > limits.maxHardIterations) {
      stats.iterations = limits.maxHardIterations;
      await failRun(`${t('maxIterations')}\n\nHard iteration cap reached (${limits.maxHardIterations} iterations).`, 'ITERATION_LIMIT', true);
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
      resp = stub ? await stub.chat(history, TOOL_DEFS) : await chatLlm({ ...llmConfig!, deadline: lastProgressAt + limits.runTimeoutMs, ...(singleFileMode ? { maxTokens: Math.min(llmConfig!.maxTokens, 4096) } : {}) }, history, availableToolDefs());
    } catch (e) {
      if (e instanceof LlmError && ['LLM_TRUNCATED', 'LLM_BAD_TOOL_ARGS'].includes(e.code)) {
        stats.errors++;
        stats.llmCalls++;
        stats.llmMs += Date.now() - llmT0;
        malformedResponses++;
        lastError = e.message;
        emit(db, runId, 'log', { text: e.message });
        if (malformedResponses >= 4) {
          finishError(`${e.message}. Four consecutive invalid model responses; no file changes were made by those responses.`, e.code);
          return;
        }
        singleFileMode = true;
        history = compactRecoveryHistory(`${e.message}. The invalid response made no file changes.`);
        emit(db, runId, 'status', { phase: 'recovering_model', code: e.code, attempt: malformedResponses, strategy: 'single_file' });
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
      await failRun(`${t('llmFailed')}: ${(e as Error).message}`, 'LLM_ERROR', false);
      return;
    }
    stats.llmCalls += 1;
    malformedResponses = 0;
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
      if (await checkRepairAbort()) return;
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
      if (await checkRepairAbort()) return;
      if (stagnantRepairs >= maxStagnantRepairs) break;
    }
  }

  await failRun(`${t('repairLimit')}\n\n${lastError ?? t('maxIterations')}`, 'REPAIR_LIMIT', true);
}

const ES: Record<string, string> = {
  verifiedDynamicSummary: 'Compilaciones, migraciones, pruebas API y sesión en navegador verificadas. Preview disponible. Consulta Deploy para el estado de publicación.',
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
  verifiedDynamicSummary: 'Builds, migrations, API tests and browser session verified. Preview is available. Check Deploy for publication status.',
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
