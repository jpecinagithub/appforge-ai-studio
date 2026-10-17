/**
 * appforge-shared — tipos compartidos del contrato (CONTRACT.md §5).
 * Fuente de verdad: CONTRACT.md. No añadir campos que el contrato no defina
 * en las interfaces de la sección 5; los tipos auxiliares del worker/LLM
 * van al final, claramente separados.
 */

// ---------------------------------------------------------------------------
// §5 — Tipos del contrato
// ---------------------------------------------------------------------------

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
  thumbnailUrl: string | null;
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

export type DeploymentStatus =
  | 'pending'
  | 'building'
  | 'migrating'
  | 'verifying'
  | 'promoting'
  | 'live'
  | 'failed'
  | 'rolled_back'
  | 'cancelled';

export interface DeploymentInfo {
  id: string;
  projectId: string;
  target: string;
  status: DeploymentStatus;
  url: string | null;
  createdAt: string;
  logs: string | null;
  /** Fase 6 (CONTRACT.md §9.21): identificador del candidato derivado internamente. */
  candidateId: string | null;
  /** Fase 6: versión live anterior, cuando existía. */
  previousLiveVersion: string | null;
  /** Fase 6: backup pre-migración asociado, cuando corresponda. */
  backupId: string | null;
  /** Fase 6: cancelación solicitada (persistente). */
  cancelRequested: boolean;
  startedAt: string | null;
  updatedAt: string | null;
  finishedAt: string | null;
  /** Fase 6: error estructurado del despliegue. */
  error: string | null;
}

/** Fase 6: evento append-only del historial exacto de un deployment. */
export interface DeploymentEvent {
  seq: number;
  phase: string;
  event: string;
  status: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  durationMs: number | null;
  output: string | null;
  error: string | null;
  createdAt: string;
}

// ---------------------------------------------------------------------------
// Fase 2 — Tipos dinámicos (CONTRACT.md §9). Sin implementar aún.
// ---------------------------------------------------------------------------

export type MigrationStatus = 'pending' | 'running' | 'success' | 'failed';

export interface MigrationRecord {
  id: string;
  projectId: string;
  version: number;
  name: string;
  status: MigrationStatus;
  startedAt: string;
  finishedAt: string | null;
  durationMs: number | null;
  logs: string;
  error: string | null;
}

export type ProjectRuntimeStatus = 'running' | 'stopped' | 'missing';

export interface ProjectRuntime {
  projectId: string;
  containerName: string;
  liveImage: string;
  previousImage: string | null;
  status: ProjectRuntimeStatus;
  updatedAt: string;
}

export interface AppHealth {
  ok: boolean;
  version: string;
}

export interface AuthUser {
  id: string;
  email: string;
  displayName: string | null;
  createdAt: string;
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

export type LlmProvider = 'groq' | 'openrouter';

export interface Settings {
  provider: LlmProvider;
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

/** Errores API: siempre {"error":{"code","message"}} */
export interface ApiError {
  error: { code: string; message: string };
}

// ---------------------------------------------------------------------------
// Auxiliares del worker (formato OpenAI function calling)
// ---------------------------------------------------------------------------

export interface LlmToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface LlmMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  toolCalls?: LlmToolCall[];
  toolCallId?: string;
  name?: string;
}

export interface LlmUsage {
  promptTokens: number;
  completionTokens: number;
}

export interface LlmResponse {
  content: string | null;
  toolCalls: LlmToolCall[];
  usage: LlmUsage;
}

export interface AgentLimits {
  maxIterations: number;
  maxRepairAttempts: number;
  llmTimeoutMs: number;
  cmdTimeoutMs: number;
  runTimeoutMs: number;
}
