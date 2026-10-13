# Generation reliability

The car-catalog run on 2026-10-13 exhausted eight model turns after building without dependencies, installing them, then discovering TS6133/TS2440. There was no turn left to repair either error. Earlier checks covered a deterministic template edit, not real generation or runtime behavior.

The pipeline now owns dependency preparation and completion:

- `run_build` synchronizes dependencies before strict TypeScript and Vite. A changed manifest updates a stale lockfile; an unchanged install is reused.
- Core files and compiler constraints are included in the initial context. `write_files` lets the model generate related files in one turn.
- Generation retains its configured limit. Six bounded repair turns remain available after failed final verification; installation, compilation and automatic final verification do not require model turns.
- `start_preview` verifies source fingerprints, rebuilding after any edit. An old `dist/index.html` cannot certify new code.
- Real Chromium renders the nested `/p/:id/` bundle on desktop and mobile, collecting runtime/resource errors. The model can use `test_preview` to click, fill, select, assert visible text and reload.
- Interactive pages cannot complete without an interaction plus exact visible-text assertion against the current source. Successful interaction steps are replayed after source changes, from their original browser storage state. Browser storage also survives separate tool calls within a run.
- Terminal status is stored before the SSE terminal event. Failure context includes diagnostics for the next run.
- Prompt persistence belongs to the run API; Studio no longer inserts the same message twice.

Docker installs Chromium. Local development and CI need a Chrome/Chromium executable via `APPFORGE_BROWSER_EXECUTABLE`, or a Playwright Chromium installed with `npx playwright-core install chromium`. A missing browser is a verification failure, never a silent pass.

`npm run verify` covers last-turn repair with a real compiler/browser, stale-build rejection, runtime-error rejection, unchanged-template rejection, lockfile changes and truncated model responses. `scripts/acceptance.mjs` creates three additional cases using the real configured LLM through the authenticated API. Stub tests are explicitly test-only; live cases must also be inspected and exercised in the public browser before release.

Browser smoke verification checks loading; it does not prove arbitrary application semantics. Interaction assertions and live acceptance examples supplement it. No model can guarantee correct output for every prompt; failures remain bounded and include their actual diagnostic.

## Live acceptance evidence (13–14 October 2026)

Real authenticated runs used the production OpenRouter Qwen coder configuration, with eight generation turns and the bounded repair reserve. These were not stub-generated apps or hand-written replacement applications.

| Project | Successful run | Public-browser checks |
| --- | --- | --- |
| Car example `d64be444-9d40-4987-898c-72f721ba95cb` | `f7c2f2f7-866d-4b21-a5c6-a4167d276525` | Catalog loads; like counter changes and survives reload; local SVG illustrations |
| Tasks `14502e95-bc54-4f05-9f05-18be310181c4` | `52e5576d-fdd7-4e5b-a673-72657a7abdd0` | Add a task, persist on reload, complete/uncomplete it, filter pending/completed |
| Recipes `318b257a-9513-43ae-b88c-06b71a305492` | `5768fdae-d65c-4a24-be8a-9e603684b776` | Search pasta returns one recipe; vegetarian filter returns four; open/close ingredients and steps; favorite survives reload |

Public URLs are `https://jpecina.duckdns.org/appforge/p/<project-id>/`.

Initial acceptance exposed browser-session resets and unimplemented controls in the original car app. Some runs were cancelled for a worker deployment, then resumed; these are not presented as first-attempt successes. The original car app required a separate controls-repair run after its compile and persistence repairs. The live acceptance script preserves the run history instead of hiding retries.

Regression coverage includes last-turn compile repair, stale bundle rejection, runtime exceptions, exact (not substring) assertions, scoped assertions, cross-call persistence, replay from the original storage state, and rejection of untested interactive output. On 14 October, `npm run verify` passed 37 tests (18 server, 15 worker, 4 Studio), typecheck, lint, Studio production build and both dependency audits (zero known vulnerabilities).
