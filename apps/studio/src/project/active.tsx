/* oxlint-disable react/only-export-components -- provider and hook intentionally share one module */
import { createContext, useContext, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import type { Project } from '../api/types';

interface ActiveProjectValue {
  project: Project | null;
  setProject: (p: Project | null) => void;
}

const ActiveProjectContext = createContext<ActiveProjectValue | null>(null);

export function ActiveProjectProvider({ children }: { children: ReactNode }) {
  const [project, setProject] = useState<Project | null>(null);
  const value = useMemo(() => ({ project, setProject }), [project]);
  return <ActiveProjectContext.Provider value={value}>{children}</ActiveProjectContext.Provider>;
}

export function useActiveProject(): ActiveProjectValue {
  const ctx = useContext(ActiveProjectContext);
  if (!ctx) throw new Error('useActiveProject must be used inside ActiveProjectProvider');
  return ctx;
}
