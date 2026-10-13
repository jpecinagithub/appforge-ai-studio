/* oxlint-disable react/set-state-in-effect -- async resource loading owns loading/error state */
import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { FolderKanban, Hammer, RefreshCw, Rocket } from 'lucide-react';
import { api } from '../api/client';
import type { BuildRecord, BuildStatus, Project, Run, RunStatus } from '../api/types';
import { useT } from '../i18n';
import {
  Badge,
  Btn,
  Card,
  Empty,
  ErrorBox,
  PageHeader,
  Spinner,
  Stat,
  StatusDot,
} from '../components/ui';
import { formatDuration, timeAgo } from '../utils/format';
import { apiErrorDetail, apiErrorHintKey, apiErrorKey } from '../utils/errors';

interface RunRow {
  run: Run;
  projectName: string;
}

interface BuildRow {
  build: BuildRecord;
  projectName: string;
}

function RunBadge({ status }: { status: RunStatus }) {
  const { t } = useT();
  const tone = status === 'running' ? 'amber' : status === 'done' ? 'green' : status === 'error' ? 'red' : 'zinc';
  const key = status === 'queued' ? 'run.queued' : status === 'running' ? 'run.running' : status === 'done' ? 'run.done' : status === 'error' ? 'run.error' : 'run.cancelled';
  return (
    <Badge tone={tone}>
      {status === 'running' && <StatusDot active tone="amber" />}
      {t(key)}
    </Badge>
  );
}

function BuildBadge({ status }: { status: BuildStatus }) {
  const { t } = useT();
  const tone = status === 'success' ? 'green' : status === 'failed' ? 'red' : status === 'running' ? 'amber' : 'zinc';
  const key = status === 'pending' ? 'builds.pending' : status === 'running' ? 'builds.running' : status === 'success' ? 'builds.success' : status === 'failed' ? 'builds.failed' : 'builds.cancelled';
  return <Badge tone={tone}>{t(key)}</Badge>;
}

const THIRTY_DAYS_MS = 30 * 24 * 3600 * 1000;

