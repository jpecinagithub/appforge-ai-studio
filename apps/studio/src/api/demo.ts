// Backend simulado SOLO para desarrollo sin servidor real.
// Se activa con VITE_DEMO=1 o localStorage['appforge_demo']='1'.
// Toda la UI muestra la insignia DEMO cuando está activo.

import type {
  BuildRecord,
  ChatMessage,
  FileNode,
  Project,
  RevisionInfo,
  Run,
  RunEventKind,
  Settings,
} from './types';

export interface DemoResponse {
  ok: boolean;
  status: number;
  text: () => Promise<string>;
}

const now = () => new Date().toISOString();
const uid = () =>
  typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `demo-${Math.random().toString(36).slice(2)}`;

const T = (minsAgo: number) => new Date(Date.now() - minsAgo * 60000).toISOString();

// ---------------------------------------------------------------- estado ---

const projects: Project[] = [
  {
    id: 'demo-tictactoe',
    name: 'Tic-Tac-Toe AI',
    description: 'Tres en raya responsive contra la IA con tres niveles de dificultad y marcador.',
    type: 'static',
    status: 'active',
    model: 'llama-3.3-70b-versatile',
    createdAt: T(60 * 26),
    updatedAt: T(35),
    previewUrl: '/p/demo-tictactoe/',
    productionUrl: null,
    config: {},
  },
  {
    id: 'demo-tasks',
    name: 'Task Board',
    description: 'Gestor de tareas con categorías y almacenamiento persistente.',
    type: 'dynamic',
    status: 'active',
    model: 'llama-3.3-70b-versatile',
    createdAt: T(60 * 50),
    updatedAt: T(60 * 5),
    previewUrl: '/p/demo-tasks/',
    productionUrl: null,
    config: {},
  },
  {
    id: 'demo-portfolio',
    name: 'Portfolio',
    description: 'Landing personal con proyectos y contacto.',
    type: 'static',
    status: 'active',
    model: null,
    createdAt: T(60 * 72),
    updatedAt: T(60 * 30),
    previewUrl: null,
    productionUrl: null,
    config: {},
  },
];

const messages: Record<string, ChatMessage[]> = {
  'demo-tictactoe': [
    {
      id: uid(),
      projectId: 'demo-tictactoe',
      role: 'user',
      content: 'Crea un juego de tres en raya responsive contra la IA, con tres niveles de dificultad y un marcador.',
      createdAt: T(60 * 26),
      tokens: 42,
    },
    {
      id: uid(),
      projectId: 'demo-tictactoe',
      role: 'assistant',
      content:
        'He creado el juego de tres en raya:\n\n- Tablero responsive 3×3 con turnos alternos.\n- IA con 3 niveles: fácil (aleatorio), medio (bloqueo) y difícil (minimax).\n- Marcador persistente (victorias, empates, derrotas).\n- Build correcto y preview lista.\n\nPuedes pedirme cambios, por ejemplo: "añade modo 2 jugadores".',
      createdAt: T(60 * 25),
      tokens: 210,
    },
  ],
  'demo-tasks': [],
  'demo-portfolio': [],
};

const runs: Run[] = [
  {
    id: 'demo-run-1',
    projectId: 'demo-tictactoe',
    prompt: 'Crea un juego de tres en raya responsive contra la IA…',
    status: 'done',
    createdAt: T(60 * 26),
    startedAt: T(60 * 26),
    finishedAt: T(60 * 24),
    stats: {
      iterations: 5,
      llmCalls: 5,
      llmMs: 42000,
      buildMs: 18000,
      tokensIn: 12400,
      tokensOut: 9800,
      toolCalls: 9,
      errors: 0,
    },
    error: null,
  },
];

