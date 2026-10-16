# AppForge AI Studio — Contrato técnico (Fase 1)

Este documento es la única fuente de verdad para la integración entre
`apps/studio` (frontend), `apps/server` (API) y `apps/worker` (agente).
Si algo no está aquí, pregúntale al coordinador antes de inventarlo.

## 1. Puertos y variables de entorno

- Server: `PORT` (defecto `3001`).
- `DATA_DIR`: raíz de datos (defecto `./data` relativo al repo). Proyectos en `$DATA_DIR/projects/{id}/`.
- `APPFORGE_ADMIN_TOKEN`: si está definida, TODAS las rutas `/api/*` y `/p/*`
  exigen `Authorization: Bearer <token>`. El frontend la guarda en
  `localStorage['appforge_token']` tras una pantalla de login mínima.
- `CORS_ORIGIN`: origen permitido para el frontend (defecto `*` en dev).
- LLM: `LLM_PROVIDER` (`groq`|`openrouter`, defecto `groq`), `LLM_MODEL`,
  `LLM_TEMPERATURE` (defecto `0.2`), `LLM_MAX_TOKENS` (defecto `8000`),
  `LLM_TIMEOUT_MS` (defecto `120000`).
- `GROQ_API_KEY`, `OPENROUTER_API_KEY`: nunca se devuelven al frontend.
- `APPFORGE_LLM_STUB=1`: activa un proveedor determinista de mentira que
  ejecuta una secuencia fija de tool-calls (crear app de ejemplo desde la
  plantilla, build, preview). SOLO para tests automatizados. Debe estar
  documentado como tal y jamás usarse como si fuera IA real.

## 2. Base de datos (SQLite, modo WAL, fichero `$DATA_DIR/appforge.db`)

```sql
projects(id TEXT PK, name TEXT, description TEXT, type TEXT DEFAULT 'static',
  status TEXT DEFAULT 'active', model TEXT, created_at TEXT, updated_at TEXT,
  preview_url TEXT, production_url TEXT, config_json TEXT);
messages(id TEXT PK, project_id TEXT, role TEXT, content TEXT,
  created_at TEXT, tokens INTEGER);
runs(id TEXT PK, project_id TEXT, prompt TEXT, status TEXT, created_at TEXT,
  started_at TEXT, finished_at TEXT, stats_json TEXT, error TEXT);
-- status run: queued|running|done|error|cancelled
run_events(id INTEGER PK AUTOINCREMENT, run_id TEXT, seq INTEGER, kind TEXT,
  payload_json TEXT, created_at TEXT);
builds(id TEXT PK, project_id TEXT, status TEXT, started_at TEXT,
  finished_at TEXT, duration_ms INTEGER, logs TEXT, artifacts_json TEXT,
  error TEXT);
-- status build: pending|running|success|failed|cancelled
revisions(id TEXT PK, project_id TEXT, label TEXT, git_sha TEXT, created_at TEXT);
deployments(id TEXT PK, project_id TEXT, target TEXT, status TEXT, url TEXT,
  created_at TEXT, logs TEXT);
settings(id INTEGER PK CHECK(id=1), data_json TEXT);
```

Fechas en ISO 8601 UTC. IDs: `crypto.randomUUID()`.

## 3. API REST

Base: `/api`. JSON siempre. Errores: `{"error":{"code":"STRING","message":"..."}}`.

- `GET /api/health` → `{"ok":true,"version":"0.1.0"}`
- `GET /api/projects?search=&type=&status=&page=1&pageSize=24`
  → `{"items":[Project],"total":n}`
- `POST /api/projects` body `{name, description?, type?}` → `Project`
  (crea `$DATA_DIR/projects/{id}/`, copia `templates/static-react/` a
  `frontend/`, `git init` + commit inicial, escribe `PROJECT_CONTEXT.md`).
