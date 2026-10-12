import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { MessageSquareText, PanelRight } from 'lucide-react';
import { ApiError, api } from '../api/client';
import { subscribeRunEvents } from '../api/sse';
import type { StreamEvent } from '../api/sse';
import type { ChatMessage, Project, Run } from '../api/types';
import { useActiveProject } from '../project/active';
import { ProjectWorkProvider } from '../project/work';
import type { WorkspaceTab } from '../project/work';
import { useAgent } from '../agent';
import { Chat } from '../components/Chat';
import { Workspace } from '../components/Workspace';
import { useT } from '../i18n';
import { Badge, ErrorBox, Spinner } from '../components/ui';
import { timeAgo } from '../utils/format';
import { apiErrorDetail, apiErrorKey } from '../utils/errors';

const VALID_TABS: WorkspaceTab[] = ['preview', 'builds', 'code', 'console'];

export function ProjectView() {
  const { id } = useParams<{ id: string }>();
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const { t, lang } = useT();
  const { setProject } = useActiveProject();
  const { setRunStatus } = useAgent();

  const [project, setProjectState] = useState<Project | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [activeRun, setActiveRun] = useState<Run | null>(null);
  const [events, setEvents] = useState<StreamEvent[]>([]);
  const [sending, setSending] = useState(false);
  const [chatDraft, setChatDraft] = useState('');
  const [buildsKey, setBuildsKey] = useState(0);
  const [previewKey, setPreviewKey] = useState(0);
  const [workspaceTab, setWorkspaceTab] = useState<WorkspaceTab>(() => {
    const q = searchParams.get('tab') as WorkspaceTab | null;
    return q && VALID_TABS.includes(q) ? q : 'preview';
  });
  const [mobileTab, setMobileTab] = useState<'chat' | 'workspace'>('chat');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const unsubRef = useRef<(() => void) | null>(null);
  const projectIdRef = useRef<string | null>(null);

  const stopSubscription = useCallback(() => {
    unsubRef.current?.();
    unsubRef.current = null;
  }, []);

  const reloadMessages = useCallback(async () => {
    if (!id) return;
    const res = await api.listMessages(id);
    setMessages(res.items);
  }, [id]);

  const finalizeRun = useCallback(
    async (runId: string) => {
      if (!id) return;
      try {
        const final = await api.getRun(runId);
        if (projectIdRef.current === id) setActiveRun(final);
      } catch {
        /* conserva el último estado conocido */
      }
      setRunStatus(id, null);
      try {
        await reloadMessages();
      } catch {
        /* noop */
      }
      if (projectIdRef.current === id) {
        setBuildsKey((k) => k + 1);
        setPreviewKey((k) => k + 1);
      }
    },
    [id, reloadMessages, setRunStatus],
  );

  const subscribe = useCallback(
    (run: Run) => {
      if (!id) return;
      stopSubscription();
      setEvents([]);
      unsubRef.current = subscribeRunEvents(run.id, {
        onEvent: (ev) => {
          if (projectIdRef.current !== id) return;
          setEvents((prev) => [...prev, ev]);
          if (ev.kind === 'done' || ev.kind === 'error') {
            stopSubscription();
            void finalizeRun(run.id);
          }
        },
        onError: () => {
          /* el stream se cierra; el estado final se recupera con getRun */
          if (projectIdRef.current === id) void finalizeRun(run.id);
        },
        onClose: () => {
          /* noop: done/error ya finalizan */
        },
      });
    },
    [id, stopSubscription, finalizeRun],
  );

  const sendPrompt = useCallback(
    async (prompt: string) => {
      if (!id) return;
      if (activeRun && (activeRun.status === 'queued' || activeRun.status === 'running')) {
        throw new ApiError('RUN_ACTIVE', 409);
      }
      setSending(true);
      try {
        await api.postMessage(id, { role: 'user', content: prompt });
        setChatDraft('');
        await reloadMessages();
        const run = await api.createRun(id, prompt);
        setActiveRun(run);
        setRunStatus(id, run.status);
        subscribe(run);
      } finally {
        setSending(false);
      }
    },
    [id, activeRun, reloadMessages, subscribe, setRunStatus],
  );

  const cancelRun = useCallback(async () => {
    if (!id || !activeRun) return;
    try {
      await api.cancelRun(activeRun.id);
    } finally {
      stopSubscription();
      setRunStatus(id, null);
      try {
        const final = await api.getRun(activeRun.id);
        if (projectIdRef.current === id) setActiveRun(final);
      } catch {
        /* noop */
      }
    }
  }, [id, activeRun, stopSubscription, setRunStatus]);

  // Carga inicial + reanuda un run activo si existe.
  useEffect(() => {
    if (!id) return;
    projectIdRef.current = id;
    setLoading(true);
    setError(null);
    setEvents([]);
    setActiveRun(null);
    stopSubscription();
    (async () => {
      try {
        const p = await api.getProject(id);
        if (projectIdRef.current !== id) return;
        setProjectState(p);
        setProject(p);
        const m = await api.listMessages(id);
        if (projectIdRef.current !== id) return;
        setMessages(m.items);
        const r = await api.listRuns(id);
        if (projectIdRef.current !== id) return;
        const active = r.items.find((x) => x.status === 'queued' || x.status === 'running') ?? null;
        setActiveRun(active);
        if (active) {
          setRunStatus(id, active.status);
          subscribe(active);
        }
      } catch (e) {
        if (projectIdRef.current === id) setError(e);
      } finally {
        if (projectIdRef.current === id) setLoading(false);
      }
    })();
    return () => {
      stopSubscription();
      setProject(null);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  // "Pedir cambio con IA" → en móvil vuelve a la pestaña del chat.
  useEffect(() => {
    const onFocusChat = () => setMobileTab('chat');
    window.addEventListener('appforge:focus-chat', onFocusChat);
    return () => window.removeEventListener('appforge:focus-chat', onFocusChat);
  }, []);

  if (loading) {
    return (
      <div className="flex h-64 items-center justify-center">
        <Spinner />
      </div>
    );
  }

  if (error || !project) {
    return (
      <div className="mx-auto max-w-lg pt-10">
        <ErrorBox
          message={t(apiErrorKey(error))}
          hint={apiErrorDetail(error) ?? undefined}
          onRetry={() => navigate('/projects')}
        />
      </div>
    );
  }

  const work = {
    project,
    messages,
    reloadMessages,
    activeRun,
    events,
    sendPrompt,
    cancelRun,
    sending,
    chatDraft,
    setChatDraft,
    buildsKey,
    previewKey,
    notifyBuildsChanged: () => setBuildsKey((k) => k + 1),
    notifyPreviewChanged: () => setPreviewKey((k) => k + 1),
    workspaceTab,
    setWorkspaceTab,
  };

  return (
    <ProjectWorkProvider value={work}>
      <div className="flex flex-col gap-3 md:h-[calc(100dvh-6.5rem)]">
        {/* Cabecera compacta del proyecto */}
        <div className="flex flex-wrap items-center gap-2">
          <button
            onClick={() => navigate('/projects')}
            className="text-xs text-zinc-500 hover:text-cyan-600 dark:text-zinc-400 dark:hover:text-cyan-300"
          >
            {t('nav.projects')}
          </button>
          <span className="text-xs text-zinc-400">/</span>
          <h1 className="truncate text-base font-semibold text-zinc-900 dark:text-zinc-50">{project.name}</h1>
          <Badge tone={project.type === 'dynamic' ? 'violet' : 'blue'}>
            {t(project.type === 'dynamic' ? 'projects.typeDynamic' : 'projects.typeStatic')}
          </Badge>
          <Badge tone="zinc">
            {t(project.status === 'archived' ? 'projects.statusArchived' : 'projects.statusActive')}
          </Badge>
          <span className="text-xs text-zinc-400 dark:text-zinc-500">
            {t('common.updatedAt')}: {timeAgo(project.updatedAt, lang)}
          </span>
        </div>

        {/* Selector móvil Chat / Workspace */}
        <div className="grid grid-cols-2 gap-1 rounded-xl border border-zinc-200 bg-white p-1 md:hidden dark:border-zinc-800 dark:bg-zinc-900">
          {(
            [
              { key: 'chat', icon: <MessageSquareText size={15} />, label: 'Chat' },
              { key: 'workspace', icon: <PanelRight size={15} />, label: t('ws.workspace') },
            ] as const
          ).map((tab) => (
            <button
              key={tab.key}
              onClick={() => setMobileTab(tab.key)}
              className={`flex items-center justify-center gap-1.5 rounded-lg px-3 py-2 text-sm font-medium transition-colors ${
                mobileTab === tab.key
                  ? 'bg-cyan-500/15 text-cyan-700 dark:text-cyan-300'
                  : 'text-zinc-500 dark:text-zinc-400'
              }`}
            >
              {tab.icon}
              {tab.label}
            </button>
          ))}
        </div>

        <div className="grid min-h-0 flex-1 gap-4 md:grid-cols-[minmax(0,5fr)_minmax(0,7fr)]">
          <section
            aria-label="Chat"
            className={`${
              mobileTab === 'chat' ? 'flex' : 'hidden'
            } h-[calc(100dvh-15rem)] min-h-0 flex-col overflow-hidden rounded-xl border border-zinc-200 bg-white md:flex md:h-auto dark:border-zinc-800 dark:bg-zinc-900`}
          >
            <Chat />
          </section>
          <section
            aria-label={t('ws.workspace')}
            className={`${
              mobileTab === 'workspace' ? 'flex' : 'hidden'
            } h-[calc(100dvh-15rem)] min-h-0 flex-col overflow-hidden rounded-xl border border-zinc-200 bg-white md:flex md:h-auto dark:border-zinc-800 dark:bg-zinc-900`}
          >
            <Workspace />
          </section>
        </div>
      </div>
    </ProjectWorkProvider>
  );
}
