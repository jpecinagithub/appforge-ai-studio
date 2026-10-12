import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowDownToLine, Code2, FileText, Folder, FolderOpen } from 'lucide-react';
import { api } from '../api/client';
import type { FileNode, Project } from '../api/types';
import { useT } from '../i18n';
import { Card, Empty, ErrorBox, Field, IconBtn, PageHeader, Select, Spinner } from '../components/ui';
import { apiErrorDetail, apiErrorHintKey, apiErrorKey } from '../utils/errors';

interface FlatNode {
  node: FileNode;
  depth: number;
}

function flatten(nodes: FileNode[], depth = 0, out: FlatNode[] = []): FlatNode[] {
  const sorted = [...nodes].sort((a, b) => {
    if (a.type !== b.type) return a.type === 'dir' ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  for (const n of sorted) {
    out.push({ node: n, depth });
    if (n.type === 'dir' && n.children) flatten(n.children, depth + 1, out);
  }
  return out;
}

export function Assets() {
  const { t } = useT();
  const navigate = useNavigate();
  const [projects, setProjects] = useState<Project[]>([]);
  const [projectId, setProjectId] = useState('');
  const [tree, setTree] = useState<FileNode[] | null>(null);
  const [loadingProjects, setLoadingProjects] = useState(true);
  const [projectsError, setProjectsError] = useState<unknown>(null);
  const [loadingFiles, setLoadingFiles] = useState(false);
  const [filesError, setFilesError] = useState<unknown>(null);
  const [downloadingPath, setDownloadingPath] = useState<string | null>(null);

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

  const loadFiles = useCallback(async (id: string) => {
    setLoadingFiles(true);
    setFilesError(null);
    try {
      const res = await api.listFiles(id);
      setTree(res.tree);
    } catch (e) {
      setFilesError(e);
      setTree(null);
    } finally {
      setLoadingFiles(false);
    }
  }, []);

  useEffect(() => {
    if (projectId) void loadFiles(projectId);
    else setTree(null);
  }, [projectId, loadFiles]);

  const flat = useMemo(() => (tree ? flatten(tree) : []), [tree]);

  const downloadFile = async (path: string, name: string) => {
    setDownloadingPath(path);
    try {
      const res = await api.getFileContent(projectId, path);
      const blob = new Blob([res.content], { type: 'text/plain;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = name;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 5000);
    } catch (e) {
      setFilesError(e);
    } finally {
      setDownloadingPath(null);
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
      <PageHeader title={t('assets.title')} subtitle={t('assets.subtitle')} />

      <div className="mb-4 max-w-md">
        <Field label={t('assets.selectProject')}>
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
          icon={<FolderOpen className="h-8 w-8" />}
          title={t('assets.selectProject')}
          hint={t('assets.selectProjectHint')}
        />
      )}

      {projectId && loadingFiles && (
        <div className="flex justify-center py-16">
          <Spinner className="h-6 w-6" />
        </div>
      )}

      {projectId && !loadingFiles && filesError != null && (
        <ErrorBox
          message={t(apiErrorKey(filesError))}
          hint={apiErrorHintKey(filesError) ? t(apiErrorHintKey(filesError)!) : (apiErrorDetail(filesError) ?? undefined)}
          onRetry={() => void loadFiles(projectId)}
        />
      )}

      {projectId && !loadingFiles && !filesError && flat.length === 0 && (
        <Empty icon={<FileText className="h-8 w-8" />} title={t('assets.noFiles')} />
      )}

      {projectId && !loadingFiles && !filesError && flat.length > 0 && (
        <Card>
          <ul className="divide-y divide-zinc-100 dark:divide-zinc-800">
            {flat.map(({ node, depth }) => {
              const isDir = node.type === 'dir';
              return (
                <li
                  key={node.path}
                  className="flex items-center gap-2 px-3 py-2 hover:bg-zinc-50 dark:hover:bg-zinc-800/40"
                  style={{ paddingLeft: `${12 + depth * 20}px` }}
                >
                  {isDir ? (
                    <Folder className="h-4 w-4 shrink-0 text-zinc-400 dark:text-zinc-500" />
                  ) : (
                    <FileText className="h-4 w-4 shrink-0 text-zinc-400 dark:text-zinc-500" />
                  )}
                  <span className="min-w-0 flex-1 truncate font-mono text-xs text-zinc-800 dark:text-zinc-200">
                    {node.name}
                  </span>
                  {!isDir && (
                    <div className="flex shrink-0 gap-1">
                      <IconBtn
                        label={t('assets.downloadFile')}
                        onClick={() => void downloadFile(node.path, node.name)}
                        disabled={downloadingPath === node.path}
                      >
                        {downloadingPath === node.path ? (
                          <Spinner className="h-4 w-4" />
                        ) : (
                          <ArrowDownToLine className="h-4 w-4" />
                        )}
                      </IconBtn>
                      <IconBtn
                        label={t('assets.openInCode')}
                        onClick={() =>
                          navigate(`/projects/${projectId}?tab=code&path=${encodeURIComponent(node.path)}`)
                        }
                      >
                        <Code2 className="h-4 w-4" />
                      </IconBtn>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        </Card>
      )}
    </div>
  );
}
