import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { ChevronLeft, ChevronRight, Eye, Hammer } from 'lucide-react';
import { api } from '../api/client';
import type { BuildRecord, BuildStatus } from '../api/types';
import { useT } from '../i18n';
import { Badge, Btn, Card, Empty, ErrorBox, IconBtn, PageHeader, Spinner } from '../components/ui';
import { formatDateTime, formatDuration } from '../utils/format';
import { apiErrorDetail, apiErrorHintKey, apiErrorKey } from '../utils/errors';

interface BuildRow {
  build: BuildRecord;
  projectId: string;
  projectName: string;
}

function BuildBadge({ status }: { status: BuildStatus }) {
  const { t } = useT();
  const tone = status === 'success' ? 'green' : status === 'failed' ? 'red' : status === 'running' ? 'amber' : 'zinc';
  const key = status === 'pending' ? 'builds.pending' : status === 'running' ? 'builds.running' : status === 'success' ? 'builds.success' : status === 'failed' ? 'builds.failed' : 'builds.cancelled';
  return <Badge tone={tone}>{t(key)}</Badge>;
}

const PAGE_SIZE = 15;

export function BuildsPage() {
  const { t, lang } = useT();
  const navigate = useNavigate();
  const [rows, setRows] = useState<BuildRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const [page, setPage] = useState(1);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await api.listProjects({ page: 1, pageSize: 100 });
      const results = await Promise.allSettled(
        res.items.map((p) => api.listBuilds(p.id).then((r) => ({ p, items: r.items }))),
      );
      const all: BuildRow[] = [];
      for (const res2 of results) {
        if (res2.status !== 'fulfilled') continue;
        for (const b of res2.value.items) {
          all.push({ build: b, projectId: res2.value.p.id, projectName: res2.value.p.name });
        }
      }
      all.sort((a, b) => b.build.startedAt.localeCompare(a.build.startedAt));
      setRows(all);
    } catch (e) {
      setError(e);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const totalPages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
  const pageRows = rows.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

  const body = () => {
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
    if (rows.length === 0) {
      return <Empty icon={<Hammer className="h-8 w-8" />} title={t('builds.noBuilds')} hint={t('builds.noBuildsHint')} />;
    }
    return (
      <div className="overflow-x-auto">
        <table className="w-full min-w-[640px] text-left text-sm">
          <thead>
            <tr className="border-b border-zinc-200 text-xs uppercase tracking-wide text-zinc-500 dark:border-zinc-800 dark:text-zinc-400">
              <th className="px-3 py-2.5 font-medium">{t('projects.title')}</th>
              <th className="px-3 py-2.5 font-medium">{t('builds.startedAt')}</th>
              <th className="px-3 py-2.5 font-medium">{t('builds.duration')}</th>
              <th className="px-3 py-2.5 font-medium">{t('builds.statusLabel')}</th>
              <th className="px-3 py-2.5 text-right font-medium">{t('common.actions')}</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
            {pageRows.map(({ build, projectId, projectName }) => (
              <tr key={build.id} className="hover:bg-zinc-50 dark:hover:bg-zinc-800/40">
                <td className="px-3 py-3">
                  <Link
                    to={`/projects/${projectId}`}
                    className="font-medium text-zinc-900 hover:text-cyan-600 dark:text-zinc-100 dark:hover:text-cyan-400"
                  >
                    {projectName}
                  </Link>
                </td>
                <td className="whitespace-nowrap px-3 py-3 text-xs text-zinc-500 dark:text-zinc-400">
                  {formatDateTime(build.startedAt, lang)}
                </td>
                <td className="whitespace-nowrap px-3 py-3 text-xs text-zinc-500 dark:text-zinc-400">
                  {formatDuration(build.durationMs)}
                </td>
                <td className="px-3 py-3">
                  <BuildBadge status={build.status} />
                </td>
                <td className="px-3 py-3">
                  <div className="flex justify-end">
                    <IconBtn
                      label={t('common.view')}
                      onClick={() => navigate(`/projects/${projectId}?tab=builds&build=${build.id}`)}
                    >
                      <Eye className="h-4 w-4" />
                    </IconBtn>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  };

  return (
    <div>
      <PageHeader title={t('builds.title')} subtitle={undefined} />

      <Card>{body()}</Card>

      {!loading && !error && rows.length > PAGE_SIZE && (
        <div className="mt-4 flex items-center justify-between text-sm text-zinc-500 dark:text-zinc-400">
          <span>
            {(page - 1) * PAGE_SIZE + 1}–{Math.min(page * PAGE_SIZE, rows.length)} / {rows.length}
          </span>
          <div className="flex items-center gap-2">
            <Btn variant="outline" size="sm" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
              <ChevronLeft className="h-4 w-4" />
            </Btn>
            <span className="px-2 py-1.5 text-xs">
              {page} / {totalPages}
            </span>
            <Btn variant="outline" size="sm" disabled={page >= totalPages} onClick={() => setPage((p) => p + 1)}>
              <ChevronRight className="h-4 w-4" />
            </Btn>
          </div>
        </div>
      )}
    </div>
  );
}
