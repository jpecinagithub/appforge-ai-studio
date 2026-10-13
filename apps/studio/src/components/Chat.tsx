import { useEffect, useRef, useState } from 'react';
import { Bot, MessageCircle, Send } from 'lucide-react';
import { useProjectWork } from '../project/work';
import { useT } from '../i18n';
import type { TKey } from '../i18n/strings';
import { Badge, Btn, Empty, ErrorBox, Spinner, TextArea } from './ui';
import { formatDateTime, formatDuration } from '../utils/format';
import { apiErrorDetail, apiErrorKey } from '../utils/errors';
import type { ChatMessage, Run, RunStatus } from '../api/types';

function roleKey(role: ChatMessage['role']): TKey {
  if (role === 'user') return 'chat.roleUser';
  if (role === 'system') return 'chat.roleSystem';
  return 'chat.roleAssistant';
}

const runBadgeTone: Record<RunStatus, 'amber' | 'blue' | 'green' | 'red' | 'zinc'> = {
  queued: 'amber',
  running: 'blue',
  done: 'green',
  error: 'red',
  cancelled: 'zinc',
};

function runDurationMs(run: Run): number | null {
  const start = run.startedAt ?? run.createdAt;
  const end = run.finishedAt;
  if (!start || !end) return null;
  const ms = new Date(end).getTime() - new Date(start).getTime();
  return Number.isNaN(ms) ? null : ms;
}

function MessageBubble({ message }: { message: ChatMessage }) {
  const { t, lang } = useT();
  if (message.role === 'system') {
    return (
      <div className="my-1 text-center">
        <span className="inline-block rounded-full bg-zinc-200/60 px-3 py-1 text-[11px] text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400">
          {message.content}
        </span>
      </div>
    );
  }
  const mine = message.role === 'user';
  return (
    <div className={`flex ${mine ? 'justify-end' : 'justify-start'}`}>
      <div className={`max-w-[85%] ${mine ? 'text-right' : 'text-left'}`}>
        <div
          className={`mb-1 flex items-center gap-1.5 text-[11px] text-zinc-400 dark:text-zinc-500 ${
            mine ? 'justify-end' : 'justify-start'
          }`}
        >
          {!mine && <Bot size={13} className="text-cyan-500 dark:text-cyan-400" />}
          <span className="font-medium">{t(roleKey(message.role))}</span>
          <span>{formatDateTime(message.createdAt, lang)}</span>
        </div>
        <div
          className={`inline-block rounded-xl px-3 py-2 text-left text-sm whitespace-pre-wrap break-words ${
            mine
              ? 'bg-cyan-500/15 text-zinc-900 dark:bg-cyan-400/15 dark:text-zinc-100'
              : 'border border-zinc-200 bg-white text-zinc-800 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-200'
          }`}
        >
          {message.content}
        </div>
      </div>
    </div>
  );
}

function RunStatusBar() {
  const { t } = useT();
  const { activeRun, cancelRun, events } = useProjectWork();
  const [cancelling, setCancelling] = useState(false);

  if (!activeRun) return null;

  const busy = activeRun.status === 'queued' || activeRun.status === 'running';
  if (busy) {
    const latest = [...events].reverse().find((event) => event.kind === 'status');
    const phase = (latest?.data as { phase?: string } | undefined)?.phase;
    const label = phase === 'validating' ? 'chat.validating' : phase === 'repairing' ? 'chat.repairing' : 'chat.thinking';
    const onCancel = async () => {
      setCancelling(true);
      try {
        await cancelRun();
      } finally {
        setCancelling(false);
      }
    };
    return (
      <div className="flex items-center gap-2 border-t border-zinc-200 bg-zinc-50 px-4 py-2 text-sm dark:border-zinc-800 dark:bg-zinc-900/60">
        <Spinner />
        <span className="flex-1 text-zinc-600 dark:text-zinc-300">{t(label)}</span>
        <Btn variant="ghost" size="sm" onClick={onCancel} disabled={cancelling}>
          {cancelling ? t('chat.cancelling') : t('chat.cancelRun')}
        </Btn>
      </div>
    );
  }

  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-zinc-200 bg-zinc-50 px-4 py-2 text-xs text-zinc-500 dark:border-zinc-800 dark:bg-zinc-900/60 dark:text-zinc-400">
      <Badge tone={runBadgeTone[activeRun.status]}>{t(`run.${activeRun.status}` as TKey)}</Badge>
      {activeRun.stats && (
        <span className="flex flex-wrap items-center gap-x-3">
          <span>
            {t('run.iterations')}: <strong className="font-semibold">{activeRun.stats.iterations}</strong>
          </span>
          <span>
            {t('run.toolCalls')}: <strong className="font-semibold">{activeRun.stats.toolCalls}</strong>
          </span>
          <span>
            {t('run.duration')}: <strong className="font-semibold">{formatDuration(runDurationMs(activeRun))}</strong>
          </span>
        </span>
      )}
      {activeRun.status === 'error' && activeRun.error && (
        <span className="w-full text-red-600 dark:text-red-400">{activeRun.error}</span>
      )}
    </div>
  );
}

export function Chat() {
  const { t } = useT();
  const { messages, events, sendPrompt, sending, chatDraft, setChatDraft } = useProjectWork();
  const [localError, setLocalError] = useState<unknown>(null);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, events, sending]);

  const handleSend = async () => {
    const draft = chatDraft.trim();
    if (!draft || sending) return;
    setLocalError(null);
    try {
      await sendPrompt(draft);
      setChatDraft('');
    } catch (e) {
      setLocalError(e);
    }
  };

  const canSend = chatDraft.trim().length > 0 && !sending;

  return (
    <div className="flex h-full flex-col">
      <div ref={listRef} className="flex-1 space-y-3 overflow-y-auto px-4 py-4">
        {messages.length === 0 ? (
          <Empty
            icon={<MessageCircle size={32} />}
            title={t('chat.welcome')}
            hint={t('chat.welcomeHint')}
          />
        ) : (
          messages.map((m) => <MessageBubble key={m.id} message={m} />)
        )}
      </div>

      <RunStatusBar />

      {localError ? (
        <div className="px-4 pt-2">
          <ErrorBox
            message={t(apiErrorKey(localError))}
            hint={apiErrorDetail(localError) ?? undefined}
          />
        </div>
      ) : null}

      <div className="border-t border-zinc-200 p-3 dark:border-zinc-800">
        <div className="flex items-end gap-2">
          <TextArea
            value={chatDraft}
            onChange={(e) => setChatDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                void handleSend();
              }
            }}
            placeholder={t('chat.inputPh')}
            rows={2}
            disabled={sending}
            className="resize-none"
          />
          <Btn
            variant="primary"
            onClick={() => void handleSend()}
            disabled={!canSend}
            aria-label={t('chat.send')}
            className="shrink-0"
          >
            <Send size={16} />
          </Btn>
        </div>
      </div>
    </div>
  );
}
