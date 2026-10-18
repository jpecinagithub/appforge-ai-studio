import { useCallback, useEffect, useMemo, useState } from 'react';
import { Archive, Database, ExternalLink, RefreshCw, Rocket, RotateCcw, Square } from 'lucide-react';
import { ApiError, api, isDemoMode, publicAppUrlFor } from '../api/client';
import type {
  AdministrativeOperationInfo,
  DeploymentDriverStatus,
  DeploymentInfo,
  MigrationInfo,
  ProjectRuntimeInfo,
} from '../api/types';
import { useT } from '../i18n';
import { useProjectWork } from '../project/work';
import { formatDateTime } from '../utils/format';
import { Badge, Btn, Empty, ErrorBox, Spinner } from './ui';

const terminal = new Set(['live', 'failed', 'rolled_back', 'cancelled']);

function tone(status: string): 'green' | 'red' | 'amber' | 'blue' | 'zinc' {
  if (status === 'live' || status === 'succeeded' || status === 'success' || status === 'running') return 'green';
  if (status === 'failed') return 'red';
  if (status === 'cancelled' || status === 'rolled_back') return 'zinc';
  if (status === 'promoting' || status === 'verifying') return 'amber';
  return 'blue';
}

function resultDiagnostic(result: unknown): string | null {
  if (!result || typeof result !== 'object') return null;
  const error = (result as { error?: { message?: unknown } }).error;
  return typeof error?.message === 'string' ? error.message : null;
}

