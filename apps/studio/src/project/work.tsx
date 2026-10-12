import { createContext, useContext } from 'react';
import type { StreamEvent } from '../api/sse';
import type { ChatMessage, Project, Run } from '../api/types';

export type WorkspaceTab = 'preview' | 'builds' | 'code' | 'console';

/**
 * Estado compartido de la vista de proyecto: lo produce ProjectView
 * y lo consumen Chat y Workspace.
 */
export interface ProjectWork {
  project: Project;
  messages: ChatMessage[];
  reloadMessages: () => Promise<void>;
  /** Run en curso (queued/running) o el último run terminado conocido. */
  activeRun: Run | null;
  /** Eventos SSE del run en curso (más recientes al final). */
  events: StreamEvent[];
  /** Envía un prompt: crea el mensaje + lanza el run + suscribe el SSE. Lanza ApiError si falla. */
  sendPrompt: (prompt: string) => Promise<void>;
  cancelRun: () => Promise<void>;
  sending: boolean;
  /** Borrador del input del chat (p. ej. "Pedir cambio con IA" lo rellena). */
  chatDraft: string;
  setChatDraft: (d: string) => void;
  /** Claves para forzar recarga de Builds / Preview tras un run. */
  buildsKey: number;
  previewKey: number;
  notifyBuildsChanged: () => void;
  notifyPreviewChanged: () => void;
  workspaceTab: WorkspaceTab;
  setWorkspaceTab: (t: WorkspaceTab) => void;
}

const ProjectWorkContext = createContext<ProjectWork | null>(null);

export const ProjectWorkProvider = ProjectWorkContext.Provider;

export function useProjectWork(): ProjectWork {
  const ctx = useContext(ProjectWorkContext);
  if (!ctx) throw new Error('useProjectWork must be used inside ProjectView');
  return ctx;
}
