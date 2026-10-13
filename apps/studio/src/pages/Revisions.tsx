/* oxlint-disable react/set-state-in-effect -- async resource loading and project selection are intentional */
import { useCallback, useEffect, useState } from 'react';
import { History, Plus } from 'lucide-react';
import { api } from '../api/client';
import type { Project, RevisionInfo } from '../api/types';
import { useT } from '../i18n';
import { Badge, Btn, Card, Empty, ErrorBox, Field, Modal, PageHeader, Select, Spinner, TextInput } from '../components/ui';
import { formatDateTime } from '../utils/format';
import { apiErrorDetail, apiErrorHintKey, apiErrorKey } from '../utils/errors';

export function Revisions() {
  const { t, lang } = useT();
  const [projects, setProjects] = useState<Project[]>([]);
  const [projectId, setProjectId] = useState('');
  const [revisions, setRevisions] = useState<RevisionInfo[] | null>(null);
  const [loadingProjects, setLoadingProjects] = useState(true);
  const [projectsError, setProjectsError] = useState<unknown>(null);
  const [loadingRevisions, setLoadingRevisions] = useState(false);
  const [revisionsError, setRevisionsError] = useState<unknown>(null);
  const [label, setLabel] = useState('');
  const [creating, setCreating] = useState(false);
  const [restoreTarget, setRestoreTarget] = useState<RevisionInfo | null>(null);
  const [restoring, setRestoring] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const loadProjects = useCallback(async () => {
    setLoadingProjects(true);
    setProjectsError(null);
    try {
      const res = await api.listProjects({ page: 1, pageSize: 100 });
      setProjects(res.items);
    } catch (e) {
      setProjectsError(e);
    } finally {
      setLoadingProjects(false);
    }
  }, []);

  useEffect(() => {
    void loadProjects();
  }, [loadProjects]);

  const loadRevisions = useCallback(async (id: string) => {
    setLoadingRevisions(true);
    setRevisionsError(null);
    try {
      const res = await api.listRevisions(id);
      setRevisions(res.items);
    } catch (e) {
      setRevisionsError(e);
      setRevisions(null);
    } finally {
      setLoadingRevisions(false);
    }
  }, []);

  useEffect(() => {
    if (projectId) void loadRevisions(projectId);
    else setRevisions(null);
  }, [projectId, loadRevisions]);

  const createRevision = async () => {
    if (creating || !projectId) return;
    setCreating(true);
    setNotice(null);
    try {
      await api.createRevision(projectId, label.trim() || undefined);
      setLabel('');
      setNotice(t('revisions.created'));
      await loadRevisions(projectId);
    } catch (e) {
      setRevisionsError(e);
    } finally {
      setCreating(false);
    }
  };

  const confirmRestore = async () => {
    if (!restoreTarget || restoring || !projectId) return;
    setRestoring(true);
    try {
      await api.restoreRevision(projectId, restoreTarget.id);
      setRestoreTarget(null);
      setNotice(t('revisions.restored'));
      await loadRevisions(projectId);
    } catch (e) {
      setRevisionsError(e);
      setRestoreTarget(null);
    } finally {
      setRestoring(false);
    }
  };

  if (loadingProjects) {
    return (
      <div className="flex justify-center py-16">
        <Spinner className="h-6 w-6" />
      </div>
    );
  }

  if (projectsError) {
    const hintKey = apiErrorHintKey(projectsError);
    return (
      <ErrorBox
        message={t(apiErrorKey(projectsError))}
        hint={hintKey ? t(hintKey) : (apiErrorDetail(projectsError) ?? undefined)}
        onRetry={loadProjects}
      />
    );
  }

  return (
    <div>
      <PageHeader title={t('revisions.title')} subtitle={t('revisions.subtitle')} />

      {notice && (
        <div className="mb-4 rounded-xl border border-emerald-500/30 bg-emerald-500/10 px-4 py-2.5 text-sm text-emerald-700 dark:text-emerald-300">
          {notice}
        </div>
      )}

      <div className="mb-4 max-w-md">
        <Field label={t('revisions.selectProject')}>
          <Select value={projectId} onChange={(e) => setProjectId(e.target.value)}>
            <option value="">—</option>
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </Select>
        </Field>
      </div>

      {!projectId && (
        <Empty
          icon={<History className="h-8 w-8" />}
          title={t('revisions.selectProject')}
          hint={t('revisions.noRevisionsHint')}
        />
      )}

      {projectId && (
        <div className="space-y-4">
          <Card className="p-4">
            <h2 className="mb-3 text-sm font-semibold text-zinc-900 dark:text-zinc-50">
              {t('revisions.createRevision')}
            </h2>
            <div className="flex flex-wrap items-end gap-2">
              <div className="min-w-[220px] flex-1">
                <Field label={t('revisions.labelLabel')}>
                  <TextInput
                    value={label}
                    onChange={(e) => setLabel(e.target.value)}
                    placeholder={t('revisions.labelPh')}
                    disabled={creating}
                  />
                </Field>
              </div>
              <Btn variant="primary" onClick={() => void createRevision()} disabled={creating}>
                {creating ? <Spinner className="h-4 w-4" /> : <Plus className="h-4 w-4" />}
                {t('revisions.create')}
              </Btn>
            </div>
          </Card>

          {loadingRevisions && (
            <div className="flex justify-center py-12">
              <Spinner className="h-6 w-6" />
            </div>
          )}

          {!loadingRevisions && revisionsError != null && (
            <ErrorBox
              message={t(apiErrorKey(revisionsError))}
              hint={apiErrorHintKey(revisionsError) ? t(apiErrorHintKey(revisionsError)!) : (apiErrorDetail(revisionsError) ?? undefined)}
              onRetry={() => void loadRevisions(projectId)}
            />
          )}

          {!loadingRevisions && !revisionsError && revisions && revisions.length === 0 && (
            <Empty
              icon={<History className="h-8 w-8" />}
              title={t('revisions.noRevisions')}
              hint={t('revisions.noRevisionsHint')}
            />
          )}

          {!loadingRevisions && !revisionsError && revisions && revisions.length > 0 && (
            <Card>
              <ul className="divide-y divide-zinc-100 dark:divide-zinc-800">
                {revisions.map((r) => (
                  <li key={r.id} className="flex items-center justify-between gap-3 px-4 py-3">
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium text-zinc-900 dark:text-zinc-100">{r.label}</p>
                      <p className="mt-0.5 flex items-center gap-2 text-xs text-zinc-500 dark:text-zinc-400">
                        <Badge tone="zinc" className="font-mono">
                          {t('revisions.sha')}: {r.gitSha.slice(0, 8)}
                        </Badge>
                        <span>{formatDateTime(r.createdAt, lang)}</span>
                      </p>
                    </div>
                    <Btn variant="outline" size="sm" onClick={() => setRestoreTarget(r)}>
                      {t('common.restore')}
                    </Btn>
                  </li>
                ))}
              </ul>
            </Card>
          )}
        </div>
      )}

      {restoreTarget && (
        <Modal
          title={t('revisions.restoreTitle')}
          onClose={() => !restoring && setRestoreTarget(null)}
          footer={
            <Btn variant="danger" onClick={() => void confirmRestore()} disabled={restoring}>
              {restoring && <Spinner className="h-3.5 w-3.5" />}
              {restoring ? t('common.saving') : t('common.restore')}
            </Btn>
          }
        >
          <p>{t('revisions.restoreMessage', { label: restoreTarget.label })}</p>
        </Modal>
      )}
    </div>
  );
}