const builds: BuildRecord[] = [
  {
    id: 'demo-build-2',
    projectId: 'demo-tictactoe',
    status: 'success',
    startedAt: T(35),
    finishedAt: T(34),
    durationMs: 42000,
    logs: '$ npm ci\nadded 182 packages in 9s\n$ npm run build\nvite v6.0.0 building for production...\n✓ 42 modules transformed.\ndist/index.html  0.48 kB\ndist/assets/index.js  182.11 kB\n✓ built in 3.21s',
    artifacts: { distSize: 214302 },
    error: null,
  },
  {
    id: 'demo-build-1',
    projectId: 'demo-tictactoe',
    status: 'failed',
    startedAt: T(60 * 25),
    finishedAt: T(60 * 25 - 1),
    durationMs: 12000,
    logs: "$ npm run build\nsrc/App.tsx(12,5): error TS2322: Type 'string' is not assignable to type 'number'.\nBuild failed.",
    artifacts: null,
    error: "TS2322: Type 'string' is not assignable to type 'number'.",
  },
];

const revisions: RevisionInfo[] = [
  { id: 'demo-rev-2', projectId: 'demo-tictactoe', label: 'Añadido nivel difícil (minimax)', gitSha: 'a1b2c3d', createdAt: T(40) },
  { id: 'demo-rev-1', projectId: 'demo-tictactoe', label: 'Versión inicial', gitSha: '9f8e7d6', createdAt: T(60 * 26) },
];

const fileTree: FileNode[] = [
  { name: 'package.json', path: 'package.json', type: 'file' },
  { name: 'index.html', path: 'index.html', type: 'file' },
  { name: 'vite.config.ts', path: 'vite.config.ts', type: 'file' },
  {
    name: 'src',
    path: 'src',
    type: 'dir',
    children: [
      { name: 'main.tsx', path: 'src/main.tsx', type: 'file' },
      { name: 'App.tsx', path: 'src/App.tsx', type: 'file' },
      { name: 'index.css', path: 'src/index.css', type: 'file' },
      {
        name: 'components',
        path: 'src/components',
        type: 'dir',
        children: [
          { name: 'Board.tsx', path: 'src/components/Board.tsx', type: 'file' },
          { name: 'Square.tsx', path: 'src/components/Square.tsx', type: 'file' },
        ],
      },
      { name: 'lib', path: 'src/lib', type: 'dir', children: [
        { name: 'ai.ts', path: 'src/lib/ai.ts', type: 'file' },
      ] },
    ],
  },
];

const genericTree: FileNode[] = [
  { name: 'package.json', path: 'package.json', type: 'file' },
  { name: 'index.html', path: 'index.html', type: 'file' },
  {
    name: 'src',
    path: 'src',
    type: 'dir',
    children: [
      { name: 'main.tsx', path: 'src/main.tsx', type: 'file' },
      { name: 'App.tsx', path: 'src/App.tsx', type: 'file' },
    ],
  },
];

const fileContents: Record<string, string> = {
  'package.json': '{\n  "name": "tic-tac-toe-ai",\n  "private": true,\n  "version": "0.1.0",\n  "scripts": {\n    "dev": "vite",\n    "build": "tsc && vite build",\n    "preview": "vite preview"\n  }\n}\n',
  'src/App.tsx': "import { useState } from 'react';\nimport Board from './components/Board';\n\nexport default function App() {\n  const [difficulty, setDifficulty] = useState<'easy' | 'medium' | 'hard'>('medium');\n  return (\n    <main>\n      <h1>Tic-Tac-Toe AI</h1>\n      <Board difficulty={difficulty} onDifficultyChange={setDifficulty} />\n    </main>\n  );\n}\n",
  'src/lib/ai.ts': '// Estrategia de la IA: easy = aleatorio, medium = bloqueo, hard = minimax.\nexport type Difficulty = \'easy\' | \'medium\' | \'hard\';\n\nexport function bestMove(board: (string | null)[], difficulty: Difficulty): number {\n  const empty = board.map((v, i) => (v === null ? i : -1)).filter((i) => i >= 0);\n  if (difficulty === \'easy\' || empty.length === 0) {\n    return empty[Math.floor(Math.random() * empty.length)];\n  }\n  return minimax(board, true).index;\n}\n\nfunction minimax(board: (string | null)[], maximizing: boolean): { index: number; score: number } {\n  // (versión simplificada de ejemplo)\n  return { index: 4, score: 0 };\n}\n',
};

