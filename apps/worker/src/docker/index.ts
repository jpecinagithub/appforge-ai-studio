/**
 * Fase 7A — Módulo Docker del Studio (`DockerDeploymentDriver`).
 *
 * Solo este módulo accede a Docker. El LLM nunca recibe acceso directo.
 * Desactivado por defecto: ver `resolveDockerDriverConfig` + `preflightDocker`.
 */
export { DockerCommandRunner, DockerCommandError, minimalDockerEnv } from './commandRunner.js';
export type { DockerRunOptions, DockerRunResult, DockerRunRawResult, DockerCommandRunnerOptions } from './commandRunner.js';
export {
  createSnapshot,
  verifySnapshot,
  fingerprintOfEntries,
  newBackupId,
  isValidBackupId,
  APPFORGE_DOCKERIGNORE,
  SnapshotError,
} from './snapshot.js';
export type { SnapshotManifestEntry, SnapshotResult } from './snapshot.js';
export {
  resourceNames,
  labelArgs,
  assertLabelsMatch,
  assertUuid,
  id8,
  assertFingerprint,
  assertRole,
  listManagedResources,
  inspectResource,
  resourceExists,
  MANAGED_LABEL,
  LABEL_PROJECT,
  LABEL_DEPLOYMENT,
  LABEL_ROLE,
  LABEL_FINGERPRINT,
  ResourceError,
} from './resources.js';
export type { ManagedLabels, ResourceRole, ResourceNames, ListedResource } from './resources.js';
export { hardenedRunArgs, hardenedTempVolumeArgs, assertNoForbiddenFlags, HardeningError } from './hardening.js';
export type { HardenedContainerSpec, HardenedRole } from './hardening.js';
export {
  parseEnvFile,
  writeValidatedEnvFile,
  baseEnvFor,
  ALLOWED_ENV_NAMES,
  assertValidEnvName,
  EnvError,
} from './env.js';
export {
  sha256File,
  quickCheck,
  backupDirFor,
  writeBackupManifest,
  readBackupManifest,
  enforceRetention,
  BackupError,
} from './sqliteBackup.js';
export type { BackupManifest, BackupFileEntry } from './sqliteBackup.js';
export {
  DockerDeploymentDriver,
  DockerDriverError,
  resolveDockerDriverConfig,
  preflightDocker,
  detectDaemonArchitecture,
  normalizeArch,
} from './dockerDriver.js';
export type { DockerDriverConfig, DockerDriverOptions, PreflightResult } from './dockerDriver.js';
export { activateDockerDeployment } from './activation.js';
export type { ActivateDockerOptions, DockerActivation } from './activation.js';
