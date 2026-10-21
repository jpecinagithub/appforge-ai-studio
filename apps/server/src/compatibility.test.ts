import { describe, expect, it } from 'vitest';
import { assessTechnologyCompatibility, inferProjectType, SUPPORTED_TECHNOLOGIES } from './compatibility.js';

it.each([
  ['Tienda FULL-STACK con SQLite y cookies HttpOnly', 'dynamic'],
  ['Catálogo con backend Node.js', 'dynamic'],
  ['Landing responsive con React', 'static'],
  ['Catálogo sin backend y sin SQLite, solo localStorage', 'static'],
])('infers project type for %s', (prompt, type) => expect(inferProjectType(prompt)).toBe(type));

describe('technology compatibility', () => {
  it('accepts the supported AppForge stack', () => {
    const result = assessTechnologyCompatibility(
      'Crea un catálogo responsive con React, TypeScript, CSS normal y favoritos en localStorage',
    );

    expect(result).toEqual({ compatible: true, incompatible: [], message: null });
  });

  it('reports every incompatible technology without presenting a technical error', () => {
    const result = assessTechnologyCompatibility(
      'Quiero Next.js con Tailwind y PostgreSQL',
    );

    expect(result.compatible).toBe(false);
    expect(result.incompatible).toEqual(['Next.js', 'Tailwind CSS', 'Base de datos externa']);
    expect(result.message).toContain('Tecnologías o capacidades incompatibles detectadas:');
    expect(result.message).toContain('No se ha iniciado el agente ni ningún build');
    for (const technology of SUPPORTED_TECHNOLOGIES) expect(result.message).toContain(`- ${technology}`);
  });

  it('does not reject technologies the client explicitly excludes', () => {
    const result = assessTechnologyCompatibility(
      'Crea la aplicación con React y CSS normal, sin Tailwind y no uses Next.js',
    );

    expect(result.compatible).toBe(true);
  });

  it('can produce the compatibility notice in English', () => {
    const result = assessTechnologyCompatibility('Build it with Vue and Firebase', 'en');

    expect(result.incompatible).toEqual(['Vue / Nuxt', 'Supabase / Firebase']);
    expect(result.message).toContain('Technologies currently supported:');
  });

  it('accepts the dynamic pilot stack (gate opened 2026-10-16)', () => {
    const result = assessTechnologyCompatibility(
      'Necesito una app de tareas con backend, API REST, autenticación con login y base de datos SQLite',
    );

    expect(result).toEqual({ compatible: true, incompatible: [], message: null });
  });

  it('still blocks backends, databases and auth outside the fixed template', () => {
    const result = assessTechnologyCompatibility(
      'Necesito un backend con Express, OAuth con Google y PostgreSQL',
    );

    expect(result.incompatible).toEqual([
      'Backend Express / NestJS',
      'Base de datos externa',
      'OAuth / login social',
    ]);
  });
});
