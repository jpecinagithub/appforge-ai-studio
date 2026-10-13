/* oxlint-disable react/set-state-in-effect -- tab resources synchronize with project/build lifecycle */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  Code2,
  Download,
  ExternalLink,
  Hammer,
  Monitor,
  RefreshCw,
  RotateCcw,
  Save,
  Smartphone,
  Sparkles,
  Tablet,
  TerminalSquare,
  Trash2,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { ApiError, api, isDemoMode, openProjectPreview, previewUrlFor } from '../api/client';
import { demoPreviewHtml } from '../api/demo';
import type { StreamEvent } from '../api/sse';
import { useProjectWork } from '../project/work';
import type { WorkspaceTab } from '../project/work';
import { useT } from '../i18n';
import type { TKey } from '../i18n/strings';
import { Badge, Btn, Empty, ErrorBox, IconBtn, Spinner, TextInput } from './ui';
import { FileTree } from './FileTree';
import { CodeEditor } from './CodeEditor';
import { formatBytes, formatDateTime, formatDuration, timeAgo } from '../utils/format';
import { apiErrorDetail, apiErrorKey } from '../utils/errors';
import type {
  BuildRecord,
  BuildStatus,
  FileNode,
  PreviewInfo,
  RunEventKind,
} from '../api/types';

const TABS: { id: WorkspaceTab; label: TKey; Icon: LucideIcon }[] = [
  { id: 'preview', label: 'ws.tabPreview', Icon: Monitor },
  { id: 'builds', label: 'ws.tabBuilds', Icon: Hammer },
  { id: 'code', label: 'ws.tabCode', Icon: Code2 },
  { id: 'console', label: 'ws.tabConsole', Icon: TerminalSquare },
];

export function Workspace() {
  const { t } = useT();
  const { workspaceTab, setWorkspaceTab } = useProjectWork();
  return (
    <div className="flex h-full flex-col">
      <div
        className="flex gap-1 border-b border-zinc-200 px-3 dark:border-zinc-800"
        role="tablist"
        aria-label={t('ws.workspace')}
      >
        {TABS.map(({ id, label, Icon }) => {
          const active = workspaceTab === id;
          return (
            <button
              key={id}
              type="button"
              role="tab"
              aria-selected={active}
              onClick={() => setWorkspaceTab(id)}
              className={`flex items-center gap-1.5 border-b-2 px-3 py-2.5 text-sm transition-colors ${
                active
                  ? 'border-cyan-500 text-zinc-900 dark:text-zinc-50'
                  : 'border-transparent text-zinc-500 hover:text-zinc-800 dark:text-zinc-400 dark:hover:text-zinc-200'
              }`}
            >
              <Icon size={15} />
              {t(label)}
            </button>
          );
        })}
      </div>
      <div className="min-h-0 flex-1">
        {workspaceTab === 'preview' && <PreviewPane />}
        {workspaceTab === 'builds' && <BuildsPane />}
        {workspaceTab === 'code' && <CodePane />}
        {workspaceTab === 'console' && <ConsolePane />}
      </div>
    </div>
  );
}

// ------------------------------------------------------------ preview -------

type Device = 'desktop' | 'tablet' | 'mobile';

const DEVICE_WIDTH: Record<Device, string> = {
  desktop: '100%',
  tablet: '768px',
  mobile: '390px',
};

const DEVICES: { id: Device; label: TKey; Icon: LucideIcon }[] = [
  { id: 'desktop', label: 'preview.desktop', Icon: Monitor },
  { id: 'tablet', label: 'preview.tablet', Icon: Tablet },
  { id: 'mobile', label: 'preview.mobile', Icon: Smartphone },
];

