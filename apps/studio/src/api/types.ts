// Tipos compartidos — espejo de CONTRACT.md §5 (packages/shared).
// El frontend los define localmente para seguir siendo un proyecto Vite independiente.

export interface Project {
  id: string;
  name: string;
  description: string;
  type: 'static' | 'dynamic';
  status: string;
  model: string | null;
  createdAt: string;
  updatedAt: string;
  previewUrl: string | null;
  productionUrl: string | null;
  config: Record<string, unknown>;
}

export interface ChatMessage {
  id: string;
  projectId: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  createdAt: string;
  tokens: number | null;
}

export type RunStatus = 'queued' | 'running' | 'done' | 'error' | 'cancelled';

export interface Run {
  id: string;
  projectId: string;
  prompt: string;
  status: RunStatus;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  stats: RunStats | null;
  error: string | null;
}

export interface RunStats {
  iterations: number;
  llmCalls: number;
  llmMs: number;
  buildMs: number;
  tokensIn: number;
  tokensOut: number;
  toolCalls: number;
  errors: number;
}

export type RunEventKind = 'status' | 'log' | 'tool_call' | 'tool_result' | 'done' | 'error';

export interface RunEvent {
  seq: number;
  kind: RunEventKind;
  data: unknown;
  createdAt: string;
}

export type BuildStatus = 'pending' | 'running' | 'success' | 'failed' | 'cancelled';

export interface BuildRecord {
  id: string;
  projectId: string;
  status: BuildStatus;
  startedAt: string;
  finishedAt: string | null;
  durationMs: number | null;
  logs: string;
  artifacts: { distSize: number } | null;
  error: string | null;
}

export interface RevisionInfo {
  id: string;
  projectId: string;
  label: string;
  gitSha: string;
  createdAt: string;
}

export interface DeploymentInfo {
  id: string;
  projectId: string;
  target: string;
  status: string;
  url: string | null;
  createdAt: string;
  logs: string | null;
}

export interface FileNode {
  name: string;
  path: string;
  type: 'file' | 'dir';
  children?: FileNode[];
}

export interface ToolResult {
  ok: boolean;
  data?: unknown;
  error?: string;
  code?: string;
  durationMs: number;
  output?: string;
}

export interface Settings {
  provider: 'groq' | 'openrouter';
  model: string;
  temperature: number;
  maxTokens: number;
  maxIterations: number;
  llmTimeoutMs: number;
  cmdTimeoutMs: number;
  runTimeoutMs: number;
  language: 'es' | 'en';
  theme: 'dark' | 'light';
  autoRevision: boolean;
  autoBuild: boolean;
  secrets: {
    groq: { configured: boolean };
    openrouter: { configured: boolean };
    vercel: { configured: boolean };
  };
}

export interface Page<T> {
  items: T[];
  total: number;
}

export interface PreviewInfo {
  url: string;
  status: 'ready' | 'building' | 'none';
}