- `GET /api/projects/:id` → `Project`
- `PATCH /api/projects/:id` body parcial → `Project`
- `DELETE /api/projects/:id` → `{"ok":true}` (borra el directorio)
- `GET /api/projects/:id/messages` → `{"items":[ChatMessage]}` (asc)
- `POST /api/projects/:id/messages` body `{role, content}` → `ChatMessage`
- `POST /api/projects/:id/runs` body `{prompt}` → `Run` (status `queued`;
  el worker lo recoge; UN solo run `running|queued` por proyecto: si hay
  otro activo → `409 {code:"RUN_ACTIVE"}`).
- `GET /api/projects/:id/runs` → `{"items":[Run]}` (desc)
- `GET /api/runs/:runId` → `Run` (incluye `stats`)
- `POST /api/runs/:runId/cancel` → `{"ok":true}`
- `GET /api/runs/:runId/events` → **SSE** `text/event-stream`.
  Primero replay de `run_events` ordenados por `seq`, luego live.
  Formato por evento: `id: <seq>\nevent: <kind>\ndata: <json>\n\n`.
  kinds: `status|log|tool_call|tool_result|done|error`.
  Enviar comentario `:ping` cada 15 s. Cerrar al llegar a `done|error`.
- `GET /api/projects/:id/files` → `{"tree":[FileNode]}` (`frontend/` como raíz)
- `GET /api/projects/:id/files/content?path=src/App.tsx` → `{"path","content"}`
- `PUT /api/projects/:id/files/content` body `{path, content}` → `{"ok":true}`
  (rechazar `..`, rutas absolutas o fuera del proyecto → `400 INVALID_PATH`)
- `POST /api/projects/:id/builds` → `BuildRecord` (lanza `npm ci`/`npm install`
  + `npm run build` en `frontend/`; guarda logs; `409` si hay build en curso)
- `GET /api/projects/:id/builds` → `{"items":[BuildRecord]}` (desc)
- `GET /api/builds/:buildId` → `BuildRecord`
- `GET /api/projects/:id/archive` → descarga ZIP del proyecto
  (excluye `node_modules/`, `dist/`, `.git/`, `*.db`, `*.log`).
- `GET /api/projects/:id/revisions` → `{"items":[RevisionInfo]}` (desc)
- `POST /api/projects/:id/revisions` body `{label?}` → `RevisionInfo`
  (`git add -A && git commit`; guarda sha)
- `POST /api/projects/:id/revisions/:rid/restore` → `{"ok":true}`
  (`git reset --hard <sha>`)
- `POST /api/projects/:id/deploy` → `501 {"error":{"code":"PHASE_3"}}` (Fase 1)
- `GET /api/projects/:id/preview` → `{"url":"/p/:id/","status":"ready|building|none"}`
- `GET /api/settings` → `Settings` (secretos como `{configured:true|false}`)
- `PATCH /api/settings` body parcial → `Settings` (aplica proveedor, modelo,
  temperatura, maxTokens, maxIterations, timeouts, prefs; NUNCA devuelve
  valores de keys)

## 4. Preview estática

El servidor sirve `GET /p/:projectId/*` desde
`$DATA_DIR/projects/:id/frontend/dist/` con fallback a `index.html`
(SPA). Si no hay `dist/` → `404` con página HTML de diagnóstico
(enlaces: "Rebuild", "Ver logs"). `start_preview` del agente = asegurar
build OK y marcar preview lista.

## 5. Tipos compartidos (`packages/shared/src/index.ts`)