export function Dashboard() {
  const { t, lang } = useT();
  const [projects, setProjects] = useState<Project[] | null>(null);
  const [runs, setRuns] = useState<RunRow[]>([]);
  const [builds, setBuilds] = useState<BuildRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const page = await api.listProjects({ page: 1, pageSize: 100 });
      const all = page.items;
      const recent12 = [...all]
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
        .slice(0, 12);
      const cutoff = Date.now() - THIRTY_DAYS_MS;
      const [runResults, buildResults] = await Promise.all([
        Promise.allSettled(recent12.map((p) => api.listRuns(p.id))),
        Promise.allSettled(recent12.map((p) => api.listBuilds(p.id))),
      ]);
      const runRows: RunRow[] = [];
      runResults.forEach((res, i) => {
        if (res.status !== 'fulfilled') return;
        for (const r of res.value.items) {
          if (new Date(r.createdAt).getTime() >= cutoff) runRows.push({ run: r, projectName: recent12[i].name });
        }
      });
      const buildRows: BuildRow[] = [];
      buildResults.forEach((res, i) => {
        if (res.status !== 'fulfilled') return;
        for (const b of res.value.items) {
          if (new Date(b.startedAt).getTime() >= cutoff) buildRows.push({ build: b, projectName: recent12[i].name });
        }
      });
      runRows.sort((a, b) => b.run.createdAt.localeCompare(a.run.createdAt));
      buildRows.sort((a, b) => b.build.startedAt.localeCompare(a.build.startedAt));
      setProjects(all);
      setRuns(runRows);
      setBuilds(buildRows);
    } catch (e) {
      setError(e);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  if (loading) {
    return (
      <div className="flex justify-center py-16">
        <Spinner className="h-6 w-6" />
      </div>
    );
  }

  if (error) {
    const hintKey = apiErrorHintKey(error);
    return (
      <ErrorBox
        message={t(apiErrorKey(error))}
        hint={hintKey ? t(hintKey) : (apiErrorDetail(error) ?? undefined)}
        onRetry={load}
      />
    );
  }

  const recentProjects = (projects ?? []).slice(0, 5);
  const recentRuns = runs.slice(0, 6);
  const recentBuilds = builds.slice(0, 6);

  return (
    <div>
      <PageHeader
        title={t('dashboard.title')}
        subtitle={t('dashboard.subtitle')}
        actions={
          <Btn variant="outline" onClick={() => void load()}>
            <RefreshCw className="h-4 w-4" />
            {t('common.refresh')}
          </Btn>
        }
      />

      <div className="mb-6 grid grid-cols-1 gap-3 sm:grid-cols-3">
        <Stat label={t('dashboard.kpiProjects')} value={projects?.length ?? 0} icon={<FolderKanban className="h-5 w-5" />} />
        <Stat label={t('dashboard.kpiRuns')} value={runs.length} icon={<Rocket className="h-5 w-5" />} />
        <Stat label={t('dashboard.kpiBuilds')} value={builds.length} icon={<Hammer className="h-5 w-5" />} />
      </div>

      {(!projects || projects.length === 0) && (
        <Empty
          icon={<FolderKanban className="h-8 w-8" />}
          title={t('dashboard.noData')}
          hint={t('dashboard.noDataHint')}
        />
      )}

      {projects && projects.length > 0 && (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          <Card className="p-4">
            <h2 className="mb-3 text-sm font-semibold text-zinc-900 dark:text-zinc-50">
              {t('dashboard.recentProjects')}
            </h2>
            <ul className="divide-y divide-zinc-100 dark:divide-zinc-800">
              {recentProjects.map((p) => (
                <li key={p.id} className="flex items-center justify-between gap-3 py-2.5">
                  <Link
                    to={`/projects/${p.id}`}
                    className="truncate text-sm font-medium text-zinc-800 hover:text-cyan-600 dark:text-zinc-100 dark:hover:text-cyan-400"
                  >
                    {p.name}
                  </Link>
                  <span className="shrink-0 text-xs text-zinc-400 dark:text-zinc-500">
                    {timeAgo(p.updatedAt, lang)}
                  </span>
                </li>
              ))}
            </ul>
          </Card>

          <Card className="p-4">
            <h2 className="mb-3 text-sm font-semibold text-zinc-900 dark:text-zinc-50">
              {t('dashboard.recentRuns')}
            </h2>
            {recentRuns.length === 0 ? (
              <p className="py-4 text-center text-xs text-zinc-400 dark:text-zinc-500">{t('dashboard.noData')}</p>
            ) : (
              <ul className="divide-y divide-zinc-100 dark:divide-zinc-800">
                {recentRuns.map(({ run, projectName }) => (
                  <li key={run.id} className="flex items-center justify-between gap-3 py-2.5">
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium text-zinc-800 dark:text-zinc-100">
                        {projectName}
                      </p>
                      <p className="truncate text-xs text-zinc-500 dark:text-zinc-400">{run.prompt}</p>
                    </div>
                    <div className="flex shrink-0 items-center gap-2">
                      <RunBadge status={run.status} />
                      <span className="text-xs text-zinc-400 dark:text-zinc-500">
                        {timeAgo(run.createdAt, lang)}
                      </span>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </Card>

          <Card className="p-4 lg:col-span-2">
            <h2 className="mb-3 text-sm font-semibold text-zinc-900 dark:text-zinc-50">
              {t('dashboard.recentBuilds')}
            </h2>
            {recentBuilds.length === 0 ? (
              <p className="py-4 text-center text-xs text-zinc-400 dark:text-zinc-500">{t('dashboard.noData')}</p>
            ) : (
              <ul className="divide-y divide-zinc-100 dark:divide-zinc-800">
                {recentBuilds.map(({ build, projectName }) => (
                  <li key={build.id} className="flex items-center justify-between gap-3 py-2.5">
                    <span className="truncate text-sm font-medium text-zinc-800 dark:text-zinc-100">
                      {projectName}
                    </span>
                    <div className="flex shrink-0 items-center gap-2">
                      <BuildBadge status={build.status} />
                      <span className="text-xs text-zinc-400 dark:text-zinc-500">
                        {formatDuration(build.durationMs)}
                      </span>
                      <span className="text-xs text-zinc-400 dark:text-zinc-500">
                        {timeAgo(build.startedAt, lang)}
                      </span>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>
      )}
    </div>
  );
}
