/**
 * appforge-worker public surface (imported by apps/server).
 */
export { chatLlm, StubLlm, isStubMode, LlmError } from './llm.js';
export type { LlmConfig, ToolDef } from './llm.js';
export { createTools, TOOL_DEFS, resolveIn, runCmd, nowIso } from './tools.js';
export type { ToolContext, ToolHandler } from './tools.js';
export {
  createDynamicTools,
  DYNAMIC_TOOL_DEFS,
  DYNAMIC_CHECK_ORDER,
  ensureMigrationsTable,
  sanitizeSecrets,
  buildChildEnv,
  runLive,
  invalidateDynamicChecks,
  dynamicGateStatus,
} from './dynamicTools.js';
export type { DynamicCheckKey, ProcResult } from './dynamicTools.js';
export { runAgentOnce } from './agent.js';
export type { AgentSettings, RunAgentOptions } from './agent.js';
export { startWorker } from './jobs.js';
export type { WorkerOptions } from './jobs.js';
export { requestCancel, clearCancel, isCancelRequested } from './cancel.js';
export { checkBrowser, checkBrowserAtUrl } from './browser.js';
export type { BrowserSession, BrowserStep } from './browser.js';
export {
  ensurePreviewsTable,
  getPreview,
  stopPreview,
  reconcilePreviews,
  failPreview,
  previewCookieName,
} from './previewManager.js';
export type { PreviewStatus, PreviewRow } from './previewManager.js';
export { resolveAreaPath, AREA_NAMES } from './dynamicAreas.js';
export type { DynamicArea } from './dynamicAreas.js';
export {
  DeploymentError,
  createDeployment,
  getDeployment,
  getActiveDeployment,
  listDeployments,
  listDeploymentEvents,
  transitionDeployment,
  recordEvent,
  requestDeploymentCancel,
  isCancelRequested,
  getProjectRuntime,
  upsertProjectRuntime,
  reconcileDeployments,
  isDeploymentStatus,
  isTerminalStatus,
  NON_TERMINAL_STATUSES,
  TERMINAL_STATUSES,
  MAX_EVENT_OUTPUT_CHARS,
  MAX_DEPLOYMENT_LOGS_CHARS,
} from './deploy/stateMachine.js';
export type { DeploymentRecord, DeploymentEvent, DeploymentEventInput, ProjectRuntimeRecord } from './deploy/stateMachine.js';
export { FakeDeploymentDriver, assertDriverArgs, FAKE_OP_NAMES } from './deploy/driver.js';
export type {
  DeploymentDriver,
  DriverOpArgs,
  DriverResult,
  FakeCall,
  FakeDriverOptions,
  FakeOpBehavior,
  FakeOpName,
} from './deploy/driver.js';
export { runDeploymentPipeline, persistedVerificationGate, SUPPORTED_DEPLOY_TARGETS } from './deploy/orchestrator.js';
export type { RunDeploymentOptions, VerificationGateResult } from './deploy/orchestrator.js';
export { sanitizeSecrets } from './secrets.js';
