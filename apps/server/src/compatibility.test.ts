import { describe, expect, it } from 'vitest';
import { assessTechnologyCompatibility, SUPPORTED_TECHNOLOGIES } from './compatibility.js';

describe('technology compatibility', () => {
  it('accepts the supported AppForge stack', () => {
    const result = assessTechnologyCompatibility(
      'Crea un catálogo responsive con React, TypeScript, CSS normal y favoritos en localStorage',
    );

    expect(result).toEqual({ compatible: true, incompatible: [], message: null });
  });

  it('reports every incompatible technology without presenting a technical error', () => {
    const result = assessTechnologyCompatibility(
      'Quiero Next.js con Tailwind, autenticación real y PostgreSQL',
    );

    expect(result.compatible).toBe(false);
    expect(result.incompatible).toEqual(['Next.js', 'Tailwind CSS', 'Base de datos', 'Autenticación real']);
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

  it('blocks unsupported backend capabilities even when no framework is named', () => {
    const result = assessTechnologyCompatibility(
      'Necesito un backend con API REST, autenticación y base de datos',
    );

    expect(result.incompatible).toEqual([
      'Backend / API de servidor',
      'Base de datos',
      'Autenticación real',
    ]);
  });
});
