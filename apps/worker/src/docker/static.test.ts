/**
 * Fase 7A — Test estático de seguridad Docker (§15, §17 NO-GO).
 *
 * Prohíbe en el código del driver y plantillas:
 * - `shell: true` (todo es ejecutable + argv);
 * - `--privileged` como argumento;
 * - puertos publicados (`-p`/`--publish` como argumentos);
 * - montaje del socket Docker en plantillas/proyectos;
 * - en 7C, más de un montaje o un montaje fuera del servicio Studio;
 * - subcomando `prune` (borrados globales prohibidos).
 */
import { describe, test, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..', '..', '..');
const DOCKER_DIR = HERE;

function walkTs(dir: string): string[] {
  const out: string[] = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walkTs(p));
    else if (e.name.endsWith('.ts') && !e.name.endsWith('.test.ts')) out.push(p);
  }
  return out;
}

function walkAll(dir: string): string[] {
  const out: string[] = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === 'node_modules' || e.name === '.git') continue;
      out.push(...walkAll(p));
    } else out.push(p);
  }
  return out;
}

describe('driver: sin shell ni privilegios', () => {
  const files = walkTs(DOCKER_DIR);
  test('ningún shell:true', () => {
    const bad = files.filter((f) => /shell\s*:\s*true/.test(fs.readFileSync(f, 'utf8')));
    expect(bad).toEqual([]);
  });
  test('ningún --privileged como argumento', () => {
    // Se ignoran las entradas de la tabla FORBIDDEN_PATTERNS del validador
    // (tienen forma `[/regex/, 'flag'],`).
    const bad = files.filter((f) =>
      fs
        .readFileSync(f, 'utf8')
        .split('\n')
        .some((l) => !/^\s*\[/.test(l) && /['"]--privileged['"]/.test(l)),
    );
    expect(bad).toEqual([]);
  });
  test('ningún puerto publicado como argumento', () => {
    const bad = files.filter((f) => {
      const c = fs.readFileSync(f, 'utf8');
      return /['"]--publish['"]/.test(c) || /['"]-p['"](?![\w/])/.test(c);
    });
    expect(bad).toEqual([]);
  });
  test('ningún subcomando prune', () => {
    const bad = files.filter((f) => /['"]prune['"]/.test(fs.readFileSync(f, 'utf8')));
    expect(bad).toEqual([]);
  });
  test('ningún --cap-add (solo --cap-drop=ALL)', () => {
    // Se ignoran las entradas de la tabla FORBIDDEN_PATTERNS del validador
    // (tienen forma `[/regex/, 'flag'],`).
    const bad = files.filter((f) =>
      fs
        .readFileSync(f, 'utf8')
        .split('\n')
        .some((l) => !/^\s*\[/.test(l) && /['"]--cap-add['"]/.test(l)),
    );
    expect(bad).toEqual([]);
  });
});

describe('plantillas y compose: socket Docker limitado al orquestador', () => {
  test('la plantilla no monta el socket', () => {
    const tpl = path.join(REPO, 'templates', 'dynamic-react-node');
    const bad = walkAll(tpl).filter((f) => fs.readFileSync(f, 'utf8').includes('/var/run/docker.sock'));
    expect(bad).toEqual([]);
  });
  test('el compose 7C lo monta exactamente una vez y solo en studio', () => {
    const compose = path.join(REPO, 'infra', 'docker-compose.yml');
    if (!fs.existsSync(compose)) return;
    const text = fs.readFileSync(compose, 'utf8');
    const mounts = text.match(/\/var\/run\/docker\.sock:\/var\/run\/docker\.sock:rw/g) ?? [];
    expect(mounts).toHaveLength(1);
    const studio = text.match(/\n  studio:\n([\s\S]*?)\n  caddy:/)?.[1] ?? '';
    expect(studio).toContain('/var/run/docker.sock:/var/run/docker.sock:rw');
    expect(studio).toContain('stop_grace_period: 40s');
  });
});

describe('instalación productiva 7C', () => {
  const install = fs.readFileSync(path.join(REPO, 'infra', 'scripts', 'install.sh'), 'utf8');
  const preflight = fs.readFileSync(path.join(REPO, 'infra', 'scripts', 'preflight.sh'), 'utf8');

  test('usa el repositorio correcto y exige una revisión inmutable', () => {
    expect(install).toContain('jpecinagithub/appforge-ai-studio.git');
    expect(install).toContain('APPFORGE_REF');
    expect(install).toContain('checkout --detach');
    expect(install).not.toContain('git -C "$APP_DIR" pull');
  });

  test('protege el env y nunca lo carga como código shell', () => {
    expect(install).toContain('chmod 600 "$env_file"');
    expect(preflight).toContain("[ \"$mode\" = 600 ]");
    expect(preflight).not.toMatch(/(?:^|\n)\s*(?:source|\.)\s+[^\n]*\.env/);
    expect(preflight).not.toContain('cat "$ENV_FILE"');
  });

  test('coordina un presupuesto de drenaje menor que la gracia del contenedor', () => {
    const compose = fs.readFileSync(path.join(REPO, 'infra', 'docker-compose.yml'), 'utf8');
    const example = fs.readFileSync(path.join(REPO, '.env.example'), 'utf8');
    expect(example).toContain('APPFORGE_SHUTDOWN_TIMEOUT_MS=30000');
    expect(preflight).toContain('APPFORGE_SHUTDOWN_TIMEOUT_MS must be between 1000 and 300000');
    expect(compose).toContain('stop_grace_period: 40s');
  });
});
