/** Live acceptance cases, using the same authenticated API as Studio.
 * Run inside the AppForge container: node /tmp/acceptance.mjs start|status
 * Credentials are read from its environment, never written to the report.
 */
import fs from 'node:fs';
const base = process.env.APPFORGE_ACCEPTANCE_URL || 'http://127.0.0.1:3001';
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
} else {
  const report = JSON.parse(fs.readFileSync(file, 'utf8'));
  for (const item of report) {
    const run = await api(`/runs/${item.runId}`);
    const project = await api(`/projects/${item.projectId}`);
    console.log(JSON.stringify({ name: item.name, projectId: item.projectId, runId: item.runId, status: run.status, stats: run.stats, error: run.error, preview: project.previewUrl }));
  }
}
