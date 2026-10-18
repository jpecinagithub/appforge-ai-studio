/**
 * Persistent job queue worker (CONTRACT.md §14). Polls the DB every 2s for
 * queued runs, claims them atomically, and executes the agent.
 * Constraints: one active run per project, max 2 concurrent runs globally.
 */

import type Database from 'better-sqlite3';
import type { DeploymentDriver } from './deploy/driver.js';
import { runAgentOnce, type AgentSettings, type RunAgentOptions } from './agent.js';
import { nowIso } from './tools.js';

export interface WorkerOptions {
  dataDir: string;
  pollMs?: number;
  getSettings: () => AgentSettings;
  /** Fase 6: explicitly-configured deployment driver (never a default). */
  deploymentDriver?: DeploymentDriver;
}

export interface WorkerController {
  /** Prevents new jobs from being claimed. It does not interrupt owned work. */
  stop: () => void;
  /** Waits for work owned by this process, bounded by the caller's budget. */
  drain: (timeoutMs: number) => Promise<boolean>;
  tick: () => Promise<void>;
}

/**
 * Wait for the current snapshot of a task set. Callers must stop producers
 * before invoking this helper. A false result means recovery is delegated to
 * the persistent restart reconciliation, not that the tasks were cancelled.
 */
export async function waitForTaskSet(tasks: ReadonlySet<Promise<unknown>>, timeoutMs: number): Promise<boolean> {
  if (tasks.size === 0) return true;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return false;

  let timer: NodeJS.Timeout | undefined;
  const timedOut = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), timeoutMs);
    timer.unref?.();
  });
  const settled = Promise.allSettled([...tasks]).then(() => true as const);
  const result = await Promise.race([settled, timedOut]);
  if (timer) clearTimeout(timer);
  return result && tasks.size === 0;
}

export function startWorker(
  db: Database.Database,
  opts: WorkerOptions,
): WorkerController {
  let inflight = 0;
  let stopped = false;
  const tasks = new Set<Promise<void>>();

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
      const runOpts: RunAgentOptions = { dataDir: opts.dataDir, settings: opts.getSettings(), deploymentDriver: opts.deploymentDriver };
      const task = runAgentOnce(db, cand.id, runOpts)
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
          tasks.delete(task);
        });
      tasks.add(task);
      void task;
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
    drain: (timeoutMs) => waitForTaskSet(tasks, timeoutMs),
    tick,
  };
}