function PreviewPane() {
  const { t } = useT();
  const { project, previewKey, notifyBuildsChanged, notifyPreviewChanged, setWorkspaceTab } =
    useProjectWork();
  const [info, setInfo] = useState<PreviewInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const [rebuilding, setRebuilding] = useState(false);
  const [buildMsg, setBuildMsg] = useState<string | null>(null);
  const [device, setDevice] = useState<Device>('desktop');
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    api
      .getPreview(project.id)
      .then((res) => {
        if (!cancelled) {
          setInfo(res);
          setLoading(false);
        }
      })
      .catch((e) => {
        if (!cancelled) {
          setError(e);
          setLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [project.id, previewKey]);

  const rebuild = async () => {
    setBuildMsg(null);
    setRebuilding(true);
    try {
      await api.createBuild(project.id);
      notifyBuildsChanged();
      notifyPreviewChanged();
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) setBuildMsg(t('builds.buildActive'));
      else setError(e);
    } finally {
      setRebuilding(false);
    }
  };

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center">
        <Spinner />
      </div>
    );
  }
  if (error) {
    return (
      <div className="p-4">
        <ErrorBox
          message={t(apiErrorKey(error))}
          hint={apiErrorDetail(error) ?? undefined}
          onRetry={() => notifyPreviewChanged()}
        />
      </div>
    );
  }

  const status = info?.status ?? 'none';

  if (status === 'none') {
    return (
      <div className="p-6">
        <Empty
          icon={<Monitor size={32} />}
          title={t('preview.notBuiltTitle')}
          hint={t('preview.notBuiltDesc')}
          action={
            <div className="flex items-center gap-2">
              <Btn variant="primary" size="sm" onClick={() => void rebuild()} disabled={rebuilding}>
                {rebuilding && <Spinner />}
                {t('preview.rebuild')}
              </Btn>
              <Btn variant="outline" size="sm" onClick={() => setWorkspaceTab('builds')}>
                {t('preview.viewLogs')}
              </Btn>
            </div>
          }
        />
        {buildMsg && (
          <p className="mt-3 text-center text-xs text-amber-600 dark:text-amber-400">{buildMsg}</p>
        )}
      </div>
    );
  }

  const ready = status === 'ready';
  const demoDocument = isDemoMode() ? demoPreviewHtml(project.id) : null;
  return (
    <div className="flex h-full flex-col">
      <div className="flex flex-wrap items-center gap-2 border-b border-zinc-200 px-3 py-2 dark:border-zinc-800">
        <Badge tone={ready ? 'green' : 'amber'}>{ready ? t('preview.ready') : t('preview.building')}</Badge>
        <div className="flex items-center gap-0.5 rounded-lg bg-zinc-100 p-0.5 dark:bg-zinc-800">
          {DEVICES.map(({ id, label, Icon }) => (
            <button
              key={id}
              type="button"
              title={t(label)}
              aria-label={t(label)}
              aria-pressed={device === id}
              onClick={() => setDevice(id)}
              className={`flex h-7 w-8 items-center justify-center rounded-md transition-colors ${
                device === id
                  ? 'bg-white text-cyan-600 shadow-sm dark:bg-zinc-700 dark:text-cyan-300'
                  : 'text-zinc-500 hover:text-zinc-800 dark:text-zinc-400 dark:hover:text-zinc-200'
              }`}
            >
              <Icon size={14} />
            </button>
          ))}
        </div>
        <div className="flex-1" />
        <IconBtn label={t('preview.reload')} onClick={() => setReloadKey((k) => k + 1)}>
          <RotateCcw size={15} />
        </IconBtn>
        <IconBtn
          label={t('preview.openStandalone')}
          onClick={() => openProjectPreview(project.id)}
        >
          <ExternalLink size={15} />
        </IconBtn>
      </div>
      {!ready && (
        <p className="border-b border-zinc-200 px-4 py-1.5 text-xs text-zinc-500 dark:border-zinc-800 dark:text-zinc-400">
          {t('preview.loadErrorHint')}
        </p>
      )}
      <div className="min-h-0 flex-1 overflow-auto bg-zinc-200 p-3 dark:bg-zinc-950">
        <div className="mx-auto h-full" style={{ width: DEVICE_WIDTH[device], maxWidth: '100%' }}>
          <iframe
            key={`${previewKey}-${reloadKey}`}
            src={demoDocument ? undefined : previewUrlFor(project.id)}
            srcDoc={demoDocument ?? undefined}
            title="preview"
            sandbox="allow-scripts allow-forms allow-modals"
            className="h-full w-full rounded-md border border-zinc-300 bg-white dark:border-zinc-700"
          />
        </div>
      </div>
    </div>
  );
}

// ------------------------------------------------------------- builds -------