```ts
interface Project { id:string; name:string; description:string; type:'static'|'dynamic';
  status:string; model:string|null; createdAt:string; updatedAt:string;
  previewUrl:string|null; thumbnailUrl:string|null; productionUrl:string|null; config:Record<string,unknown>; }
interface ChatMessage { id:string; projectId:string; role:'user'|'assistant'|'system';
  content:string; createdAt:string; tokens:number|null; }
interface Run { id:string; projectId:string; prompt:string;
  status:'queued'|'running'|'done'|'error'|'cancelled';
  createdAt:string; startedAt:string|null; finishedAt:string|null;
  stats:RunStats|null; error:string|null; }
interface RunStats { iterations:number; llmCalls:number; llmMs:number; buildMs:number;
  tokensIn:number; tokensOut:number; toolCalls:number; errors:number; }
interface RunEvent { seq:number; kind:'status'|'log'|'tool_call'|'tool_result'|'done'|'error';
  data:unknown; createdAt:string; }
interface BuildRecord { id:string; projectId:string; status:'pending'|'running'|'success'|'failed'|'cancelled';
  startedAt:string; finishedAt:string|null; durationMs:number|null; logs:string;
  artifacts:{distSize:number}|null; error:string|null; }
interface RevisionInfo { id:string; projectId:string; label:string; gitSha:string; createdAt:string; }
interface DeploymentInfo { id:string; projectId:string; target:string; status:string;
  url:string|null; createdAt:string; logs:string|null; }
interface FileNode { name:string; path:string; type:'file'|'dir'; children?:FileNode[]; }
interface ToolResult { ok:boolean; data?:unknown; error?:string; code?:string;
  durationMs:number; output?:string; }
interface Settings { provider:'groq'|'openrouter'; model:string; temperature:number;
  maxTokens:number; maxIterations:number; llmTimeoutMs:number; cmdTimeoutMs:number;
  runTimeoutMs:number; language:'es'|'en'; theme:'dark'|'light';
  autoRevision:boolean; autoBuild:boolean;
  secrets:{groq:{configured:boolean}, openrouter:{configured:boolean}, vercel:{configured:boolean}}; }
```

## 6. Agente (`apps/worker`)

- Orquestador único. Loop: construye mensajes (system + `PROJECT_CONTEXT.md`
  + árbol de ficheros + últimos 20 mensajes), llama al LLM con tools
  (formato OpenAI function calling), ejecuta la tool, registra evento,
  repite hasta `done` del modelo o límite.
- Tools (todas confinadas al proyecto; `..` → error):
  `list_files, read_file, write_file, patch_file{path,search,replace}`,
  `delete_file, create_directory, search_code{pattern}`,
  `install_dependencies, run_build` (registra además una fila en `builds`
  para que la pestaña Builds muestre los builds del agente), `start_preview`,
  `create_revision{label}, run_command{cmd,args}` (allowlist `npm,npx,node`;
  sin shell; `cwd` = proyecto; timeout).
- Límites: `maxIterations=8`, `maxRepairAttempts=2`, `llmTimeoutMs`,
  `cmdTimeoutMs=180000`, `runTimeoutMs=900000`. Bucle si: 3 tool-calls
  idénticas seguidas, o el mismo error de build 2 veces → `error` con
  diagnóstico, sin destruir nada.
- Flujo: interpretar → plan (≤5 tareas, interno) → generar/editar desde la
  plantilla → validar (`tsc`, build, smoke HTTP del `dist`) → preview →
  resumen final al chat. Tras cambios relevantes reescribe
  `PROJECT_CONTEXT.md` (resumen, stack, estructura, decisiones, últimos
  cambios, errores).
- Métricas en `Run.stats`. Cancelación: flag en BD que el loop consulta
  entre iteraciones.

## 7. Seguridad

- Bearer obligatorio si `APPFORGE_ADMIN_TOKEN` está definida.
- CORS según `CORS_ORIGIN`. Rate limit 120 req/min/IP en `/api`.
- Validación con `zod` en todas las entradas. `run_command` sin shell.
- Ningún secreto viaja al frontend. ZIP excluye secretos y artefactos.

## 8. Estructura del repo

```
appforge/
  CONTRACT.md
  package.json            (workspaces: apps/server, apps/worker, packages/shared)
  apps/studio/            (frontend: proyecto Vite independiente)
  apps/server/            (Fastify; importa apps/worker y packages/shared)
  apps/worker/
  packages/shared/
  templates/static-react/ (plantilla Vite+React+TS+CSS convencional)
  infra/                  (docker-compose.yml, Caddyfile, scripts/, .env.example)
  docs/ARCHITECTURE.md
  README.md
```
