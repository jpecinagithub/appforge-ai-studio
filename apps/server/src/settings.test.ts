/**
 * Fase 1 (agent hardening): the new loop limits are real settings —
 * defaults exist for fresh installs, stored values win, and they reach
 * the worker through getAgentSettings.
 */
import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { ensureSettingsRow, getAgentSettings } from './index.js';

function makeDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec('CREATE TABLE settings(id INTEGER PRIMARY KEY CHECK(id=1), data_json TEXT)');
  return db;
}

describe('Fase 1 agent limit settings', () => {
  it('defaults: hard cap 60 iterations, 12 failed repair verifications', () => {
    const db = makeDb();
    const s = ensureSettingsRow(db);
    expect(s.maxHardIterations).toBe(60);
    expect(s.maxRepairAttempts).toBe(12);
    const agent = getAgentSettings(db);
    expect(agent.maxHardIterations).toBe(60);
    expect(agent.maxRepairAttempts).toBe(12);
    db.close();
  });

  it('stored values override the defaults and reach the agent settings', () => {
    const db = makeDb();
    const s = ensureSettingsRow(db);
    db.prepare('UPDATE settings SET data_json=? WHERE id=1').run(
      JSON.stringify({ ...s, maxHardIterations: 25, maxRepairAttempts: 4 }),
    );
    const agent = getAgentSettings(db);
    expect(agent.maxHardIterations).toBe(25);
    expect(agent.maxRepairAttempts).toBe(4);
    db.close();
  });

  it('settings stored before Fase 1 (without the new fields) fall back to the defaults', () => {
    const db = makeDb();
    const s = ensureSettingsRow(db);
    const legacy = { ...s } as Record<string, unknown>;
    delete legacy.maxHardIterations;
    delete legacy.maxRepairAttempts;
    db.prepare('UPDATE settings SET data_json=? WHERE id=1').run(JSON.stringify(legacy));
    const merged = ensureSettingsRow(db);
    expect(merged.maxHardIterations).toBe(60);
    expect(merged.maxRepairAttempts).toBe(12);
    db.close();
  });
});
