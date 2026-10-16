/** Live acceptance cases, using the same authenticated API as Studio.
 * Run inside the AppForge container:
 *   node /tmp/acceptance.mjs start|status|cancel|retry|repair|compat|verify
 * - start:  create the generation cases and launch the agent runs (consumes LLM tokens).
 * - compat: deterministic compatibility-gate check (no LLM calls, cleans up after itself).
 * - verify: deterministic checks over finished runs (no Tailwind in output, build ok,
 *           preview 200, thumbnail 200, real Chromium test_preview in the event log).
 * Credentials are read from its environment, never written to the report.
 */
import fs from 'node:fs';
const base = process.env.APPFORGE_ACCEPTANCE_URL || `http://127.0.0.1:${process.env.PORT || 3001}`;
const file = process.env.APPFORGE_ACCEPTANCE_REPORT || '/tmp/appforge-acceptance.json';
const api = async (route, body) => {
  const response = await fetch(`${base}/api${route}`, { method: body ? 'POST' : 'GET', headers: { Authorization: `Bearer ${process.env.APPFORGE_ADMIN_TOKEN}`, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const data = await response.json();
  if (!response.ok) throw new Error(`${response.status}: ${JSON.stringify(data)}`);
  return data;
};
const check = (name, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) process.exitCode = 1;
};
/** Replay the SSE event log of a run. The server closes the stream after a
 * terminal event; runs that never emitted events (e.g. compatibility
 * rejections) keep the stream open, so the timeout resolves with whatever
 * was collected instead of hanging forever. */
const collectRunEvents = async (runId, timeoutMs = 15000) => {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  const events = [];
  try {
    const res = await fetch(`${base}/api/runs/${runId}/events`, {
      headers: { Authorization: `Bearer ${process.env.APPFORGE_ADMIN_TOKEN}`, Accept: 'text/event-stream' },
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error(`events HTTP ${res.status}`);
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    let terminalSeen = false;
    while (!terminalSeen) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf('\n\n')) >= 0) {
        const block = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        const kind = (block.match(/^event: ([^\s:][^:]*)$/m) || [])[1];
        if (!kind) continue; // :ping and other comments
        const data = (block.match(/^data: (.+)$/m) || [])[1];
        events.push({ kind, data: data ? JSON.parse(data) : null });
        if (kind === 'done' || kind === 'error') terminalSeen = true;
      }
    }
    try { await reader.cancel(); } catch { /* already closed */ }
  } catch (e) {
    if (!e || e.name !== 'AbortError') throw e;
    // Timeout: return what was collected (empty when the run emitted nothing).
  } finally {
    clearTimeout(timer);
  }
  return events;
};
if (process.argv[2] === 'start') {
  if (fs.existsSync(file)) throw new Error('Report already exists; use status to inspect the existing cases.');
  const cases = [
    { name: 'Prueba · Catálogo de coches', prompt: 'Me gustaría una tienda de coches donde se pueda ver el catálogo de todos los coches. Me gustaría que tuviera solo front con Vite React y que en cada coche se pudiera clicar en thumbs up. Algo sencillo pero vistoso.' },
    { name: 'Prueba · Lista de tareas', prompt: 'Crea una app de tareas en español con React. Quiero añadir tareas, marcarlas completadas, filtrarlas por pendientes o completadas y borrarlas. Conserva los datos al recargar. Diseño limpio, responsive y vistoso. Solo frontend.' },
    { name: 'Prueba · Recetario', prompt: 'Haz un recetario en español con seis recetas de ejemplo, buscador por nombre, filtro vegetariano, botón para guardar favoritos y un detalle de cada receta con ingredientes y pasos. Mantén favoritos al recargar. Solo frontend React, sencillo y vistoso.' },
  ];
  const report = [];
  for (const item of cases) {
    const project = await api('/projects', { name: item.name, description: 'Prueba real de aceptación de AppForge', type: 'static' });
    const run = await api(`/projects/${project.id}/runs`, { prompt: item.prompt });
    report.push({ ...item, projectId: project.id, runId: run.id });
    fs.writeFileSync(file, JSON.stringify(report, null, 2));
  }
  console.log(JSON.stringify(report, null, 2));
} else if (process.argv[2] === 'cancel') {
  const report = JSON.parse(fs.readFileSync(file, 'utf8'));
  for (const item of report) {
    const run = await api(`/runs/${item.runId}`);
    if (['queued', 'running'].includes(run.status)) await api(`/runs/${item.runId}/cancel`, {});
  }
  console.log('Acceptance runs cancelled; project files preserved.');
} else if (process.argv[2] === 'retry') {
  const report = JSON.parse(fs.readFileSync(file, 'utf8'));
  const latest = new Map(report.map((item) => [item.projectId, item]));
  for (const item of latest.values()) {
    const previous = await api(`/runs/${item.runId}`);
    if (previous.status === 'done') continue;
    const visual = ' No uses URLs de fotografías inventadas ni fotos ajenas al contenido. Utiliza ilustraciones SVG/CSS locales relevantes y etiquetadas como ilustraciones. Comprueba interacciones y recarga con test_preview.';
    const prompt = item.prompt + visual;
    const runs = await api(`/projects/${item.projectId}/runs`);
    const active = runs.items.find((candidate) => ['queued', 'running'].includes(candidate.status));
    if (active && active.prompt !== prompt) throw new Error('Another run is active for this project');
    const run = active || await api(`/projects/${item.projectId}/runs`, { prompt });
    report.push({ ...item, runId: run.id });
    fs.writeFileSync(file, JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ projectId: item.projectId, runId: run.id }));
  }
} else if (['repair', 'repair-controls'].includes(process.argv[2])) {
  const projectId = process.argv[3];
  if (!projectId) throw new Error('repair requires a project id');
  const project = await api(`/projects/${projectId}`);
  const prompt = process.argv[2] === 'repair-controls'
    ? 'La prueba real de esta tienda encuentra dos controles decorativos: Buscar coche no filtra y Ver detalles no tiene acción. Lee CarCatalog.tsx y Car.tsx y corrige ambos conservando el catálogo. Añade contador visible de resultados y estado sin resultados; el detalle debe abrir información del coche y poder cerrarse. Conserva marcar/desmarcar favoritos y su persistencia. Prueba con test_preview: buscar Tesla y comprobar 1 resultado, buscar xyz y comprobar sin resultados, limpiar la búsqueda, abrir/cerrar detalles y marcar/desmarcar favorito con recarga. Usa aserciones exactas del texto real. No declares terminado sin probar estos controles. No cambies la configuración de compilación.'
    : 'Completa la petición original de este proyecto. Revisa los errores y los archivos existentes, corrige la compilación y comprueba en el navegador que el catálogo funciona y cada coche permite marcar y desmarcar thumbs up. Todo control visible debe funcionar. Conserva los favoritos al recargar. Publica la preview verificada.';
  const run = await api(`/projects/${projectId}/runs`, { prompt });
  const report = JSON.parse(fs.readFileSync(file, 'utf8'));
  report.push({ name: project.name, projectId, runId: run.id, prompt });
  fs.writeFileSync(file, JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ projectId, runId: run.id }));
} else if (process.argv[2] === 'compat') {
  // Compatibility gate: an unsupported request must finish immediately with
  // zero LLM/token consumption and a friendly message. No agent run is started.
  const project = await api('/projects', { name: `Aceptación · Compatibilidad ${Date.now()}`, description: 'Prueba automática de la puerta de compatibilidad', type: 'static' });
  try {
    const run = await api(`/projects/${project.id}/runs`, { prompt: 'Crea el proyecto con Next.js, Tailwind y PostgreSQL', language: 'es' });
    check('compat: run finishes immediately as done', run.status === 'done', `status=${run.status}`);
    const stats = run.stats || {};
    check('compat: zero LLM calls', stats.llmCalls === 0, `llmCalls=${stats.llmCalls}`);
    check('compat: zero tool calls', stats.toolCalls === 0, `toolCalls=${stats.toolCalls}`);
    check('compat: zero iterations', stats.iterations === 0, `iterations=${stats.iterations}`);
    const messages = await api(`/projects/${project.id}/messages`);
    const assistant = messages.items.find((m) => m.role === 'assistant');
    check('compat: friendly message lists allowed technologies', !!assistant && assistant.content.includes('Tecnologías permitidas actualmente'), assistant ? `${assistant.content.length} chars` : 'no assistant message');
    check('compat: message names the rejected technologies', !!assistant && assistant.content.includes('Next.js') && assistant.content.includes('Tailwind'), 'Next.js + Tailwind mentioned');
  } finally {
    // api() defaults to GET when body is undefined, so DELETE goes through raw fetch.
    const del = await fetch(`${base}/api/projects/${project.id}`, { method: 'DELETE', headers: { Authorization: `Bearer ${process.env.APPFORGE_ADMIN_TOKEN}` } });
    if (!del.ok) throw new Error(`cleanup DELETE failed: HTTP ${del.status}`);
    console.log('compat: temporary project removed');
  }
} else if (process.argv[2] === 'verify') {
  // Deterministic verification of finished generation runs from the report file.
  const report = JSON.parse(fs.readFileSync(file, 'utf8'));
  const latest = [...new Map(report.map((entry) => [entry.projectId, entry])).values()];
  if (latest.length === 0) throw new Error('Report is empty; run `start` first.');
  for (const item of latest) {
    console.log(`--- ${item.name} (${item.projectId})`);
    const run = await api(`/runs/${item.runId}`);
    check('run finished as done', run.status === 'done', `status=${run.status}`);
    check('run has no error', !run.error, run.error || 'ok');
    if (run.status !== 'done') continue;
    const project = await api(`/projects/${item.projectId}`);
    // 1. Generated app uses plain CSS: no Tailwind in its package.json.
    try {
      const pkg = await api(`/projects/${item.projectId}/files/content?path=${encodeURIComponent('package.json')}`);
      const manifest = JSON.parse(pkg.content);
      const deps = { ...(manifest.dependencies || {}), ...(manifest.devDependencies || {}) };
      check('generated package.json has no tailwindcss', !('tailwindcss' in deps));
      check('generated package.json has no @tailwindcss/vite', !('@tailwindcss/vite' in deps));
    } catch (e) {
      check('generated package.json readable and Tailwind-free', false, String(e && e.message || e));
    }
    // 2. Latest build succeeded.
    const builds = await api(`/projects/${item.projectId}/builds`);
    const latestBuild = builds.items[0];
    check('latest build succeeded', !!latestBuild && latestBuild.status === 'success', latestBuild ? `${latestBuild.status}` : 'no builds');
    // 3. Preview is publicly reachable.
    if (project.previewUrl) {
      const preview = await fetch(`${base}${project.previewUrl}`, { redirect: 'manual' });
      check('preview returns HTTP 200', preview.status === 200, `HTTP ${preview.status}`);
    } else {
      check('preview URL published', false, 'previewUrl is null');
    }
    // 4. Library thumbnail exists.
    if (project.thumbnailUrl) {
      const thumb = await fetch(`${base}${project.thumbnailUrl}`, { redirect: 'manual' });
      check('library thumbnail returns HTTP 200', thumb.status === 200, `HTTP ${thumb.status}`);
    } else {
      check('library thumbnail published', false, 'thumbnailUrl is null');
    }
    // 5. The agent really tested in Chromium (test_preview tool call in the event log).
    try {
      const events = await collectRunEvents(item.runId);
      const toolCalls = events.filter((e) => e.kind === 'tool_call').map((e) => e.data && e.data.name).filter(Boolean);
      check('agent ran test_preview in real Chromium', toolCalls.includes('test_preview'), `${toolCalls.length} tool calls recorded`);
    } catch (e) {
      check('run event log readable', false, String(e && e.message || e));
    }
  }
  console.log(process.exitCode ? 'VERIFY: FAILURES PRESENT' : 'VERIFY: ALL CHECKS PASSED');
} else {
  const report = JSON.parse(fs.readFileSync(file, 'utf8'));
  for (const item of new Map(report.map((entry) => [entry.projectId, entry])).values()) {
    const run = await api(`/runs/${item.runId}`);
    const project = await api(`/projects/${item.projectId}`);
    console.log(JSON.stringify({ name: item.name, projectId: item.projectId, runId: item.runId, status: run.status, stats: run.stats, error: run.error, preview: project.previewUrl }));
  }
}
