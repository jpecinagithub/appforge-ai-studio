import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowDownToLine, ExternalLink, FolderOpen, Search, Trash2 } from 'lucide-react';
import { api, downloadArchive, previewUrlFor } from '../api/client';
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
  const [projects, setProjects] = useState<Project[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const [search, setSearch] = useState('');
  const [sort, setSort] = useState<'newest' | 'oldest'>('newest');
  const [typeFilter, setTypeFilter] = useState('all');
  const [statusFilter, setStatusFilter] = useState('all');
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
      if (q && !p.name.toLowerCase().includes(q) && !(p.description ?? '').toLowerCase().includes(q)) return false;
      return true;
    });
    list.sort((a, b) =>
      sort === 'newest' ? b.updatedAt.localeCompare(a.updatedAt) : a.updatedAt.localeCompare(b.updatedAt),
    );
    return list;
  }, [projects, search, sort, typeFilter, statusFilter]);

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
      <PageHeader title={t('library.title')} subtitle={t('library.subtitle')} />

      {error != null && (
        <div className="mb-4">
          <ErrorBox
            message={t(apiErrorKey(error))}
            hint={apiErrorHintKey(error) ? t(apiErrorHintKey(error)!) : (apiErrorDetail(error) ?? undefined)}
            onRetry={load}
          />
        </div>
      )}

      <div className="mb-4 flex flex-wrap items-center gap-2">
        <div className="relative min-w-[200px] flex-1">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-zinc-400" />
          <TextInput
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={t('library.searchPh')}
            className="pl-9"
          />
        </div>
        <Select value={sort} onChange={(e) => setSort(e.target.value as 'newest' | 'oldest')} aria-label={t('library.sortLabel')} className="w-auto">
          <option value="newest">{t('library.newest')}</option>
          <option value="oldest">{t('library.oldest')}</option>
        </Select>
        <Select value={typeFilter} onChange={(e) => setTypeFilter(e.target.value)} aria-label={t('library.filterType')} className="w-auto">
          <option value="all">{t('common.all')}</option>
          <option value="static">{t('projects.typeStatic')}</option>
          <option value="dynamic">{t('projects.typeDynamic')}</option>
        </Select>
        <Select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} aria-label={t('library.filterStatus')} className="w-auto">
          <option value="all">{t('common.all')}</option>
          <option value="active">{t('projects.statusActive')}</option>
          <option value="archived">{t('projects.statusArchived')}</option>
        </Select>
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
          {filtered.map((p) => (
            <Card key={p.id} className="flex flex-col overflow-hidden">
              <div className="flex aspect-video items-center justify-center bg-gradient-to-br from-zinc-200 via-zinc-100 to-cyan-100 dark:from-zinc-800 dark:via-zinc-900 dark:to-cyan-950">
                <span className="text-5xl font-bold tracking-tight text-zinc-400/70 dark:text-zinc-600/70">
                  {initialsOf(p.name)}
                </span>
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
                </div>
                <div className="mt-auto flex items-center justify-between pt-2">
                  <Btn variant="primary" size="sm" onClick={() => navigate(`/projects/${p.id}`)}>
                    <FolderOpen className="h-3.5 w-3.5" />
                    {t('common.open')}
                  </Btn>
                  <div className="flex gap-1">
                    <IconBtn
                      label={t('library.previewAction')}
                      onClick={() => window.open(previewUrlFor(p.id), '_blank', 'noopener')}
                    >
                      <ExternalLink className="h-4 w-4" />
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
          ))}
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
