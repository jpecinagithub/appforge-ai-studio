import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { ChevronLeft, ChevronRight, Eye, Plus, Search, Trash2 } from 'lucide-react';
import { api } from '../api/client';
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

const PAGE_SIZE = 24;

export function Projects() {
  const { t, lang } = useT();
  const navigate = useNavigate();
  const [items, setItems] = useState<Project[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState('');
  const [debounced, setDebounced] = useState('');
  const [typeFilter, setTypeFilter] = useState('all');
  const [statusFilter, setStatusFilter] = useState('all');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const [deleteTarget, setDeleteTarget] = useState<Project | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    const id = setTimeout(() => setDebounced(search), 300);
    return () => clearTimeout(id);
  }, [search]);

  useEffect(() => {
    setPage(1);
  }, [debounced, typeFilter, statusFilter]);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await api.listProjects({
        search: debounced || undefined,
        type: typeFilter === 'all' ? undefined : typeFilter,
        status: statusFilter === 'all' ? undefined : statusFilter,
        page,
        pageSize: PAGE_SIZE,
      });
      setItems(res.items);
      setTotal(res.total);
    } catch (e) {
      setError(e);
    } finally {
      setLoading(false);
    }
  }, [debounced, typeFilter, statusFilter, page]);

  useEffect(() => {
    void load();
  }, [load]);

  const confirmDelete = async () => {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      await api.deleteProject(deleteTarget.id);
      setDeleteTarget(null);
      setNotice(t('projects.deleted'));
      await load();
    } catch (e) {
      setError(e);
      setDeleteTarget(null);
    } finally {
      setDeleting(false);
    }
  };

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

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
    if (items.length === 0) {
      return (
        <Empty
          title={t('projects.empty')}
          hint={t('projects.emptyHint')}
          action={
            <Btn variant="primary" onClick={() => navigate('/projects/new')}>
              <Plus className="h-4 w-4" />
              {t('projects.newProject')}
            </Btn>
          }
        />
      );
    }
    return (
      <div className="overflow-x-auto">
        <table className="w-full min-w-[640px] text-left text-sm">
          <thead>
            <tr className="border-b border-zinc-200 text-xs uppercase tracking-wide text-zinc-500 dark:border-zinc-800 dark:text-zinc-400">
              <th className="px-3 py-2.5 font-medium">{t('projects.colName')}</th>
              <th className="px-3 py-2.5 font-medium">{t('projects.colType')}</th>
              <th className="px-3 py-2.5 font-medium">{t('projects.colStatus')}</th>
              <th className="px-3 py-2.5 font-medium">{t('projects.colUpdated')}</th>
              <th className="px-3 py-2.5 text-right font-medium">{t('common.actions')}</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
            {items.map((p) => (
              <tr key={p.id} className="hover:bg-zinc-50 dark:hover:bg-zinc-800/40">
                <td className="px-3 py-3">
                  <Link
                    to={`/projects/${p.id}`}
                    className="font-medium text-zinc-900 hover:text-cyan-600 dark:text-zinc-100 dark:hover:text-cyan-400"
                  >
                    {p.name}
                  </Link>
                </td>
                <td className="px-3 py-3">
                  <Badge tone={p.type === 'dynamic' ? 'cyan' : 'zinc'}>
                    {p.type === 'dynamic' ? t('projects.typeDynamic') : t('projects.typeStatic')}
                  </Badge>
                </td>
                <td className="px-3 py-3">
                  <Badge tone={p.status === 'archived' ? 'zinc' : 'green'}>
                    {p.status === 'archived' ? t('projects.statusArchived') : t('projects.statusActive')}
                  </Badge>
                </td>
                <td className="whitespace-nowrap px-3 py-3 text-xs text-zinc-500 dark:text-zinc-400">
                  {timeAgo(p.updatedAt, lang)}
                </td>
                <td className="px-3 py-3">
                  <div className="flex justify-end gap-1">
                    <IconBtn label={t('common.open')} onClick={() => navigate(`/projects/${p.id}`)}>
                      <Eye className="h-4 w-4" />
                    </IconBtn>
                    <IconBtn label={t('common.delete')} onClick={() => setDeleteTarget(p)}>
                      <Trash2 className="h-4 w-4" />
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
      <PageHeader
        title={t('projects.title')}
        subtitle={t('projects.subtitle')}
        actions={
          <Btn variant="primary" onClick={() => navigate('/projects/new')}>
            <Plus className="h-4 w-4" />
            {t('projects.newProject')}
          </Btn>
        }
      />

      {notice && (
        <div className="mb-4 rounded-xl border border-emerald-500/30 bg-emerald-500/10 px-4 py-2.5 text-sm text-emerald-700 dark:text-emerald-300">
          {notice}
        </div>
      )}

      <div className="mb-4 flex flex-wrap items-center gap-2">
        <div className="relative min-w-[200px] flex-1">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-zinc-400" />
          <TextInput
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={t('projects.searchPh')}
            className="pl-9"
          />
        </div>
        <Select value={typeFilter} onChange={(e) => setTypeFilter(e.target.value)} aria-label={t('projects.filterType')} className="w-auto">
          <option value="all">{t('common.all')}</option>
          <option value="static">{t('projects.typeStatic')}</option>
          <option value="dynamic">{t('projects.typeDynamic')}</option>
        </Select>
        <Select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} aria-label={t('projects.filterStatus')} className="w-auto">
          <option value="all">{t('common.all')}</option>
          <option value="active">{t('projects.statusActive')}</option>
          <option value="archived">{t('projects.statusArchived')}</option>
        </Select>
      </div>

      <Card>{body()}</Card>

      {!loading && !error && total > PAGE_SIZE && (
        <div className="mt-4 flex items-center justify-between text-sm text-zinc-500 dark:text-zinc-400">
          <span>
            {(page - 1) * PAGE_SIZE + 1}–{Math.min(page * PAGE_SIZE, total)} / {total}
          </span>
          <div className="flex gap-2">
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

      {deleteTarget && (
        <Modal
          title={t('projects.deleteTitle')}
          onClose={() => !deleting && setDeleteTarget(null)}
          footer={
            <Btn variant="danger" onClick={() => void confirmDelete()} disabled={deleting}>
              {deleting && <Spinner className="h-3.5 w-3.5" />}
              {deleting ? t('common.deleting') : t('common.delete')}
            </Btn>
          }
        >
          <p>{t('projects.deleteMessage', { name: deleteTarget.name })}</p>
        </Modal>
      )}
    </div>
  );
}
