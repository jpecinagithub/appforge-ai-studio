/* oxlint-disable react/only-export-components -- provider and hook intentionally share one module */
import { createContext, useCallback, useContext, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import type { RunStatus } from './api/types';

interface AgentContextValue {
  /** projectId -> estado del run activo (solo queued/running se guardan). */
  activeRuns: Record<string, RunStatus>;
  setRunStatus: (projectId: string, status: RunStatus | null) => void;
  /** true si algún proyecto tiene un run activo. */
  anyWorking: boolean;
}

const AgentContext = createContext<AgentContextValue | null>(null);

export function AgentProvider({ children }: { children: ReactNode }) {
  const [activeRuns, setActiveRuns] = useState<Record<string, RunStatus>>({});

  const setRunStatus = useCallback((projectId: string, status: RunStatus | null) => {
    setActiveRuns((prev) => {
      if (status === 'queued' || status === 'running') {
        return prev[projectId] === status ? prev : { ...prev, [projectId]: status };
      }
      if (!(projectId in prev)) return prev;
      const next = { ...prev };
      delete next[projectId];
      return next;
    });
  }, []);

  const anyWorking = useMemo(() => Object.keys(activeRuns).length > 0, [activeRuns]);

  const value = useMemo(() => ({ activeRuns, setRunStatus, anyWorking }), [activeRuns, setRunStatus, anyWorking]);
  return <AgentContext.Provider value={value}>{children}</AgentContext.Provider>;
}

export function useAgent(): AgentContextValue {
  const ctx = useContext(AgentContext);
  if (!ctx) throw new Error('useAgent must be used inside AgentProvider');
  return ctx;
}
