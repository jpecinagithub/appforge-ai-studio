/* oxlint-disable react/set-state-in-effect -- async resource loading owns loading/error state */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowDownToLine, FolderOpen, Globe2, Search, Server, Trash2, X } from 'lucide-react';
import { api, downloadArchive, isDemoMode, openProjectPreview, publicAppUrlFor } from '../api/client';
import type { Project } from '../api/types';
import { useT } from '../i18n';
import {
  Badge,
  Btn,
  Card,
  Empty,
  ErrorBox,
  IconBtn,
  Modal,
  PageHeader,
  Select,
  Spinner,
  TextInput,
} from '../components/ui';
import { timeAgo } from '../utils/format';
import { apiErrorDetail, apiErrorHintKey, apiErrorKey } from '../utils/errors';

function initialsOf(name: string): string {
  const words = name.trim().split(/\s+/);
  if (words.length >= 2) return (words[0][0] + words[1][0]).toUpperCase();
  return name.trim().slice(0, 2).toUpperCase() || '?';
}

export function Library() {
  const { t, lang } = useT();
  const navigate = useNavigate();
  const demoMode = isDemoMode();
  const [projects, setProjects] = useState<Project[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const [search, setSearch] = useState('');
  const [sort, setSort] = useState<'newest' | 'oldest'>('newest');
  const [typeFilter, setTypeFilter] = useState('all');
  const [statusFilter, setStatusFilter] = useState('all');
  const [deploymentFilter, setDeploymentFilter] = useState<'all' | 'deployed' | 'notDeployed'>('all');
  const [downloadingId, setDownloadingId] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Project | null>(null);
  const [deleting, setDeleting] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await api.listProjects({ page: 1, pageSize: 100 });
      setProjects(res.items);
    } catch (e) {
      setError(e);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const filtered = useMemo(() => {
    if (!projects) return [];
    const q = search.trim().toLowerCase();
    const list = projects.filter((p) => {
      if (typeFilter !== 'all' && p.type !== typeFilter) return false;
      if (statusFilter !== 'all' && p.status !== statusFilter) return false;
      const deployed = !demoMode && p.previewUrl != null;
      if (deploymentFilter === 'deployed' && !deployed) return false;
      if (deploymentFilter === 'notDeployed' && deployed) return false;
      if (q && !p.name.toLowerCase().includes(q) && !(p.description ?? '').toLowerCase().includes(q)) return false;
      return true;
    });
    list.sort((a, b) =>
      sort === 'newest' ? b.updatedAt.localeCompare(a.updatedAt) : a.updatedAt.localeCompare(b.updatedAt),
    );
    return list;
  }, [projects, search, sort, typeFilter, statusFilter, deploymentFilter, demoMode]);

  const deployedCount = projects?.filter((p) => !demoMode && p.previewUrl != null).length ?? 0;
  const filtersActive = search.trim() !== ''
    || sort !== 'newest'
    || typeFilter !== 'all'
    || statusFilter !== 'all'
    || deploymentFilter !== 'all';

  const clearFilters = () => {
    setSearch('');
    setSort('newest');
    setTypeFilter('all');
    setStatusFilter('all');
    setDeploymentFilter('all');
  };

  const onDownload = async (p: Project) => {
    setDownloadingId(p.id);
    try {
      await downloadArchive(p);
    } catch (e) {
      setError(e);
    } finally {
      setDownloadingId(null);
    }
  };

  const confirmDelete = async () => {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      await api.deleteProject(deleteTarget.id);
      setDeleteTarget(null);
      await load();
    } catch (e) {
      setError(e);
      setDeleteTarget(null);
    } finally {
      setDeleting(false);
    }
  };

  if (loading) {
    return (
      <div className="flex justify-center py-16">
        <Spinner className="h-6 w-6" />
      </div>
    );
  }

  return (
    <div>
      <PageHeader
        title={t('library.title')}
        subtitle={`${t('library.subtitle')} ${t('library.deployedCount', { count: deployedCount })}`}
      />

      {error != null && (
        <div className="mb-4">
          <ErrorBox
            message={t(apiErrorKey(error))}
            hint={apiErrorHintKey(error) ? t(apiErrorHintKey(error)!) : (apiErrorDetail(error) ?? undefined)}
            onRetry={load}
          />
        </div>
      )}

      <div className="mb-5 flex flex-col gap-2 rounded-xl border border-zinc-200 bg-white/70 p-2 shadow-sm dark:border-zinc-800 dark:bg-zinc-900/60 xl:flex-row xl:items-center">
        <div className="relative min-w-0 flex-1">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-zinc-400" />
          <TextInput
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={t('library.searchPh')}
            className="h-10 border-transparent bg-zinc-100 pl-9 pr-9 shadow-none focus:bg-white dark:bg-zinc-950/70 dark:focus:bg-zinc-950"
          />
          {filtersActive && (
            <button
              type="button"
              onClick={clearFilters}
              title={t('library.clearFilters')}
              aria-label={t('library.clearFilters')}
              className="absolute right-1.5 top-1/2 inline-flex h-7 w-7 -translate-y-1/2 items-center justify-center rounded-md text-zinc-400 transition-colors hover:bg-zinc-200 hover:text-zinc-700 dark:hover:bg-zinc-800 dark:hover:text-zinc-200"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          )}
        </div>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 xl:flex xl:shrink-0">
          <div className="min-w-0 xl:w-40">
            <Select value={sort} onChange={(e) => setSort(e.target.value as 'newest' | 'oldest')} aria-label={t('library.sortLabel')} className="h-10 py-1.5">
              <option value="newest">{t('library.newest')}</option>
              <option value="oldest">{t('library.oldest')}</option>
            </Select>
          </div>
          <div className="min-w-0 xl:w-36">
            <Select value={typeFilter} onChange={(e) => setTypeFilter(e.target.value)} aria-label={t('library.filterType')} className="h-10 py-1.5">
              <option value="all">{t('library.filterType')}: {t('common.all')}</option>
              <option value="static">{t('projects.typeStatic')}</option>
              <option value="dynamic">{t('projects.typeDynamic')}</option>
            </Select>
          </div>
          <div className="min-w-0 xl:w-36">
            <Select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} aria-label={t('library.filterStatus')} className="h-10 py-1.5">
              <option value="all">{t('library.filterStatus')}: {t('common.all')}</option>
              <option value="active">{t('projects.statusActive')}</option>
              <option value="archived">{t('projects.statusArchived')}</option>
            </Select>
          </div>
          <div className="min-w-0 xl:w-48">
            <Select
              value={deploymentFilter}
              onChange={(e) => setDeploymentFilter(e.target.value as 'all' | 'deployed' | 'notDeployed')}
              aria-label={t('library.filterDeployment')}
              className="h-10 py-1.5"
            >
              <option value="all">{t('library.filterDeployment')}: {t('common.all')}</option>
              <option value="deployed">{t('library.deployed')}</option>
              <option value="notDeployed">{t('library.notDeployed')}</option>
            </Select>
          </div>
        </div>
      </div>

      {!projects || projects.length === 0 ? (
        <Empty
          icon={<FolderOpen className="h-8 w-8" />}
          title={t('library.noProjects')}
          hint={t('library.noProjectsHint')}
        />
      ) : filtered.length === 0 ? (
        <Empty title={t('common.noResults')} />
      ) : (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {filtered.map((p) => {
            const deployed = !demoMode && p.previewUrl != null;
            const appUrl = deployed ? publicAppUrlFor(p.id) : null;
            const domain = appUrl ? new URL(appUrl).host : null;
            return (
            <Card key={p.id} className="group flex flex-col overflow-hidden">
              <div className="relative flex aspect-video items-center justify-center overflow-hidden bg-gradient-to-br from-zinc-200 via-zinc-100 to-cyan-100 dark:from-zinc-800 dark:via-zinc-900 dark:to-cyan-950">
                <span className="text-5xl font-bold tracking-tight text-zinc-400/70 dark:text-zinc-600/70">
                  {initialsOf(p.name)}
                </span>
                {p.thumbnailUrl && (
                  <img
                    src={p.thumbnailUrl}
                    alt={t('library.screenshotAlt', { name: p.name })}
                    loading="lazy"
                    decoding="async"
                    className="absolute inset-0 h-full w-full object-cover object-top transition-transform duration-300 group-hover:scale-[1.015]"
                    onError={(event) => { event.currentTarget.style.display = 'none'; }}
                  />
                )}
              </div>
              <div className="flex flex-1 flex-col gap-2 p-4">
                <div className="flex items-start justify-between gap-2">
                  <h3 className="truncate text-sm font-semibold text-zinc-900 dark:text-zinc-50">{p.name}</h3>
                  <span className="shrink-0 text-xs text-zinc-400 dark:text-zinc-500">
                    {timeAgo(p.updatedAt, lang)}
                  </span>
                </div>
                {p.description && (
                  <p className="line-clamp-2 text-xs text-zinc-500 dark:text-zinc-400">{p.description}</p>
                )}
                <div className="flex gap-1.5">
                  <Badge tone={p.type === 'dynamic' ? 'cyan' : 'zinc'}>
                    {p.type === 'dynamic' ? t('projects.typeDynamic') : t('projects.typeStatic')}
                  </Badge>
                  <Badge tone={p.status === 'archived' ? 'zinc' : 'green'}>
                    {p.status === 'archived' ? t('projects.statusArchived') : t('projects.statusActive')}
                  </Badge>
                  <Badge tone={deployed ? 'cyan' : 'amber'}>
                    {deployed ? t('library.deployed') : t('library.notDeployed')}
                  </Badge>
                </div>
                {appUrl && domain ? (
                  <div className="rounded-lg border border-cyan-200 bg-cyan-50/70 p-2.5 dark:border-cyan-900 dark:bg-cyan-950/30">
                    <div className="mb-1 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-cyan-700 dark:text-cyan-300">
                      <Server className="h-3.5 w-3.5" />
                      Oracle · {domain}
                    </div>
                    <a
                      href={appUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      title={appUrl}
                      className="block break-all text-xs text-cyan-700 underline-offset-2 hover:underline dark:text-cyan-300"
                    >
                      {appUrl}
                    </a>
                  </div>
                ) : (
                  <p className="rounded-lg bg-zinc-100 px-2.5 py-2 text-xs text-zinc-500 dark:bg-zinc-800/70 dark:text-zinc-400">
                    {demoMode ? t('library.demoPreview') : t('library.buildRequired')}
                  </p>
                )}
                <div className="mt-auto flex items-center justify-between pt-2">
                  <Btn
                    variant="primary"
                    size="sm"
                    onClick={() => openProjectPreview(p.id)}
                    disabled={!p.previewUrl}
                  >
                    <Globe2 className="h-3.5 w-3.5" />
                    {deployed ? t('library.openApp') : t('library.previewAction')}
                  </Btn>
                  <div className="flex gap-1">
                    <IconBtn
                      label={t('library.openProject')}
                      onClick={() => navigate(`/projects/${p.id}`)}
                    >
                      <FolderOpen className="h-4 w-4" />
                    </IconBtn>
                    <IconBtn
                      label={t('library.downloadZip')}
                      onClick={() => void onDownload(p)}
                      disabled={downloadingId === p.id}
                    >
                      {downloadingId === p.id ? <Spinner className="h-4 w-4" /> : <ArrowDownToLine className="h-4 w-4" />}
                    </IconBtn>
                    <IconBtn label={t('library.delete')} onClick={() => setDeleteTarget(p)}>
                      <Trash2 className="h-4 w-4" />
                    </IconBtn>
                  </div>
                </div>
              </div>
            </Card>
            );
          })}
        </div>
      )}

      {deleteTarget && (
        <Modal
          title={t('library.deleteTitle')}
          onClose={() => !deleting && setDeleteTarget(null)}
          footer={
            <Btn variant="danger" onClick={() => void confirmDelete()} disabled={deleting}>
              {deleting && <Spinner className="h-3.5 w-3.5" />}
              {deleting ? t('common.deleting') : t('common.delete')}
            </Btn>
          }
        >
          <p>{t('library.deleteMessage', { name: deleteTarget.name })}</p>
        </Modal>
      )}
    </div>
  );
}
