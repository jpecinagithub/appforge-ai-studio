import { describe, expect, it } from 'vitest';
import { waitForTaskSet } from './jobs.js';

describe('worker shutdown drain', () => {
  it('reports a clean drain after owned work settles', async () => {
    const tasks = new Set<Promise<unknown>>();
    let release!: () => void;
    const task = new Promise<void>((resolve) => { release = resolve; });
    const tracked = task.finally(() => tasks.delete(tracked));
    tasks.add(tracked);
    setTimeout(release, 5);

    await expect(waitForTaskSet(tasks, 500)).resolves.toBe(true);
    expect(tasks.size).toBe(0);
  });

  it('returns false at the budget without cancelling owned work', async () => {
    const tasks = new Set<Promise<unknown>>();
    let release!: () => void;
    const task = new Promise<void>((resolve) => { release = resolve; });
    const tracked = task.finally(() => tasks.delete(tracked));
    tasks.add(tracked);

    await expect(waitForTaskSet(tasks, 5)).resolves.toBe(false);
    expect(tasks.size).toBe(1);
    release();
    await tracked;
  });
});