let settings: Settings = {
  provider: 'groq',
  model: 'llama-3.3-70b-versatile',
  temperature: 0.2,
  maxTokens: 8000,
  maxIterations: 8,
  llmTimeoutMs: 120000,
  cmdTimeoutMs: 180000,
  runTimeoutMs: 900000,
  language: 'es',
  theme: 'dark',
  autoRevision: true,
  autoBuild: true,
  secrets: {
    groq: { configured: true },
    openrouter: { configured: false },
    vercel: { configured: false },
  },
};

// ---------------------------------------------------------------- router ---

function json(body: unknown, status = 200): DemoResponse {
  return { ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(body) };
}

function err(code: string, message: string, status: number): DemoResponse {
  return json({ error: { code, message } }, status);
}

function findRun(runId: string): Run | undefined {
  return runs.find((r) => r.id === runId);
}

function treeFor(projectId: string): FileNode[] {
  return projectId === 'demo-tictactoe' ? fileTree : genericTree;
}

export async function demoFetch(path: string, init: RequestInit = {}): Promise<DemoResponse> {
  await new Promise((r) => setTimeout(r, 120)); // latencia simulada
  const method = (init.method ?? 'GET').toUpperCase();
  const url = new URL(path, 'http://demo');
  const seg = url.pathname.split('/').filter(Boolean); // ['api', ...]
  const body = init.body ? (JSON.parse(init.body as string) as Record<string, unknown>) : {};

  if (seg[0] !== 'api') return err('NOT_FOUND', 'Not found', 404);
  const rest = seg.slice(1);

  // /api/health
  if (rest[0] === 'health' && method === 'GET') return json({ ok: true, version: '0.1.0-demo' });

  // /api/settings
  if (rest[0] === 'settings') {
    if (method === 'GET') return json(settings);
    if (method === 'PATCH') {
      settings = { ...settings, ...body } as Settings;
      return json(settings);
    }
  }

  // /api/runs/:runId[/cancel]
  if (rest[0] === 'runs' && rest[1]) {
    const run = findRun(rest[1]);
    if (!run) return err('NOT_FOUND', 'Run not found', 404);
    if (rest[2] === 'cancel' && method === 'POST') {
      run.status = 'cancelled';
      run.finishedAt = now();
      return json({ ok: true });
    }
    if (method === 'GET' && !rest[2]) return json(run);
  }

  // /api/builds/:buildId
  if (rest[0] === 'builds' && rest[1] && method === 'GET') {
    const b = builds.find((x) => x.id === rest[1]);
    return b ? json(b) : err('NOT_FOUND', 'Build not found', 404);
  }

  // /api/projects...
  if (rest[0] === 'projects') {
    // /api/projects (lista / crear)
    if (rest.length === 1) {
      if (method === 'GET') {
        const search = (url.searchParams.get('search') ?? '').toLowerCase();
        const type = url.searchParams.get('type') ?? '';
        const status = url.searchParams.get('status') ?? '';
        const page = Number(url.searchParams.get('page') ?? '1');
        const pageSize = Number(url.searchParams.get('pageSize') ?? '24');
        let items = projects.filter(
          (p) =>
            (!search || p.name.toLowerCase().includes(search) || p.description.toLowerCase().includes(search)) &&
            (!type || p.type === type) &&
            (!status || p.status === status),
        );
        items = [...items].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
        const total = items.length;
        return json({ items: items.slice((page - 1) * pageSize, page * pageSize), total });
      }
      if (method === 'POST') {
        const name = String(body.name ?? '').trim();
        if (!name) return err('VALIDATION', 'name is required', 400);
        const p: Project = {
          id: uid(),
          name,
          description: String(body.description ?? ''),
          type: body.type === 'dynamic' ? 'dynamic' : 'static',
          status: 'active',
          model: settings.model,
          createdAt: now(),
          updatedAt: now(),
          previewUrl: null,
          productionUrl: null,
          config: {},
        };
        projects.unshift(p);
        messages[p.id] = [];
        return json(p);
      }
    }

    const projectId = rest[1];
    const project = projects.find((p) => p.id === projectId);
    if (!project) return err('NOT_FOUND', 'Project not found', 404);
    const sub = rest[2];

    if (!sub) {
      if (method === 'GET') return json(project);
      if (method === 'PATCH') {
        Object.assign(project, {
          name: body.name ?? project.name,
          description: body.description ?? project.description,
          status: body.status ?? project.status,
          updatedAt: now(),
        });
        return json(project);
      }
      if (method === 'DELETE') {
        const i = projects.findIndex((p) => p.id === projectId);
        projects.splice(i, 1);
        delete messages[projectId];
        return json({ ok: true });
      }
    }

    if (sub === 'messages') {
      if (method === 'GET') return json({ items: messages[projectId] ?? [] });
      if (method === 'POST') {
        const m: ChatMessage = {
          id: uid(),
          projectId,
          role: (body.role as ChatMessage['role']) ?? 'user',
          content: String(body.content ?? ''),
          createdAt: now(),
          tokens: null,
        };
        (messages[projectId] ??= []).push(m);
        return json(m);
      }
    }

    if (sub === 'runs') {
      if (method === 'GET') {
        return json({
          items: runs.filter((r) => r.projectId === projectId).sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
        });
      }
      if (method === 'POST') {
        const active = runs.find(
          (r) => r.projectId === projectId && (r.status === 'queued' || r.status === 'running'),
        );
        if (active) return err('RUN_ACTIVE', 'Another run is already active for this project', 409);
        const run: Run = {
          id: uid(),
          projectId,
          prompt: String(body.prompt ?? ''),
          status: 'queued',
          createdAt: now(),
          startedAt: null,
          finishedAt: null,
          stats: null,
          error: null,
        };
        runs.push(run);
        return json(run);
      }
    }

    if (sub === 'files') {
      if (rest[3] === 'content') {
        const p = url.searchParams.get('path') ?? '';
        if (method === 'GET') {
          if (p.includes('..')) return err('INVALID_PATH', 'Invalid path', 400);
          return json({ path: p, content: fileContents[p] ?? `// ${p}\n// (contenido de ejemplo en modo demo)\n` });
        }
        if (method === 'PUT') {
          const fp = String(body.path ?? '');
          if (fp.includes('..')) return err('INVALID_PATH', 'Invalid path', 400);
          fileContents[fp] = String(body.content ?? '');
          return json({ ok: true });
        }
      }
      if (method === 'GET' && !rest[3]) return json({ tree: treeFor(projectId) });
    }

    if (sub === 'builds') {
      if (method === 'GET') {
        return json({
          items: builds.filter((b) => b.projectId === projectId).sort((a, b) => b.startedAt.localeCompare(a.startedAt)),
        });
      }
      if (method === 'POST') {
        const active = builds.find((b) => b.projectId === projectId && (b.status === 'pending' || b.status === 'running'));
        if (active) return err('BUILD_ACTIVE', 'A build is already running', 409);
        const b: BuildRecord = {
          id: uid(),
          projectId,
          status: 'success',
          startedAt: now(),
          finishedAt: now(),
          durationMs: 38000,
          logs: '$ npm ci\nadded 182 packages\n$ npm run build\n✓ built in 3.4s (demo)',
          artifacts: { distSize: 198450 },
          error: null,
        };
        builds.unshift(b);
        return json(b);
      }
    }

    if (sub === 'archive' && method === 'GET') return json({ ok: true });

    if (sub === 'revisions') {
      const rid = rest[3];
      if (!rid) {
        if (method === 'GET') {
          return json({
            items: revisions.filter((r) => r.projectId === projectId).sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
          });
        }
        if (method === 'POST') {
          const rev: RevisionInfo = {
            id: uid(),
            projectId,
            label: String(body.label ?? 'Checkpoint'),
            gitSha: Math.random().toString(16).slice(2, 9),
            createdAt: now(),
          };
          revisions.unshift(rev);
          return json(rev);
        }
      } else if (rid && rest[4] === 'restore' && method === 'POST') {
        return json({ ok: true });
      }
    }

    if (sub === 'deploy' && method === 'POST') {
      return err('PHASE_3', 'Deployments are planned for Phase 3', 501);
    }

    if (sub === 'preview' && method === 'GET') {
      return json({
        url: `/p/${projectId}/`,
        status: project.previewUrl ? 'ready' : 'none',
      });
    }
  }

  return err('NOT_FOUND', 'Not found', 404);
}

