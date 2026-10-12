# appforge-server — Backend de AppForge AI Studio (Fase 1)

API REST (Fastify) + worker del agente + SQLite en modo WAL. Sin paso de build:
se ejecuta con `tsx` y se verifican tipos con `tsc --noEmit`.

## Arranque

```sh
# desde la raíz del repo
npm install
npx tsx apps/server/src/index.ts
```

Variables de entorno:

| Var | Defecto | Descripción |
|---|---|---|
| `PORT` | `3001` | Puerto HTTP |
| `DATA_DIR` | `./data` | Raíz de datos (proyectos, `appforge.db`) |
| `TEMPLATES_DIR` | `./templates` | Plantillas de scaffolding |
| `APPFORGE_ADMIN_TOKEN` | — | Si se define, `/api/*` y `/p/*` exigen `Authorization: Bearer <token>` (también vale `?token=` en la query, útil para descargas/iframes) |
| `CORS_ORIGIN` | `*` | Origen CORS permitido |
| `LLM_PROVIDER` | `groq` | `groq` \| `openrouter` (semilla inicial de settings) |
| `LLM_MODEL` | — | Modelo (vacío = default del proveedor) |
| `LLM_TEMPERATURE` / `LLM_MAX_TOKENS` / `LLM_TIMEOUT_MS` | `0.2` / `8000` / `120000` | Semilla inicial de settings |
| `GROQ_API_KEY` / `OPENROUTER_API_KEY` | — | Keys solo en servidor, nunca viajan al frontend |
| `APPFORGE_LLM_STUB` | — | `=1` activa el proveedor determinista de mentira (SOLO tests) |

## Decisiones frente al contrato (lo más simple que cumple)

- **`type: 'dynamic'` en Fase 1**: se acepta y se guarda, pero el scaffold usa
  `templates/static-react/` igualmente. El flujo dinámico real (backend por
  proyecto) es Fase 2. La plantilla `templates/dynamic-react-node/` existe como
  marcador, no se usa todavía.
- **Revisions con árbol limpio**: si no hay cambios, se registra la revisión
  apuntando al `HEAD` actual en lugar de fallar el commit vacío.
- **`run_command`**: `cwd` = `frontend/` del proyecto (documentado en el schema
  de la tool). Timeouts: `cmdTimeoutMs` para comandos, 10 min fijos para
  `install_dependencies`/`run_build` y builds del servidor.
- **`PATCH /api/settings`**: además del parcial de `Settings`, acepta
  `secrets: { groqKey?, openrouterKey?, vercelToken? }` para guardar keys en el
  servidor. `GET /api/settings` solo devuelve `{configured: boolean}`.
- **Preview sin dist**: `GET /p/:id/*` devuelve 404 con página HTML de
  diagnóstico (botón Rebuild → `POST /api/projects/:id/builds`, enlace a logs).
- **Studio**: si existe `apps/studio/dist`, se sirve en `/` (modo single-server).
- **Cancelación**: `POST /api/runs/:runId/cancel` marca `cancelled` en BD + flag
  en memoria; el agente lo consulta entre iteraciones.
- **Reinicio (Test E)**: al arrancar, los runs en `queued`/`running` pasan a
  `error` ("interrupted by restart") antes de lanzar el worker.

## Tests

```sh
npm run test --workspace=apps/server   # API + ciclo stub completo (npm ci + build reales)
npm run test --workspace=apps/worker   # confinamiento de paths, allowlist
npm run typecheck --workspaces --if-present
```

El test `stub-cycle.test.ts` tarda 1–3 min (instala dependencias reales de la
plantilla). El stub (`APPFORGE_LLM_STUB=1`) es determinista y solo para tests:
documentado en `apps/worker/src/llm.ts`, jamás presentarlo como IA real.
