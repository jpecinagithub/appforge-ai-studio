/**
 * In-memory cancellation flags for runs. The agent loop consults these
 * (plus the DB status) between iterations so a cancel request takes effect
 * promptly even while a long tool call is running.
 */

const cancelled = new Set<string>();

export function requestCancel(runId: string): void {
  cancelled.add(runId);
}

export function clearCancel(runId: string): void {
  cancelled.delete(runId);
}

export function isCancelRequested(runId: string): boolean {
  return cancelled.has(runId);
}