const buildTone: Record<BuildStatus, 'zinc' | 'blue' | 'green' | 'red'> = {
  pending: 'zinc',
  running: 'blue',
  success: 'green',
  failed: 'red',
  cancelled: 'zinc',
};

const buildKey: Record<BuildStatus, TKey> = {
  pending: 'builds.pending',
  running: 'builds.running',
  success: 'builds.success',
  failed: 'builds.failed',
  cancelled: 'builds.cancelled',
};

function BuildBadge({ status }: { status: BuildStatus }) {
  const { t } = useT();
  return <Badge tone={buildTone[status]}>{t(buildKey[status])}</Badge>;
}

function BuildsPane() {
  const { t, lang } = useT();
  const { project, buildsKey, notifyBuildsChanged } = useProjectWork();
  const [searchParams] = useSearchParams();
  const buildParam = searchParams.get('build');
  const [builds, setBuilds] = useState<BuildRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [rebuilding, setRebuilding] = useState(false);
  const [buildMsg, setBuildMsg] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await api.listBuilds(project.id);
      setBuilds(res.items);
      const wanted = buildParam && res.items.some((b) => b.id === buildParam) ? buildParam : null;
      setSelectedId((prev) =>
        prev && res.items.some((b) => b.id === prev) ? prev : (wanted ?? res.items[0]?.id ?? null),
      );
    } catch (e) {
      setError(e);
    } finally {
      setLoading(false);
    }
  }, [project.id, buildParam]);

  useEffect(() => {
    void load();
  }, [load, buildsKey]);

  const rebuild = async () => {
    setBuildMsg(null);
    setRebuilding(true);
    try {
      await api.createBuild(project.id);
      notifyBuildsChanged();
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) setBuildMsg(t('builds.buildActive'));
      else setError(e);
    } finally {
      setRebuilding(false);
    }
  };

  const selected = builds.find((b) => b.id === selectedId) ?? null;

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between gap-2 border-b border-zinc-200 px-3 py-2 dark:border-zinc-800">
        <h2 className="text-sm font-medium text-zinc-800 dark:text-zinc-100">{t('builds.title')}</h2>
        <Btn variant="outline" size="sm" onClick={() => void rebuild()} disabled={rebuilding}>
          {rebuilding && <Spinner />}
          {rebuilding ? t('builds.rebuilding') : t('builds.rebuild')}
        </Btn>
      </div>
      {buildMsg && (
        <p className="border-b border-zinc-200 px-4 py-1.5 text-xs text-amber-600 dark:border-zinc-800 dark:text-amber-400">
          {buildMsg}
        </p>
      )}
      {loading ? (
        <div className="flex flex-1 items-center justify-center">
          <Spinner />
        </div>
      ) : error ? (
        <div className="p-4">
          <ErrorBox
            message={t(apiErrorKey(error))}
            hint={apiErrorDetail(error) ?? undefined}
            onRetry={() => void load()}
          />
        </div>
      ) : builds.length === 0 ? (
        <div className="p-6">
          <Empty
            icon={<Hammer size={32} />}
            title={t('builds.noBuilds')}
            hint={t('builds.noBuildsHint')}
            action={
              <Btn variant="primary" size="sm" onClick={() => void rebuild()} disabled={rebuilding}>
                {rebuilding ? t('builds.rebuilding') : t('builds.rebuild')}
              </Btn>
            }
          />
        </div>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col md:flex-row">
          <div className="max-h-48 shrink-0 overflow-y-auto border-b border-zinc-200 p-2 md:max-h-none md:w-56 md:border-b-0 md:border-r dark:border-zinc-800">
            {builds.map((b) => (
              <button
                key={b.id}
                type="button"
                onClick={() => setSelectedId(b.id)}
                className={`flex w-full items-center justify-between gap-2 rounded-lg px-2.5 py-2 text-left transition-colors ${
                  b.id === selectedId
                    ? 'bg-cyan-500/10'
                    : 'hover:bg-zinc-200/60 dark:hover:bg-zinc-800'
                }`}
              >
                <BuildBadge status={b.status} />
                <span className="text-xs text-zinc-500 dark:text-zinc-400">{timeAgo(b.startedAt, lang)}</span>
              </button>
            ))}
          </div>
          <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-4">
            {!selected ? (
              <Empty title={t('builds.selectBuild')} />
            ) : (
              <>
                <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm">
                  <BuildBadge status={selected.status} />
                  <span className="text-zinc-500 dark:text-zinc-400">
                    {t('builds.startedAt')}:{' '}
                    <span className="text-zinc-800 dark:text-zinc-200">
                      {formatDateTime(selected.startedAt, lang)}
                    </span>
                  </span>
                  <span className="text-zinc-500 dark:text-zinc-400">
                    {t('builds.duration')}:{' '}
                    <span className="text-zinc-800 dark:text-zinc-200">
                      {formatDuration(selected.durationMs)}
                    </span>
                  </span>
                  {selected.artifacts && (
                    <span className="text-zinc-500 dark:text-zinc-400">
                      {t('builds.distSize')}:{' '}
                      <span className="text-zinc-800 dark:text-zinc-200">
                        {formatBytes(selected.artifacts.distSize)}
                      </span>
                    </span>
                  )}
                </div>
                {selected.error && (
                  <div className="rounded-lg border border-red-500/30 bg-red-500/5 p-3 text-sm text-red-700 dark:bg-red-500/10 dark:text-red-300">
                    <p className="mb-1 text-xs font-semibold uppercase tracking-wide">
                      {t('builds.errorTitle')}
                    </p>
                    <p className="whitespace-pre-wrap break-words">{selected.error}</p>
                  </div>
                )}
                <div>
                  <p className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
                    {t('builds.logsTitle')}
                  </p>
                  <pre className="code-scroll max-h-96 overflow-auto rounded-lg bg-zinc-950 p-3 font-mono text-xs leading-relaxed text-zinc-200">
                    {selected.logs || '—'}
                  </pre>
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// --------------------------------------------------------------- code -------

function CodePane() {
  const { t } = useT();
  const { project, setChatDraft } = useProjectWork();
  const [searchParams] = useSearchParams();
  const [tree, setTree] = useState<FileNode[]>([]);
  const [treeLoading, setTreeLoading] = useState(true);
  const [treeError, setTreeError] = useState<unknown>(null);
  const [filter, setFilter] = useState('');
  const [selectedPath, setSelectedPath] = useState<string | null>(() => searchParams.get('path'));
  const [content, setContent] = useState('');
  const [fileLoading, setFileLoading] = useState(false);
  const [fileError, setFileError] = useState<unknown>(null);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [savedNote, setSavedNote] = useState(false);
  const reqRef = useRef(0);

  const loadTree = useCallback(async () => {
    setTreeLoading(true);
    setTreeError(null);
    try {
      const res = await api.listFiles(project.id);
      setTree(res.tree);
    } catch (e) {
      setTreeError(e);
    } finally {
      setTreeLoading(false);
    }
  }, [project.id]);

  useEffect(() => {
    void loadTree();
  }, [loadTree]);

  const selectFile = useCallback(
    async (path: string) => {
      const req = ++reqRef.current;
      setSelectedPath(path);
      setFileLoading(true);
      setFileError(null);
      setDirty(false);
      setSavedNote(false);
      try {
        const res = await api.getFileContent(project.id, path);
        if (reqRef.current === req) setContent(res.content);
      } catch (e) {
        if (reqRef.current === req) {
          setFileError(e);
          setContent('');
        }
      } finally {
        if (reqRef.current === req) setFileLoading(false);
      }
    },
    [project.id],
  );

  const save = async () => {
    if (!selectedPath || saving) return;
    setSaving(true);
    setSavedNote(false);
    try {
      await api.putFileContent(project.id, selectedPath, content);
      setDirty(false);
      setSavedNote(true);
    } catch (e) {
      setFileError(e);
    } finally {
      setSaving(false);
    }
  };

  const download = () => {
    if (!selectedPath) return;
    const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = selectedPath.split('/').pop() ?? 'file';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  };

  const askAI = () => {
    if (!selectedPath) return;
    setChatDraft(t('code.askAIPrompt', { path: selectedPath }));
    window.dispatchEvent(new Event('appforge:focus-chat'));
  };

  return (
    <div className="flex h-full">
      <div className="flex w-60 shrink-0 flex-col border-r border-zinc-200 dark:border-zinc-800">
        <div className="flex items-center justify-between px-3 pt-2">
          <h2 className="text-xs font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
            {t('code.files')}
          </h2>
          <IconBtn label={t('common.refresh')} onClick={() => void loadTree()}>
            <RefreshCw size={14} />
          </IconBtn>
        </div>
        <div className="px-3 py-2">
          <TextInput
            placeholder={t('code.searchFiles')}
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
          />
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-1 pb-3">
          {treeLoading ? (
            <div className="flex justify-center py-6">
              <Spinner />
            </div>
          ) : treeError ? (
            <div className="px-2">
              <ErrorBox
                message={t(apiErrorKey(treeError))}
                hint={apiErrorDetail(treeError) ?? undefined}
                onRetry={() => void loadTree()}
              />
            </div>
          ) : tree.length === 0 ? (
            <p className="px-3 py-4 text-xs text-zinc-400 dark:text-zinc-500">{t('code.emptyTree')}</p>
          ) : (
            <FileTree
              tree={tree}
              selected={selectedPath}
              onSelect={(p) => void selectFile(p)}
              filter={filter}
            />
          )}
        </div>
      </div>

      <div className="flex min-w-0 flex-1 flex-col">
        {!selectedPath ? (
          <div className="p-6">
            <Empty title={t('code.selectFile')} />
          </div>
        ) : (
          <>
            <div className="flex flex-wrap items-center gap-2 border-b border-zinc-200 px-3 py-2 dark:border-zinc-800">
              <span
                className="min-w-0 flex-1 truncate font-mono text-xs text-zinc-600 dark:text-zinc-300"
                title={selectedPath}
              >
                {selectedPath}
              </span>
              {dirty && <Badge tone="amber">{t('code.unsaved')}</Badge>}
              {savedNote && !dirty && (
                <span className="text-xs text-emerald-600 dark:text-emerald-400">{t('code.saved')}</span>
              )}
              <IconBtn label={t('code.save')} onClick={() => void save()} disabled={!dirty || saving}>
                {saving ? <Spinner /> : <Save size={15} />}
              </IconBtn>
              <IconBtn label={t('code.downloadFile')} onClick={download} disabled={fileLoading}>
                <Download size={15} />
              </IconBtn>
              <Btn variant="outline" size="sm" onClick={askAI}>
                <Sparkles size={14} />
                {t('code.askAI')}
              </Btn>
            </div>
            <div className="min-h-0 flex-1">
              {fileLoading ? (
                <div className="flex h-full items-center justify-center">
                  <Spinner />
                </div>
              ) : fileError ? (
                <div className="p-4">
                  <ErrorBox
                    message={t(apiErrorKey(fileError))}
                    hint={apiErrorDetail(fileError) ?? undefined}
                    onRetry={() => void selectFile(selectedPath)}
                  />
                </div>
              ) : (
                <CodeEditor
                  value={content}
                  onChange={(v) => {
                    setContent(v);
                    setDirty(true);
                    setSavedNote(false);
                  }}
                  path={selectedPath}
                />
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

// ------------------------------------------------------------ console -------

const KIND_TONE: Record<RunEventKind, 'blue' | 'zinc' | 'cyan' | 'green' | 'red'> = {
  status: 'blue',
  log: 'zinc',
  tool_call: 'cyan',
  tool_result: 'green',
  done: 'green',
  error: 'red',
};

function truncate(s: string, n = 200): string {
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

function asString(v: unknown): string | null {
  return typeof v === 'string' ? v : null;
}

function dataObj(ev: StreamEvent): Record<string, unknown> {
  return ev.data && typeof ev.data === 'object' ? (ev.data as Record<string, unknown>) : {};
}

function fallbackSummary(ev: StreamEvent): string {
  return truncate(typeof ev.data === 'string' ? ev.data : JSON.stringify(ev.data));
}

/** Resumen legible de una línea para un evento SSE. */
function summarize(ev: StreamEvent): string {
  const d = dataObj(ev);
  switch (ev.kind) {
    case 'status': {
      const joined = [asString(d['phase']), asString(d['message'])].filter(Boolean).join(': ');
      return joined || fallbackSummary(ev);
    }
    case 'log':
      return asString(d['message']) ?? fallbackSummary(ev);
    case 'tool_call': {
      const tool = asString(d['tool']) ?? asString(d['name']) ?? 'tool';
      const args = d['args'] ?? d['input'] ?? d['arguments'];
      const argStr = typeof args === 'string' ? args : JSON.stringify(args ?? '');
      return `${tool}(${truncate(argStr)})`;
    }
    case 'tool_result': {
      const ok = d['ok'] === true;
      const raw = ok ? d['output'] : d['error'];
      if (typeof raw === 'string') return raw || (ok ? 'ok' : 'error');
      return truncate(JSON.stringify(raw ?? (ok ? 'ok' : 'error')));
    }
    case 'done':
      return asString(d['summary']) ?? 'done';
    case 'error':
      return asString(d['message']) ?? 'error';
  }
}

function EventRow({ ev }: { ev: StreamEvent }) {
  const tone =
    ev.kind === 'tool_result'
      ? dataObj(ev)['ok'] === true
        ? 'green'
        : 'red'
      : KIND_TONE[ev.kind];
  return (
    <div className="flex items-start gap-2 rounded-md bg-zinc-50 px-2 py-1.5 text-xs dark:bg-zinc-900">
      <Badge tone={tone}>{ev.kind}</Badge>
      <span className="min-w-0 flex-1 font-mono whitespace-pre-wrap break-words text-zinc-700 dark:text-zinc-300">
        {summarize(ev)}
      </span>
    </div>
  );
}

function ConsolePane() {
  const { t, lang } = useT();
  const { project, events, buildsKey } = useProjectWork();
  const [dismissed, setDismissed] = useState(0);
  const [lastBuild, setLastBuild] = useState<BuildRecord | null | undefined>(undefined);
  const listRef = useRef<HTMLDivElement>(null);

  const visible = events.slice(dismissed);

  useEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [visible]);

  useEffect(() => {
    let cancelled = false;
    api
      .listBuilds(project.id)
      .then((res) => {
        if (!cancelled) setLastBuild(res.items[0] ?? null);
      })
      .catch(() => {
        if (!cancelled) setLastBuild(null);
      });
    return () => {
      cancelled = true;
    };
  }, [project.id, buildsKey]);

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between gap-2 border-b border-zinc-200 px-3 py-2 dark:border-zinc-800">
        <h2 className="text-sm font-medium text-zinc-800 dark:text-zinc-100">
          {t('console.liveTitle')}
        </h2>
        <Btn
          variant="ghost"
          size="sm"
          onClick={() => setDismissed(events.length)}
          disabled={visible.length === 0}
        >
          <Trash2 size={14} />
          {t('console.clear')}
        </Btn>
      </div>
      <div ref={listRef} className="min-h-0 flex-1 space-y-1.5 overflow-y-auto p-3">
        {visible.map((ev) => (
          <EventRow key={ev.seq} ev={ev} />
        ))}
        {visible.length === 0 && lastBuild === null && (
          <Empty
            icon={<TerminalSquare size={32} />}
            title={t('console.noEvents')}
            hint={t('console.noEventsHint')}
          />
        )}
      </div>
      <div className="border-t border-zinc-200 px-3 py-2 dark:border-zinc-800">
        <p className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
          {t('console.lastBuild')}
        </p>
        {lastBuild === undefined ? (
          <div className="py-2">
            <Spinner />
          </div>
        ) : lastBuild ? (
          <>
            <div className="mb-1.5 flex items-center gap-2">
              <BuildBadge status={lastBuild.status} />
              <span className="text-xs text-zinc-500 dark:text-zinc-400">
                {timeAgo(lastBuild.startedAt, lang)}
              </span>
            </div>
            <pre className="code-scroll max-h-48 overflow-auto rounded-lg bg-zinc-950 p-3 font-mono text-xs leading-relaxed text-zinc-200">
              {lastBuild.logs.split('\n').slice(-40).join('\n') || '—'}
            </pre>
          </>
        ) : (
          <p className="text-xs text-zinc-400 dark:text-zinc-500">—</p>
        )}
      </div>
    </div>
  );
}
