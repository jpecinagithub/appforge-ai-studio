import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb } from '../../../server/src/db.js';
import { activateDockerDeployment } from './activation.js';
import { DockerCommandRunner } from './commandRunner.js';

describe('Fase 7B Docker activation', () => {
  it('is disabled without the complete kill switches and creates no driver', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'af-7b-off-'));
    const db = openDb(dir);
    try {
      const result = await activateDockerDeployment({ env: {}, dataDir: dir, templatesDir: dir, db });
      expect(result.status).toBe('disabled');
      expect(result.driver).toBeNull();
    } finally {
      db.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('fails closed as unavailable when preflight cannot certify the host', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'af-7b-unavailable-'));
    const db = openDb(dir);
    try {
      const result = await activateDockerDeployment({
        env: {
          APPFORGE_DEPLOY_DRIVER: 'docker',
          APPFORGE_ENABLE_DOCKER_DEPLOY: '1',
          APPFORGE_DOCKER_NETWORK: 'appforge-apps',
          APPFORGE_DOCKER_DATA_VOLUME: 'appforge-data',
        },
        dataDir: dir,
        templatesDir: dir,
        db,
        runner: new DockerCommandRunner({ dockerBin: 'not-invoked' }),
        preflight: async () => ({ ok: false, diagnostics: ['socket unavailable'] }),
      });
      expect(result.status).toBe('unavailable');
      expect(result.driver).toBeNull();
      expect(result.diagnostics).toEqual(['socket unavailable']);
    } finally {
      db.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('creates exactly one ready driver only after a successful preflight', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'af-7b-ready-'));
    const db = openDb(dir);
    try {
      const result = await activateDockerDeployment({
        env: {
          APPFORGE_DEPLOY_DRIVER: 'docker',
          APPFORGE_ENABLE_DOCKER_DEPLOY: '1',
          APPFORGE_DOCKER_NETWORK: 'appforge-apps',
          APPFORGE_DOCKER_DATA_VOLUME: 'appforge-data',
          APPFORGE_MAX_CONCURRENT_DEPLOYS: '2',
        },
        dataDir: dir,
        templatesDir: dir,
        db,
        runner: new DockerCommandRunner({ dockerBin: 'not-invoked' }),
        preflight: async () => ({ ok: true, diagnostics: ['certified'] }),
      });
      expect(result.status).toBe('ready');
      expect(result.driver?.name).toBe('docker');
      expect(result.driver?.maxConcurrentDeploys).toBe(2);
    } finally {
      db.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
