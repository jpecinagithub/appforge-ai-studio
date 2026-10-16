# AppForge AI Studio — Contrato técnico (Fases 1–4)

Este documento es la única fuente de verdad para la integración entre
`apps/studio` (frontend), `apps/server` (API) y `apps/worker` (agente).
Si algo no está aquí, pregúntale al coordinador antes de inventarlo.

> **§9**: la especificación de la Fase 2 se implementó en la Fase 3
> (`templates/dynamic-react-node`) y el piloto superó el criterio de
> §9.16 el 2026-10-16 (3 pasadas E2E en Oracle). La puerta de
> compatibilidad admite desde entonces el stack dinámico (ver nota en
> §9.16). Pendientes las Fases 5–7: herramientas del agente, pipeline
> full-stack y despliegue en Oracle desde el Studio.

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
  templates/dynamic-react-node/ (Fase 3: plantilla full-stack; especificada en §9)
  infra/                  (docker-compose.yml, Caddyfile, scripts/, .env.example)
  docs/ARCHITECTURE.md
  README.md
```

## 9. Aplicaciones dinámicas (Fase 2 — especificación)

> **Estado a 2026-10-16**: la Fase 3 implementó esta sección
> (`templates/dynamic-react-node`) y el piloto superó el criterio de
> §9.16 (3 pasadas E2E en Oracle), por lo que la puerta de
> compatibilidad (`apps/server/src/compatibility.ts`) ya admite las
> capacidades dinámicas. Las Fases 5–7 (herramientas del agente,
> pipeline y despliegue en Oracle desde el Studio) siguen pendientes;
> no habilitar nada de eso en la UI antes de su validación.

### 9.1 Stack fijado del piloto

- Frontend: Vite + React 19 + TypeScript + **CSS convencional** (misma
  regla que las apps estáticas: nada de Tailwind ni frameworks CSS).
- Backend: Node.js + Fastify + TypeScript. SQLite via **`node:sqlite`**
  (módulo nativo de Node 22.5+, sin dependencias nativas que compilar).
- Hash de contraseñas: **Argon2id** via `hash-wasm` (WASM puro, sin
  node-gyp). Parámetros: memoria `19456` KiB, iteraciones `2`,
  paralelismo `1`, hash de 32 bytes, sal de 16 bytes aleatorios.
- Sin Prisma, sin ORMs, sin PostgreSQL, sin OAuth, sin subida de
  ficheros, sin pagos, sin correo. Un solo camino soportado.

### 9.2 Layout del proyecto dinámico

`templates/dynamic-react-node/` (Fase 3) generará esta estructura bajo
`$DATA_DIR/projects/{id}/`:

```text
project/
├── frontend/            # app Vite+React (como en estáticas; base:'./')
│   ├── src/
│   ├── index.html
│   ├── package.json
│   └── vite.config.ts
├── backend/
│   ├── src/
│   │   ├── server.ts    # entrypoint: config → migraciones → rutas → listen
│   │   ├── config.ts    # env validado con zod (nunca secretos en código)
│   │   ├── auth/        # registro/login/logout/sesión
│   │   ├── routes/      # rutas de dominio
│   │   └── db/          # apertura SQLite + runner de migraciones
│   ├── package.json
│   └── tsconfig.json
├── migrations/          # NNN_slug.sql, desde 001 (§9.4)
├── tests/               # tests API con node --test (los corre el agente)
├── data/                # SOLO desarrollo local; en producción manda el volumen
├── .env.example         # plantilla sin valores reales
├── .env                 # secretos por proyecto (generado; gitignored; 0600)
├── .gitignore
├── Dockerfile           # requisitos en §9.9
├── docker-compose.yml   # referencia / uso manual (no lo usa el Studio)
├── package.json         # scripts raíz: install, migrate, test, build, start
└── README.md
```

Reglas duras:

- Una sola invocación raíz por operación: `npm run install|migrate|test|build|start`
  (delegan a frontend/ y backend/ con lockfiles reproducibles).
- `npm ci` (no `npm install`) siempre que exista lockfile, en frontend y
  backend, también dentro del Docker build.
- Ningún secreto en el repo ni en la imagen (§9.12).

### 9.3 Base de datos SQLite por proyecto

- Fichero: `/data/app.db` **dentro del contenedor**, montado desde un
  volumen Docker propio del proyecto (`appforge-pdata-<id8>`, §9.10).
  `/data` nunca se copia a la imagen y nunca se reemplaza en un deploy.
- Modo WAL, `PRAGMA foreign_keys=ON`, `PRAGMA busy_timeout=5000`.
- El backend abre la BD en el arranque y aplica migraciones pendientes
  (§9.4) antes de aceptar tráfico.
- En desarrollo local (`npm start` sin Docker): `data/app.db` del árbol
  del proyecto. El código no distingue: la ruta viene de `DB_PATH`.

### 9.4 Migraciones

- Ficheros `migrations/NNN_slug.sql`, `NNN` desde `001`, orden
  lexicográfico = orden de aplicación.
- Cada fichero debe ser **idempotente y transaccional** (una transacción
  por fichero; si falla, rollback completo del fichero).
- Tabla de control en la BD de la app:

```sql
migrations(version INTEGER PK, name TEXT NOT NULL,
  checksum TEXT NOT NULL, applied_at TEXT NOT NULL);
