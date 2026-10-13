/** Live acceptance cases, using the same authenticated API as Studio.
 * Run inside the AppForge container: node /tmp/acceptance.mjs start|status
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
    const run = await api(`/projects/${item.projectId}/runs`, { prompt: item.prompt + visual });
    report.push({ ...item, runId: run.id });
    fs.writeFileSync(file, JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ projectId: item.projectId, runId: run.id }));
  }
} else if (process.argv[2] === 'repair') {
  const projectId = process.argv[3];
  if (!projectId) throw new Error('repair requires a project id');
  const project = await api(`/projects/${projectId}`);
  const prompt = 'Completa la petición original de este proyecto. Revisa los errores y los archivos existentes, corrige la compilación y comprueba en el navegador que el catálogo funciona y cada coche permite marcar y desmarcar thumbs up. Todo control visible debe funcionar. Conserva los favoritos al recargar. Publica la preview verificada.';
  const run = await api(`/projects/${projectId}/runs`, { prompt });
  const report = JSON.parse(fs.readFileSync(file, 'utf8'));
  report.push({ name: project.name, projectId, runId: run.id, prompt });
  fs.writeFileSync(file, JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ projectId, runId: run.id }));
} else {
  const report = JSON.parse(fs.readFileSync(file, 'utf8'));
  for (const item of report) {
    const run = await api(`/runs/${item.runId}`);
    const project = await api(`/projects/${item.projectId}`);
    console.log(JSON.stringify({ name: item.name, projectId: item.projectId, runId: item.runId, status: run.status, stats: run.stats, error: run.error, preview: project.previewUrl }));
  }
}
