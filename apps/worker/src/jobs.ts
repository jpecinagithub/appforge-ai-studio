/**
 * Persistent job queue worker (CONTRACT.md §14). Polls the DB every 2s for
 * queued runs, claims them atomically, and executes the agent.
 * Constraints: one active run per project, max 2 concurrent runs globally.
 */

import type Database from 'better-sqlite3';
import { runAgentOnce, type AgentSettings, type RunAgentOptions } from './agent.js';
import { nowIso } from './tools.js';

export interface WorkerOptions {
  dataDir: string;
  pollMs?: number;
  getSettings: () => AgentSettings;
}

export function startWorker(
  db: Database.Database,
  opts: WorkerOptions,
): { stop: () => void; tick: () => Promise<void> } {
  let inflight = 0;
  let stopped = false;

  const tick = async (): Promise<void> => {
    if (stopped) return;
    try {
      const running = (db.prepare("SELECT COUNT(*) AS c FROM runs WHERE status='running'").get() as { c: number }).c;
      if (running + inflight >= 2) return;

      const cand = db.prepare("SELECT id, project_id AS projectId FROM runs WHERE status='queued' ORDER BY created_at LIMIT 1").get() as
        | { id: string; projectId: string }
        | undefined;
      if (!cand) return;

      // One active run per project (the API also enforces this with 409).
      const active = (
        db.prepare("SELECT COUNT(*) AS c FROM runs WHERE project_id=? AND status IN ('queued','running') AND id<>?").get(cand.projectId, cand.id) as { c: number }
      ).c;
      if (active > 0) return;

      // Atomic claim: only one worker can flip queued -> running.
      const claimed = db.prepare("UPDATE runs SET status='running', started_at=? WHERE id=? AND status='queued'").run(nowIso(), cand.id);
      if (claimed.changes === 0) return;

      inflight += 1;
      const runOpts: RunAgentOptions = { dataDir: opts.dataDir, settings: opts.getSettings() };
      runAgentOnce(db, cand.id, runOpts)
        .catch((err: unknown) => {
          try {
            db.prepare("UPDATE runs SET status='error', finished_at=?, error=? WHERE id=? AND status='running'").run(
              nowIso(),
              `worker crash: ${String((err as Error)?.message ?? err)}`.slice(0, 2000),
              cand.id,
            );
          } catch {
            /* DB may be closed during shutdown */
          }
        })
        .finally(() => {
          inflight -= 1;
        });
    } catch (err) {
      console.error('[worker] tick failed:', (err as Error)?.message ?? err);
    }
  };

  void tick();
  const timer = setInterval(() => void tick(), opts.pollMs ?? 2000);
  return {
    stop: () => {
      stopped = true;
      clearInterval(timer);
    },
    tick,
  };
}