```

- `checksum` = SHA-256 del contenido del fichero. Si un fichero ya
  aplicado cambia de checksum → error duro `MIGRATION_CHECKSUM_MISMATCH`,
  nunca se salta en silencio.
- El Studio registra además cada ejecución en su tabla `migrations`
  (§9.14) para observabilidad.
- Disciplina expand-only en el piloto: las migraciones solo añaden
  (tablas, columnas nulables, índices). Nada destructivo hasta que el
  contrato defina el patrón expand/contract.

### 9.5 Autenticación (backend generado)

Tablas en la BD de la app:

```sql
users(id TEXT PK, email TEXT UNIQUE NOT NULL, password_hash TEXT NOT NULL,
  display_name TEXT, created_at TEXT, updated_at TEXT);
sessions(id TEXT PK, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE, created_at TEXT, expires_at TEXT,
  last_seen_at TEXT);
```

- Registro: email válido + contraseña de **mínimo 12 caracteres**.
  Nunca se registra ni se devuelve la contraseña en logs/respuestas.
- Sesión: token aleatorio de 32 bytes; en BD se guarda su **SHA-256**
  (nunca el token en claro). Cookie: nombre configurable
  (`SESSION_COOKIE_NAME`, defecto `af_session`), `HttpOnly`,
  `SameSite=Lax`, `Secure` en producción, `Path=<PUBLIC_PATH>`,
  `Max-Age` = 7 días (`SESSION_TTL_DAYS`, defecto `7`).
- Login emite un token nuevo (rotación). Logout borra la fila de sesión
  (revocación inmediata) y limpia la cookie.
- `GET /api/auth/me` revalida la sesión en cada llamada (expirada o
  revocada → `401 UNAUTHORIZED`).
- **Rate limit en registro e inicio de sesión: 10 req/min/IP.**
  Respuesta `429 {"error":{"code":"RATE_LIMITED",...}}`.

### 9.6 CRUD y aislamiento por usuario

- Patrón REST fijo (el nombre del recurso lo decide el agente):

```text
GET    /api/items          → {"items":[...]}        (solo del usuario)
POST   /api/items          → 201 item
GET    /api/items/:id      → 200 item | 404
PATCH  /api/items/:id      → 200 item | 404
DELETE /api/items/:id      → 200 {"ok":true} | 404
```

- **Toda tabla de dominio lleva `user_id TEXT NOT NULL REFERENCES
  users(id) ON DELETE CASCADE` y toda consulta filtra por `user_id`.**
- Un registro de otro usuario responde `404 NOT_FOUND`, nunca `403`
  (no revelar existencia).
- Validación de entradas con `zod`; errores uniformes §9.7.

### 9.7 API del backend generado (contrato)

Base `/api` (mismo origen que el frontend: **sin CORS** en el despliegue
inicial). Errores: `{"error":{"code":"STRING","message":"..."}}`.

```text
GET  /healthz                    → {"ok":true,"version":"<semver>"} (público, §9.8)
POST /api/auth/register          → 201 {user} + cookie   (body {email,password})
POST /api/auth/login             → 200 {user} + cookie   (body {email,password})
POST /api/auth/logout            → 200 {"ok":true} + limpia cookie
GET  /api/auth/me                → 200 {user} | 401
GET  /api/users/me               → 200 {user} | 401      (perfil básico)
GET  /api/items                  → {"items":[...]}
POST /api/items                  → 201 item
GET  /api/items/:id              → 200 | 404
PATCH /api/items/:id             → 200 | 404
DELETE /api/items/:id            → 200 {"ok":true} | 404
```

- `user` = `{id, email, displayName|null, createdAt}`. Jamás incluye el hash.
- Rutas protegidas: todo `/api/*` **excepto** `/api/auth/register`,
  `/api/auth/login` y `/healthz`. Sin sesión válida → `401 UNAUTHORIZED`.
- Códigos: `VALIDATION_ERROR` 400, `UNAUTHORIZED` 401, `NOT_FOUND` 404,
  `CONFLICT` 409 (email ya registrado), `RATE_LIMITED` 429,
  `INTERNAL` 500. Mensajes claros, sin stack traces.

### 9.8 Health / readiness

- `GET /healthz` (público, sin auth): `200 {"ok":true,"version":"<semver>"}`
  si la BD responde (`SELECT 1`); si no, `503 {"ok":false}`.
- **No expone información sensible**: ni versiones de dependencias, ni
  rutas, ni detalles del error interno.
- El Studio lo sondea cada 5 s hasta 12 intentos (60 s) en `verifying`
  (§9.13). Tres `503`/timeouts seguidos en producción → el deploy se
  marca `failed` y dispara rollback (§9.15).

### 9.9 Contenedor por proyecto (requisitos de la imagen)

El agente genera el `Dockerfile` del proyecto (Fase 3); debe cumplir:

- Base `node:24-slim`. Usuario no root (`USER appuser`, creado en el
  Dockerfile). `EXPOSE 8080`; el backend escucha en `PORT` (defecto 8080).
- `COPY` de `backend/`, `frontend/dist/` (ya construido) y `package*.json`;
  `npm ci --omit=dev` (sin devDependencies en la imagen).
- **Prohibido**: `COPY data/`, `COPY .env`, secretos en `ENV`, Docker
  socket, credenciales cloud, acceso al endpoint de metadatos.
- `HEALTHCHECK` con `node -e` contra `http://127.0.0.1:8080/healthz`
  (interval 30 s, timeout 5 s, retries 3, start-period 20 s).
- El entrypoint ejecuta **migraciones pendientes (§9.4) y luego arranca
  el servidor**. Si una migración falla, el contenedor no arranca.
- Nomenclatura fijada por el Studio (el agente no la inventa):
  - imagen: `appforge/app-<projectId>:<tag>` (`tag` = `yyyymmddHHMMSS`
    o sha git corto)
  - contenedor live: `appforge-app-<id8>` (`id8` = 8 primeros chars del id)
  - contenedor de verificación: `appforge-app-<id8>-verify` (efímero)
  - volumen de datos: `appforge-pdata-<id8>` → montado en `/data`

### 9.10 Orquestación (módulo Docker del Studio)

- El Studio gestiona los contenedores de proyecto con un módulo
  dedicado en `apps/server` que invoca al CLI `docker` con **vectores de
  argumentos fijos** (sin shell, sin interpolación de entrada de
  usuario; los ids se validan `/^[0-9a-f-]{36}$/`, los puertos son
  enteros de rango).
- Operaciones: `ensureNetwork`, `buildImage`, `runMigrations`
  (contenedor efímero), `startContainer`, `stopContainer`,
  `removeContainer`, `containerStatus`, `copyDatabase`, `pruneImages`.
- **El despliegue del Studio en Oracle monta el socket Docker**
  (decisión deliberada y documentada: es el único punto con acceso).
- **Los contenedores de proyecto NUNCA reciben el socket**, ni las
  claves del Studio, ni credenciales cloud.
- El LLM no tiene acceso a Docker: no es una tool del agente y
  `run_command` sigue limitado a `npm|npx|node`.

### 9.11 Red y proxy

- Red Docker dedicada `appforge-apps`, **`internal: true`** (sin salida
  a internet y sin acceso al endpoint de metadatos cloud). El contenedor
  del Studio también está en esta red.
- Los contenedores de proyecto **no publican puertos en el host**.
  El Studio los alcanza por nombre Docker:
  `http://appforge-app-<id8>:8080`.
- El Studio proxifica `/:projectId` bajo su propio origen:

```text
https://<studio-host>/appforge/a/:projectId/*  →  http://appforge-app-<id8>:8080/*
```

  (quita el prefijo `/a/:projectId`, conserva método, query y cuerpo;
  timeout 30 s). Sin cambios en nginx, sin DNS ni certificados nuevos.
- La capa `/a/:id/` del Studio es pública (como `/p/`): la protección de
  datos la hace la sesión de la propia app (§9.5).
- Sin contenedor live → `404` con página de diagnóstico (enlaces:
  "Deploy", "Ver logs"), nunca un JSON crudo.
- El frontend generado usa `base: './'` y llama a la API con rutas
  relativas (`/api/...` resuelve bajo `/a/:id/`): **sin CORS**.

### 9.12 Variables de entorno por proyecto

Inyectadas en runtime con `--env-file` desde
`$DATA_DIR/projects/{id}/.env` (generado por el agente, `0600`,
gitignored, **nunca en la imagen**):

```text
PORT=8080
NODE_ENV=production
DB_PATH=/data/app.db
PUBLIC_PATH=/a/:projectId/        # el Studio lo fija en el deploy
SESSION_COOKIE_NAME=af_session
SESSION_TTL_DAYS=7
```

Secretos extra que declare el agente (p. ej. claves de APIs de la app)
van al mismo `.env`. El Studio nunca los muestra (como `Settings`).

### 9.13 Pipeline de despliegue (verificación → promoción → rollback)

Orden fijo (el agente no lo reordena):

1. `building` — `docker build` de `appforge/app-<id>:<tag>`.
2. `migrating` — contenedor efímero ejecuta migraciones pendientes
   contra una **BD de verificación vacía** (migraciones aplicadas desde
   cero); registra fila en `migrations` (§9.14).
3. `verifying` — arranca `appforge-app-<id8>-verify` (BD de verificación)
   y el Studio ejecuta: health check (§9.8) + tests API de `tests/`
   + flujo autenticado (register→login→me→CRUD→logout→401 sin sesión).
   Al terminar, el contenedor verify se detiene y elimina.
4. `promoting` — **backup pre-migración** de la BD live (§9.15);
   migraciones pendientes contra la BD live; stop del contenedor live
   anterior; start del nuevo como `appforge-app-<id8>`; health check.
5. `live` — health OK: se actualiza `project_runtime`
   (`live_image=<tag>`, `previous_image` = imagen anterior), se podan
   imágenes viejas (se conservan las 2 últimas).
6. `failed`/`rolled_back` — si falla `verifying` o `promoting`:
   stop del contenedor nuevo, **restaurar backup pre-migración**,
   arrancar `previous_image`, health check. Si el rollback responde →
   `rolled_back`; si no → `failed` con diagnóstico (no se reintenta en
   bucle).

Cada fase escribe en `deployments.logs`. Un deploy es atómico por fase:
nunca se deja un contenedor verify huérfano ni dos live a la vez.

### 9.14 Estados, tablas y reconciliación tras reinicio

Tablas nuevas en `$DATA_DIR/appforge.db` (además de las de §2):

```sql
migrations(id TEXT PK, project_id TEXT, version INTEGER, name TEXT,
  status TEXT, started_at TEXT, finished_at TEXT,
  duration_ms INTEGER, logs TEXT, error TEXT);
-- status: pending|running|success|failed
project_runtime(project_id TEXT PK, container_name TEXT, live_image TEXT,
  previous_image TEXT, status TEXT, updated_at TEXT);
-- status: running|stopped|missing
```

`deployments.status` pasa a enum cerrado:
`pending|building|migrating|verifying|promoting|live|failed|rolled_back|cancelled`.

Regla dura (igual que runs/builds): **ningún estado no terminal puede
sobrevivir a un reinicio del Studio.** Al arrancar:

- `deployments` en `pending|building|migrating|verifying|promoting` →
  `failed` (`error='interrupted by server restart'`); se eliminan
  contenedores `-verify` huérfanos; nunca quedan dos live.
- `migrations` en `pending|running` → `failed`.
- `project_runtime.status` se **reconcilia contra Docker real**
  (¿existe el contenedor? ¿está running?): Docker manda, la BD es caché.

### 9.15 Backup y restauración

- Backup automático **antes de cada migración sobre la BD live**
  (fase `promoting`): copia de `app.db*` a
  `$DATA_DIR/projects/{id}/backups/app-<yyyymmddHHMMSS>.db*`
  con el contenedor detenido.
- Tool/manual `backup_project_database`: mismo formato, bajo demanda.
- Restaurar = stop contenedor → reemplazar `app.db*` (borrando
  `-wal`/`-shm` residuales) → start → health check.
- Retención: últimas 10 copias (documentado; configurable).
- `backups/` y `.env` se excluyen del ZIP y de git (§9.19).

### 9.16 Criterios de aceptación del piloto

El piloto es **una app de tareas** generada de cero por el agente con el
stack de §9.1. La puerta de compatibilidad solo se abre para capacidades
dinámicas cuando el recorrido completo pase **3 veces seguidas, de cero,
sin intervención**:

1. crear proyecto dinámico → scaffold de `templates/dynamic-react-node`
2. `npm ci` reproducible (frontend + backend) con lockfiles
3. migraciones aplicadas y registradas (tabla `migrations` con checksums)
4. build frontend + build backend en verde
5. tests API en verde (`tests/`, con `node --test`)
6. deploy a Oracle: imagen construida, verify con health + flujo
   autenticado en verde, promoción a live
7. verificación manual contra la app live:
   - registro → sesión HttpOnly recuperada al recargar
   - ruta protegida denegada sin sesión (`401`)
   - perfil del usuario visible
   - CRUD crea/lista/edita/borra
   - **aislamiento**: user A no ve ni toca datos de user B (404)
   - logout invalida la sesión (401 en `/api/auth/me`)
   - reinicio del contenedor: datos y sesiones persistentes
8. rollback: deploy con migración rota → `rolled_back`, app anterior
   sirviendo, datos intactos
9. ZIP del proyecto excluye `node_modules/`, `dist/`, `.git/`, `*.db*`,
   `.env`, `backups/`, `*.log`

**Puerta abierta el 2026-10-16**: el recorrido completo pasó 3 veces
seguidas en Oracle (build ARM64 → contenedor verify con migraciones y
`healthz` → flujo autenticado 8/8 → rollback con migración rota). La
puerta de compatibilidad admite desde entonces el stack dinámico
(`apps/server/src/compatibility.ts`): backend/API genéricos, SQLite y
autenticación email + contraseña se enrutan a la plantilla fija
`templates/dynamic-react-node`. Siguen rechazados: frameworks distintos
de React 19, Tailwind/shadcn/Sass/CSS-in-JS, backends Python/PHP/Ruby/
Java/.NET/Express/Nest, PostgreSQL/MySQL/MongoDB/Prisma, Supabase/
Firebase y OAuth/login social.

### 9.17 Herramientas del agente (Fase 5A: locales implementadas)

Fase 5A implementa las cuatro operaciones **locales**, confinadas al
proyecto activo, sin shell y sin entrada arbitraria del modelo
(`apps/worker/src/dynamicTools.ts`):
`run_frontend_build`, `run_backend_build`,
`run_migrations` y `run_api_tests`.
`run_migrations` corre siempre contra una SQLite **temporal** de
verificación (nunca live): ejecuta `npm run migrate` dos veces contra la
misma base temporal (pasada de aplicación + pasada de idempotencia).
Cada herramienta registra estado terminal en `builds`/`migrations`
(§9.14), emite `tool_call`/`tool_result`, sanitiza secretos de los logs
(también en los campos `error`) y deja un receipt de verificación que se
invalida si las fuentes cambian. Los procesos hijo reciben un entorno
mínimo permitido (nunca `process.env` completo) y el timeout/cancelación
termina el árbol de procesos completo antes de informar.

La finalización de una aplicación dinámica está bloqueada **en código**:
`verify()` consulta `dynamicGateStatus()` y no permite `complete()` si
falta alguna comprobación o si no se completaron en el orden canónico
`run_frontend_build → run_backend_build → run_migrations → run_api_tests`;
registrar una comprobación invalida sus seguidoras canónicas, de modo que
una ejecución desordenada nunca puede acumular receipts. Las definiciones
`DYNAMIC_TOOL_DEFS` solo se exponen a proyectos dinámicos.

### 9.17bis Herramientas del agente (Fase 5B: preview efímero + flujo autenticado)

Fase 5B añade, con el mismo confinamiento (sin shell, sin entrada
arbitraria del modelo, entorno hijo mínimo permitido):

**Edición controlada por áreas** (`apps/worker/src/dynamicAreas.ts`): las
herramientas de archivos aceptan `area` en proyectos dinámicos —
`frontend` (`frontend/**/*`), `backend` (`backend/src/**/*`), `migrations`
(`migrations/*.sql`), `tests` (`tests/*.test.mjs`) — y resuelven la ruta
internamente dentro del proyecto activo. Siempre prohibidos:
`.env*`, `data/`, `backups/`, `metadata/`, `logs/`, `node_modules/`,
`dist/`, `.git/`, `Dockerfile`, `docker-compose.yml`, `package.json`,
lockfiles y `scripts/`. Se rechazan rutas absolutas, `..`, null bytes y
symlinks que escapen del área; solo texto UTF-8 con tamaño máximo.
Los proyectos estáticos conservan exactamente su comportamiento anterior
(`area` rechazado). Cualquier cambio invalida los receipts afectados y sus
seguidores canónicos.

**`start_fullstack_preview`** (`apps/worker/src/previewManager.ts`):
precondición en código — los cuatro receipts 5A vigentes y en orden
(`DYNAMIC_CHECKS_INCOMPLETE` si falta alguno). Crea una SQLite temporal
exclusiva, elige un puerto libre en loopback y arranca
`node backend/dist/server.js` con entorno mínimo (`PORT`, `HOST=127.0.0.1`,
`NODE_ENV=test`, `DB_PATH`, `PUBLIC_PATH=/a/:projectId/`, cookie de sesión
específica del proyecto; nunca secretos del Studio). Espera `/healthz`
con reintentos limitados, registra el preview en la tabla `previews`
(único activo por proyecto; al reemplazar, el anterior se detiene por
completo: árbol de procesos + espera de exit + limpieza de SQLite/WAL/SHM)
y devuelve `{url: "/a/:projectId/", status: "ready"}`. Timeout/cancelación
no dejan procesos ni puertos huérfanos.

**Proxy dinámico del Studio** (`GET|POST|… /a/:projectId/*` en
`apps/server`): localiza únicamente el preview registrado para el
proyecto, retira el prefijo, conserva método/query/body/cookies, soporta
JSON y assets, nunca reenvía el `Authorization` del Studio, elimina
headers hop-by-hop, aplica timeout (30 s) y límite de body (10 MiB),
impide acceso cruzado entre proyectos y responde una página HTML de
diagnóstico si no hay preview. La URL destino procede siempre del
registro interno: nunca es un proxy abierto.

**`test_authenticated_flow`** (`apps/worker/src/authFlow.ts`): se ejecuta
contra el preview publicado (nunca otro servidor) y exige el receipt de
preview vigente sobre las fuentes actuales. Fase API determinista:
`/healthz`, registro de A, cookie `HttpOnly`+`SameSite`, sesión,
crear+listar, registro de B, aislamiento (B recibe 404), vuelta a A,
logout, `/api/auth/me` → 401. Fase Chromium real contra `/a/:projectId/`
con selectores estables `data-testid` de la plantilla: registro desde la
UI, contenido autenticado visible, crear registro y ver el resultado
exacto, reload con recuperación de sesión, logout y vuelta a la pantalla
de autenticación. No acepta URLs, selectores, credenciales ni comandos.

**Gate de finalización 5B**: el orden canónico es ahora de seis —
`frontendBuild → backendBuild → migrations → apiTests → fullstackPreview → authenticatedFlow`;
`dynamicGateStatus()` exige los seis vigentes y en orden, ligados al
fingerprint de las fuentes actuales. Los receipts de `fullstackPreview` y
`authenticatedFlow` cubren la raíz del proyecto: cualquier cambio los
invalida.

**Estados y recuperación** (§9.14): la tabla `previews`
(`starting|ready|failed|stopped`) se reconcilia al arrancar AppForge —
ningún preview anterior se considera `ready`, los `starting` pasan a
`stopped`, se limpian registros huérfanos y PIDs antiguos nunca se
reutilizan (se intentan terminar por best-effort). Los previews son
provisionales y no equivalen a despliegues.

El despliegue live, `health_check_project`, `rollback_project` y
`backup_project_database` pertenecen a las Fases 6–7. Todas confinadas al
proyecto; ninguna ejecuta shell/Docker/SQL arbitrario: delegan en el
módulo de orquestación (§9.10).

### 9.18 Límites de recursos (defectos del piloto, configurables)

| Recurso | Defecto |
|---|---|
| CPU por contenedor | `1.0` (`--cpus`) |
| RAM por contenedor | `512m` (`--memory`, swap igualado) |
| PIDs por contenedor | `128` (`--pids-limit`) |
| Timeout build imagen | 10 min |
| Timeout migraciones | 5 min |
| Timeout total deploy | 20 min |
| Health check | sondeo 5 s × 12 intentos |

Disco: el volumen de datos se monitoriza (alerta en el Studio a partir
de un umbral configurable); cuota dura del driver fuera del alcance del
piloto. Tiempo de ejecución de comandos del agente: el ya existente
(`cmdTimeoutMs`).

### 9.19 Exclusiones ZIP y Git

`GET /api/projects/:id/archive` y `.gitignore` del proyecto excluyen:
`node_modules/`, `dist/`, `.git/`, `*.db`, `*.db-wal`, `*.db-shm`,
`.env`, `backups/`, `*.log`. Los secretos nunca salen del servidor.

### 9.20 API del Studio para dinámica (nuevos endpoints)

Base `/api`, mismo formato de errores que §3. `type=dynamic` requerido
donde se indica (`400 INVALID_TYPE` en otro caso).

- `POST /api/projects/:id/migrations` → `{"items":[MigrationRecord]}`
  (ejecuta pendientes contra la BD live; `409` si hay una en curso)
- `GET /api/projects/:id/migrations` → `{"items":[MigrationRecord]}`
  (desc por versión)
- `POST /api/projects/:id/deploy` body `{target:'oracle'}`
  → `202 DeploymentInfo` (pipeline §9.13; `409` si hay deploy no
  terminal; proyecto `static` → `501 {"error":{"code":"PHASE_3"}}`)
- `GET /api/projects/:id/deployments` → `{"items":[DeploymentInfo]}` (desc)
- `GET /api/deployments/:deploymentId` → `DeploymentInfo`
- `POST /api/projects/:id/rollback` → `DeploymentInfo` (nuevo registro;
  `409` si no hay `previous_image` o no hay backup pre-migración)
- `POST /api/projects/:id/database/backup`
  → `{"path":string,"createdAt":string,"sizeBytes":number}`
- `GET /api/projects/:id/runtime` → `ProjectRuntime`
- `GET /api/projects/:id/preview` → `{"url":"/a/:id/","status":"ready|starting|building|none"}`
  (`status` refleja el contenedor live; `none` si nunca se desplegó)

### Tipos dinámicos (Fase 2, amplían §5)

```ts
type MigrationStatus = 'pending'|'running'|'success'|'failed';
interface MigrationRecord { id:string; projectId:string; version:number;
  name:string; status:MigrationStatus; startedAt:string;
  finishedAt:string|null; durationMs:number|null; logs:string;
  error:string|null; }
type DeploymentStatus = 'pending'|'building'|'migrating'|'verifying'|
  'promoting'|'live'|'failed'|'rolled_back'|'cancelled';
// DeploymentInfo.status pasa a DeploymentStatus
type ProjectRuntimeStatus = 'running'|'stopped'|'missing';
interface ProjectRuntime { projectId:string; containerName:string;
  liveImage:string; previousImage:string|null;
  status:ProjectRuntimeStatus; updatedAt:string; }
interface AppHealth { ok:boolean; version:string; }
interface AuthUser { id:string; email:string; displayName:string|null;
  createdAt:string; }
```