export function OperationsPane() {
  const { project } = useProjectWork();
  const { lang } = useT();
  const es = lang === 'es';
  const [driver, setDriver] = useState<DeploymentDriverStatus | null>(null);
  const [runtime, setRuntime] = useState<ProjectRuntimeInfo | null>(null);
  const [deployments, setDeployments] = useState<DeploymentInfo[]>([]);
  const [operations, setOperations] = useState<AdministrativeOperationInfo[]>([]);
  const [migrations, setMigrations] = useState<MigrationInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const demo = isDemoMode();

  const load = useCallback(async () => {
    if (demo) {
      setLoading(false);
      return;
    }
    setError(null);
    try {
      const [driverResult, deploymentResult, operationResult, migrationResult, runtimeResult] = await Promise.all([
        api.getDeploymentDriverStatus(),
        api.listDeployments(project.id),
        api.listAdministrativeOperations(project.id),
        api.listMigrations(project.id),
        api.getProjectRuntime(project.id).catch((e) => {
          if (e instanceof ApiError && e.status === 404) return null;
          throw e;
        }),
      ]);
      setDriver(driverResult);
      setDeployments(deploymentResult.items);
      setOperations(operationResult.items);
      setMigrations(migrationResult.items);
      setRuntime(runtimeResult);
    } catch (e) {
      setError(e);
    } finally {
      setLoading(false);
    }
  }, [demo, project.id]);

  useEffect(() => { void load(); }, [load]);

  const activeDeployment = useMemo(
    () => deployments.find((item) => !terminal.has(item.status)) ?? null,
    [deployments],
  );
  const activeOperation = operations.find((item) => item.status === 'running') ?? null;
  const driverAvailable = driver?.configured === true && (driver.available === null || driver.available > 0);
  const mutable = project.type === 'dynamic' && driverAvailable && !activeDeployment && !activeOperation && !busy;
  const canRollback = mutable && deployments.some(
    (item) => item.status === 'live' && item.previousLiveVersion && item.backupId,
  );

  useEffect(() => {
    if (!activeDeployment && !activeOperation) return;
    const timer = window.setInterval(() => void load(), 2000);
    return () => window.clearInterval(timer);
  }, [activeDeployment, activeOperation, load]);

  const act = async (name: string, action: () => Promise<unknown>) => {
    setBusy(name);
    setError(null);
    try {
      await action();
      await load();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(null);
    }
  };

  if (loading) return <div className="flex h-full items-center justify-center"><Spinner /></div>;
  if (demo) {
    return (
      <div className="p-6">
        <Empty
          icon={<Rocket size={32} />}
          title={es ? 'Operaciones no disponibles en la demo' : 'Operations are unavailable in demo mode'}
          hint={es ? 'Conecta el Studio a un servidor AppForge para administrar despliegues.' : 'Connect Studio to an AppForge server to manage deployments.'}
        />
      </div>
    );
  }

  return (
    <div className="h-full overflow-y-auto p-4">
      <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-base font-semibold text-zinc-900 dark:text-zinc-50">
            {es ? 'Operaciones de producción' : 'Production operations'}
          </h2>
          <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">
            {es ? 'El servidor valida de nuevo cada acción; esta pantalla no es la autoridad.' : 'The server revalidates every action; this screen is not authoritative.'}
          </p>
        </div>
        <Btn size="sm" variant="ghost" onClick={() => void load()}><RefreshCw size={14} />{es ? 'Actualizar' : 'Refresh'}</Btn>
      </div>

      {error ? <div className="mb-4"><ErrorBox message={error instanceof Error ? error.message : String(error)} onRetry={() => void load()} /></div> : null}

      <div className="mb-4 grid gap-3 sm:grid-cols-3">
        <div className="rounded-xl border border-zinc-200 p-3 dark:border-zinc-800">
          <p className="text-xs text-zinc-500">Driver</p>
          <div className="mt-1 flex items-center gap-2"><Badge tone={driver?.configured ? 'green' : 'red'}>{driver?.configured ? driver.name : (es ? 'No configurado' : 'Not configured')}</Badge></div>
          <p className="mt-2 text-xs text-zinc-500">{es ? 'Capacidad' : 'Capacity'}: {driver?.limit === null ? '∞' : `${driver?.available ?? 0}/${driver?.limit ?? 0}`}</p>
        </div>
        <div className="rounded-xl border border-zinc-200 p-3 dark:border-zinc-800">
          <p className="text-xs text-zinc-500">Runtime</p>
          <div className="mt-1"><Badge tone={runtime?.status === 'running' ? 'green' : 'zinc'}>{runtime?.status ?? (es ? 'Sin despliegue' : 'Not deployed')}</Badge></div>
          <p className="mt-2 truncate font-mono text-[11px] text-zinc-500" title={runtime?.liveImage}>{runtime?.liveImage ?? '—'}</p>
        </div>
        <div className="rounded-xl border border-zinc-200 p-3 dark:border-zinc-800">
          <p className="text-xs text-zinc-500">Live</p>
          {runtime?.status === 'running' ? (
            <a className="mt-2 inline-flex items-center gap-1 text-xs text-cyan-600 hover:underline dark:text-cyan-300" href={publicAppUrlFor(project.id)} target="_blank" rel="noreferrer">
              {es ? 'Abrir aplicación' : 'Open application'} <ExternalLink size={12} />
            </a>
          ) : <p className="mt-2 text-xs text-zinc-500">—</p>}
        </div>
      </div>

      <div className="mb-5 flex flex-wrap gap-2 rounded-xl border border-zinc-200 p-3 dark:border-zinc-800">
        <Btn variant="primary" size="sm" disabled={!mutable} onClick={() => void act('deploy', () => api.deploy(project.id))}>
          {busy === 'deploy' ? <Spinner /> : <Rocket size={14} />}{es ? 'Desplegar' : 'Deploy'}
        </Btn>
        <Btn size="sm" disabled={!mutable || !runtime} onClick={() => void act('backup', () => api.createDatabaseBackup(project.id))}>
          {busy === 'backup' ? <Spinner /> : <Archive size={14} />}{es ? 'Crear backup' : 'Create backup'}
        </Btn>
        <Btn size="sm" disabled={!mutable || !runtime} onClick={() => void act('migrations', () => api.runMigrations(project.id))}>
          {busy === 'migrations' ? <Spinner /> : <Database size={14} />}{es ? 'Aplicar migraciones' : 'Run migrations'}
        </Btn>
        <Btn variant="danger" size="sm" disabled={!canRollback} onClick={() => {
          if (window.confirm(es ? '¿Restaurar la versión y los datos anteriores?' : 'Restore the previous version and data?')) {
            void act('rollback', () => api.rollback(project.id));
          }
        }}>
          {busy === 'rollback' ? <Spinner /> : <RotateCcw size={14} />}{es ? 'Rollback' : 'Rollback'}
        </Btn>
        {activeDeployment && (
          <Btn variant="danger" size="sm" disabled={Boolean(busy)} onClick={() => void act('cancel', () => api.cancelDeployment(activeDeployment.id))}>
            {busy === 'cancel' ? <Spinner /> : <Square size={13} />}{es ? 'Cancelar despliegue' : 'Cancel deployment'}
          </Btn>
        )}
        {!mutable && !activeDeployment && (
          <p className="self-center text-xs text-amber-600 dark:text-amber-400">
            {project.type !== 'dynamic'
              ? (es ? 'Solo disponible para proyectos dinámicos.' : 'Only available for dynamic projects.')
              : !driver?.configured
                ? (es ? 'El driver no está configurado.' : 'The driver is not configured.')
                : activeOperation
                  ? `${es ? 'Operación activa' : 'Active operation'}: ${activeOperation.operation}`
                  : (es ? 'Sin capacidad disponible.' : 'No capacity available.')}
          </p>
        )}
      </div>

      <section className="mb-5">
        <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-zinc-500">Deployments</h3>
        {deployments.length === 0 ? <Empty title={es ? 'Sin despliegues' : 'No deployments'} /> : (
          <div className="space-y-2">
            {deployments.slice(0, 12).map((item) => (
              <div key={item.id} className="rounded-lg border border-zinc-200 p-3 text-xs dark:border-zinc-800">
                <div className="flex flex-wrap items-center gap-2"><Badge tone={tone(item.status)}>{item.status}</Badge><span className="font-mono text-zinc-500">{item.id.slice(0, 8)}</span><span className="text-zinc-500">{formatDateTime(item.createdAt, lang)}</span></div>
                {item.error && <p className="mt-2 break-words text-red-600 dark:text-red-300">{item.error}</p>}
              </div>
            ))}
          </div>
        )}
      </section>

      <section className="mb-5">
        <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-zinc-500">{es ? 'Auditoría administrativa' : 'Administrative audit'}</h3>
        <div className="space-y-2">
          {operations.slice(0, 20).map((item) => (
            <div key={item.id} className="rounded-lg border border-zinc-200 p-3 text-xs dark:border-zinc-800">
              <div className="flex flex-wrap items-center gap-2"><Badge tone={tone(item.status)}>{item.status}</Badge><span className="font-medium text-zinc-800 dark:text-zinc-200">{item.operation}</span><span className="text-zinc-500">{formatDateTime(item.createdAt, lang)}</span></div>
              {resultDiagnostic(item.result) && <p className="mt-2 break-words text-red-600 dark:text-red-300">{resultDiagnostic(item.result)}</p>}
            </div>
          ))}
          {operations.length === 0 && <Empty title={es ? 'Sin operaciones' : 'No operations'} />}
        </div>
      </section>

      {migrations.length > 0 && (
        <section>
          <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-zinc-500">{es ? 'Migraciones' : 'Migrations'}</h3>
          <div className="space-y-2">{migrations.slice(0, 20).map((item) => (
            <div key={item.id} className="flex items-center gap-2 rounded-lg border border-zinc-200 p-3 text-xs dark:border-zinc-800"><Badge tone={tone(item.status)}>{item.status}</Badge><span className="font-mono">{item.name}</span>{item.error && <span className="text-red-600 dark:text-red-300">{item.error}</span>}</div>
          ))}</div>
        </section>
      )}
    </div>
  );
}
