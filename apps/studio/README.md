# AppForge AI Studio — Frontend (`apps/studio`)

Estudio de desarrollo asistido por IA. React 19 + Vite + TypeScript strict + Tailwind CSS v4
+ React Router + Monaco Editor + Vercel Analytics. Bilingüe ES/EN, dark/light.

> La PWA del Studio se retiró: un service worker antiguo servía chunks obsoletos
> tras los despliegues. `public/sw.js` es un worker de retirada que limpia cachés,
> se desregistra y recarga los clientes. No reactivar PWA en esta fase.

**Contrato de integración:** `../CONTRACT.md` (única fuente de verdad de la API, SSE y settings).
El frontend no inventa endpoints: todo lo que llama existe en el contrato.

## Desarrollo

```bash
npm install
npm run dev        # http://localhost:5173 (proxy /api y /p/ → http://localhost:3001)
```

### Modo demo (sin backend)

```bash
VITE_DEMO=1 npm run dev
```

Sirve datos de ejemplo locales (proyectos, chat, runs simulados por SSE, builds,
revisiones, ficheros, settings). La UI muestra siempre la insignia **DEMO**.
También activable desde la pantalla de login (guarda `localStorage['appforge_demo']`).

## Variables de entorno

| Variable        | Descripción                                              |
| --------------- | -------------------------------------------------------- |
| `VITE_API_URL`  | Base del backend (`apps/server`). Vacío = mismo origen.  |
| `VITE_DEMO`     | `1` activa el backend simulado (solo desarrollo).        |

Ver `.env.example`.

## Autenticación

Si el backend define `APPFORGE_ADMIN_TOKEN`, todas las rutas `/api/*` exigen
`Authorization: Bearer <token>`. Ante un 401 el frontend muestra una pantalla de
login mínima; el token se guarda en `localStorage['appforge_token']`.

## Estructura

```
src/
  api/        client.ts (fetch wrapper + recursos), sse.ts (SSE vía fetch con auth),
              demo.ts (backend simulado), types.ts (espejo del contrato §5)
  i18n/       strings.ts (diccionarios ES/EN) · ../i18n.tsx (contexto useT)
  layout/     TopBar, Sidebar (+ navegación inferior móvil), AppLayout
  pages/      Dashboard, Projects, CreateApp, ProjectView, Library, Assets,
              Builds, Revisions, Settings, Login
  components/ Chat, Workspace (tabs Preview/Builds/Code/Console), FileTree,
              CodeEditor (Monaco), ui.tsx (primitivos)
  project/    active.tsx (proyecto activo p/ TopBar), work.tsx (estado del ProjectView)
  theme.tsx · auth.tsx · agent.tsx (estado global del agente)
```

## Verificación

```bash
npx tsc --noEmit -p tsconfig.app.json   # ¡OJO! `tsc --noEmit` a secas no comprueba nada (tsconfig solution-style)
npm run build
```

## Despliegue (Vercel)

`vercel.json` incluye el rewrite SPA (`/(.*)` → `/index.html`).
Definir `VITE_API_URL` con la URL pública del backend en las env vars del proyecto.
