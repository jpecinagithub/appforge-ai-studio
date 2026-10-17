/**
 * Fase 7A — Test estático de seguridad Docker (§15, §17 NO-GO).
 *
 * Prohíbe en el código del driver y plantillas:
 * - `shell: true` (todo es ejecutable + argv);
 * - `--privileged` como argumento;
 * - puertos publicados (`-p`/`--publish` como argumentos);
 * - montaje del socket Docker en plantillas/proyectos y en el compose
 *   productivo (el socket solo se montará en 7C, de forma auditada);
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

describe('plantillas y compose: sin socket Docker', () => {
  test('la plantilla no monta el socket', () => {
    const tpl = path.join(REPO, 'templates', 'dynamic-react-node');
    const bad = walkAll(tpl).filter((f) => fs.readFileSync(f, 'utf8').includes('/var/run/docker.sock'));
    expect(bad).toEqual([]);
  });
  test('el compose productivo no monta el socket (7A)', () => {
    const compose = path.join(REPO, 'infra', 'docker-compose.yml');
    if (!fs.existsSync(compose)) return;
    expect(fs.readFileSync(compose, 'utf8')).not.toContain('/var/run/docker.sock');
  });
});
