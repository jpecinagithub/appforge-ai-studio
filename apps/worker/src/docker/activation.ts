/** Fase 7B: única factoría fail-closed para activar el driver Docker. */
import type Database from 'better-sqlite3';
import { sanitizeSecrets } from '../secrets.js';
import { DockerCommandRunner } from './commandRunner.js';
import {
  DockerDeploymentDriver,
  preflightDocker,
  resolveDockerDriverConfig,
  type DockerDriverConfig,
} from './dockerDriver.js';

export type DockerActivation =
  | { status: 'disabled'; driver: null; diagnostics: string[] }
  | { status: 'unavailable'; driver: null; diagnostics: string[] }
  | { status: 'ready'; driver: DockerDeploymentDriver; diagnostics: string[]; config: DockerDriverConfig };

export interface ActivateDockerOptions {
  env: NodeJS.ProcessEnv;
  dataDir: string;
  templatesDir: string;
  db: Database.Database;
  /** Inyección exclusiva para pruebas; producción usa el runner auditado. */
  runner?: DockerCommandRunner;
  /** Inyección exclusiva para pruebas: evita tocar un daemon real. */
  preflight?: typeof preflightDocker;
}

const clean = (items: string[]): string[] =>
  items.map((item) => sanitizeSecrets(item).replace(/[\r\n]+/g, ' ').slice(0, 500));

export async function activateDockerDeployment(opts: ActivateDockerOptions): Promise<DockerActivation> {
  const config = resolveDockerDriverConfig(
    { ...opts.env, APPFORGE_TEMPLATES_DIR: opts.env.APPFORGE_TEMPLATES_DIR || opts.templatesDir },
    opts.dataDir,
  );
  if (!config) {
    return { status: 'disabled', driver: null, diagnostics: ['Docker deployment is disabled or incompletely configured'] };
  }
  const runner = opts.runner ?? new DockerCommandRunner({ dockerBin: config.dockerBin });
  try {
    const preflight = await (opts.preflight ?? preflightDocker)(runner, config);
    if (!preflight.ok) {
      return { status: 'unavailable', driver: null, diagnostics: clean(preflight.diagnostics) };
    }
    return {
      status: 'ready',
      driver: new DockerDeploymentDriver(config, { db: opts.db, runner }),
      diagnostics: clean(preflight.diagnostics),
      config,
    };
  } catch (error) {
    return {
      status: 'unavailable',
      driver: null,
      diagnostics: clean([`Docker preflight failed: ${(error as Error).message}`]),
    };
  }
}
