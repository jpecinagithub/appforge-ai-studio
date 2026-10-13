# Generation reliability

The car-catalog run on 2026-10-13 exhausted eight model turns after building without dependencies, installing them, then discovering TS6133/TS2440. There was no turn left to repair either error. Earlier checks covered a deterministic template edit, not real generation or runtime behavior.

The pipeline now owns dependency preparation and completion:

- `run_build` synchronizes dependencies before strict TypeScript and Vite. A changed manifest updates a stale lockfile; an unchanged install is reused.
- Core files and compiler constraints are included in the initial context. `write_files` lets the model generate related files in one turn.
- Generation retains its configured limit. Six bounded repair turns remain available after failed final verification; installation, compilation and automatic final verification do not require model turns.
- `start_preview` verifies source fingerprints, rebuilding after any edit. An old `dist/index.html` cannot certify new code.
- Real Chromium renders the nested `/p/:id/` bundle on desktop and mobile, collecting runtime/resource errors. The model can use `test_preview` to click, fill, select, assert visible text and reload.
- Terminal status is stored before the SSE terminal event. Failure context includes diagnostics for the next run.
- Prompt persistence belongs to the run API; Studio no longer inserts the same message twice.

Docker installs Chromium. Local development and CI need a Chrome/Chromium executable via `APPFORGE_BROWSER_EXECUTABLE`, or a Playwright Chromium installed with `npx playwright-core install chromium`. A missing browser is a verification failure, never a silent pass.

`npm run verify` covers last-turn repair with a real compiler/browser, stale-build rejection, runtime-error rejection, unchanged-template rejection, lockfile changes and truncated model responses. `scripts/acceptance.mjs` creates three additional cases using the real configured LLM through the authenticated API. Stub tests are explicitly test-only; live cases must also be inspected and exercised in the public browser before release.

Browser smoke verification checks loading; it does not prove arbitrary application semantics. Interaction assertions and live acceptance examples supplement it. No model can guarantee correct output for every prompt; failures remain bounded and include their actual diagnostic.