// ------------------------------------------------- simulación de eventos ---

export type DemoEmit = (seq: number, kind: RunEventKind, data: unknown) => void;

export function demoSimulateRunEvents(runId: string, emit: DemoEmit, signal: AbortSignal): void {
  const run = findRun(runId);
  if (run) {
    run.status = 'running';
    run.startedAt = now();
  }
  let seq = 0;
  const timers: ReturnType<typeof setTimeout>[] = [];
  const steps: [RunEventKind, unknown][] = [
    ['status', { phase: 'analyzing', message: 'Analizando la solicitud…' }],
    ['log', { message: 'Plan: 1) generar componentes 2) build 3) preview' }],
    ['tool_call', { tool: 'write_file', args: { path: 'src/App.tsx' } }],
    ['tool_result', { ok: true, durationMs: 120, output: 'src/App.tsx actualizado' }],
    ['status', { phase: 'building', message: 'Compilando…' }],
    ['tool_call', { tool: 'run_build', args: {} }],
    ['tool_result', { ok: true, durationMs: 3400, output: '✓ built in 3.4s' }],
    ['status', { phase: 'verifying', message: 'Verificando la aplicación…' }],
    ['log', { message: 'Smoke test HTTP: 200 OK' }],
    ['done', { summary: 'Aplicación generada y verificada. Preview lista.' }],
  ];
  steps.forEach(([kind, data], i) => {
    timers.push(
      setTimeout(() => {
        if (signal.aborted) return;
        emit(++seq, kind, data);
        if (kind === 'done' && run) {
          run.status = 'done';
          run.finishedAt = now();
          run.stats = {
            iterations: 4,
            llmCalls: 4,
            llmMs: 31000,
            buildMs: 3400,
            tokensIn: 8200,
            tokensOut: 6100,
            toolCalls: 6,
            errors: 0,
          };
          const list = messages[run.projectId] ?? [];
          list.push({
            id: uid(),
            projectId: run.projectId,
            role: 'assistant',
            content: 'He aplicado los cambios solicitados (demo):\n\n- Archivos generados y verificados.\n- Build correcto y preview lista.\n\nPuedes seguir pidiendo modificaciones en el chat.',
            createdAt: now(),
            tokens: 120,
          });
        }
      }, 650 * (i + 1)),
    );
  });
  signal.addEventListener('abort', () => {
    timers.forEach(clearTimeout);
    if (run && (run.status === 'running' || run.status === 'queued')) {
      run.status = 'cancelled';
      run.finishedAt = now();
    }
  });
}

export function demoArchiveBlob(project: Project): Blob {
  const readme = `# ${project.name}\n\n${project.description}\n\n(Archivo ZIP de ejemplo generado en modo DEMO — sin backend real.)\n`;
  return new Blob([readme], { type: 'application/zip' });
}
