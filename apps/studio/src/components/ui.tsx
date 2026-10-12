import type { ButtonHTMLAttributes, ReactNode } from 'react';
import { useT } from '../i18n';

// ---------------------------------------------------------------- botones ---

type BtnVariant = 'primary' | 'ghost' | 'danger' | 'outline' | 'subtle';

interface BtnProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: BtnVariant;
  size?: 'sm' | 'md';
}

const btnVariants: Record<BtnVariant, string> = {
  primary:
    'bg-cyan-500 text-zinc-950 hover:bg-cyan-400 dark:bg-cyan-400 dark:text-zinc-950 dark:hover:bg-cyan-300 font-semibold',
  ghost: 'text-zinc-600 hover:bg-zinc-200/70 dark:text-zinc-300 dark:hover:bg-zinc-800',
  danger: 'bg-red-500/10 text-red-600 hover:bg-red-500/20 dark:text-red-400',
  outline:
    'border border-zinc-300 text-zinc-700 hover:bg-zinc-200/60 dark:border-zinc-700 dark:text-zinc-200 dark:hover:bg-zinc-800',
  subtle: 'bg-zinc-200/70 text-zinc-700 hover:bg-zinc-200 dark:bg-zinc-800 dark:text-zinc-200 dark:hover:bg-zinc-700',
};

export function Btn({ variant = 'outline', size = 'md', className = '', ...rest }: BtnProps) {
  const pad = size === 'sm' ? 'px-2.5 py-1.5 text-xs' : 'px-3.5 py-2 text-sm';
  return (
    <button
      {...rest}
      className={`inline-flex items-center justify-center gap-1.5 rounded-lg ${pad} transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${btnVariants[variant]} ${className}`}
    />
  );
}

interface IconBtnProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  label: string;
}

export function IconBtn({ label, className = '', ...rest }: IconBtnProps) {
  return (
    <button
      {...rest}
      title={label}
      aria-label={label}
      className={`inline-flex h-8 w-8 items-center justify-center rounded-lg text-zinc-500 transition-colors hover:bg-zinc-200/70 hover:text-zinc-800 disabled:cursor-not-allowed disabled:opacity-40 dark:text-zinc-400 dark:hover:bg-zinc-800 dark:hover:text-zinc-100 ${className}`}
    />
  );
}

// ------------------------------------------------------------------ badge ---

type BadgeTone = 'cyan' | 'green' | 'amber' | 'red' | 'zinc' | 'blue' | 'violet';

const badgeTones: Record<BadgeTone, string> = {
  cyan: 'bg-cyan-500/15 text-cyan-700 dark:text-cyan-300',
  green: 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300',
  amber: 'bg-amber-500/15 text-amber-700 dark:text-amber-300',
  red: 'bg-red-500/15 text-red-700 dark:text-red-300',
  zinc: 'bg-zinc-500/15 text-zinc-600 dark:text-zinc-300',
  blue: 'bg-blue-500/15 text-blue-700 dark:text-blue-300',
  violet: 'bg-violet-500/15 text-violet-700 dark:text-violet-300',
};

export function Badge({ tone = 'zinc', children, className = '' }: { tone?: BadgeTone; children: ReactNode; className?: string }) {
  return (
    <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium ${badgeTones[tone]} ${className}`}>
      {children}
    </span>
  );
}

export function StatusDot({ active, tone }: { active?: boolean; tone: BadgeTone }) {
  const colors: Record<BadgeTone, string> = {
    cyan: 'bg-cyan-400',
    green: 'bg-emerald-400',
    amber: 'bg-amber-400',
    red: 'bg-red-400',
    zinc: 'bg-zinc-400',
    blue: 'bg-blue-400',
    violet: 'bg-violet-400',
  };
  return <span className={`inline-block h-2 w-2 rounded-full ${colors[tone]} ${active ? 'af-pulse-dot' : ''}`} />;
}

// ------------------------------------------------------------------- card ---

export function Card({ children, className = '' }: { children: ReactNode; className?: string }) {
  return (
    <div className={`rounded-xl border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900 ${className}`}>
      {children}
    </div>
  );
}

export function PageHeader({ title, subtitle, actions }: { title: string; subtitle?: string; actions?: ReactNode }) {
  return (
    <div className="mb-5 flex flex-wrap items-start justify-between gap-3">
      <div>
        <h1 className="text-xl font-semibold tracking-tight text-zinc-900 dark:text-zinc-50">{title}</h1>
        {subtitle && <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">{subtitle}</p>}
      </div>
      {actions && <div className="flex items-center gap-2">{actions}</div>}
    </div>
  );
}

export function Stat({ label, value, icon }: { label: string; value: string | number; icon?: ReactNode }) {
  return (
    <Card className="flex items-center gap-3 p-4">
      {icon && (
        <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-cyan-500/10 text-cyan-600 dark:text-cyan-300">
          {icon}
        </div>
      )}
      <div>
        <div className="text-2xl font-semibold tracking-tight text-zinc-900 dark:text-zinc-50">{value}</div>
        <div className="text-xs text-zinc-500 dark:text-zinc-400">{label}</div>
      </div>
    </Card>
  );
}

// -------------------------------------------------------------- formularios ---

const inputCls =
  'w-full rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-900 placeholder:text-zinc-400 focus:border-cyan-500 focus:outline-none focus:ring-1 focus:ring-cyan-500 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100 dark:placeholder:text-zinc-500';

export function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-xs font-medium uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
        {label}
      </span>
      {children}
      {hint && <span className="mt-1 block text-xs text-zinc-400 dark:text-zinc-500">{hint}</span>}
    </label>
  );
}

export function TextInput(props: React.InputHTMLAttributes<HTMLInputElement>) {
  return <input {...props} className={`${inputCls} ${props.className ?? ''}`} />;
}

export function TextArea(props: React.TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea {...props} className={`${inputCls} ${props.className ?? ''}`} />;
}

export function Select(props: React.SelectHTMLAttributes<HTMLSelectElement>) {
  return <select {...props} className={`${inputCls} ${props.className ?? ''}`} />;
}

export function Toggle({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      onClick={() => onChange(!checked)}
      className="flex w-full items-center justify-between gap-3 py-1 text-left"
    >
      <span className="text-sm text-zinc-700 dark:text-zinc-200">{label}</span>
      <span
        className={`relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors ${checked ? 'bg-cyan-500' : 'bg-zinc-300 dark:bg-zinc-700'}`}
      >
        <span
          className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${checked ? 'translate-x-4' : 'translate-x-0.5'}`}
        />
      </span>
    </button>
  );
}

// ------------------------------------------------------------------ varios ---

export function Spinner({ className = '' }: { className?: string }) {
  return (
    <span
      className={`inline-block h-4 w-4 animate-spin rounded-full border-2 border-zinc-300 border-t-cyan-500 dark:border-zinc-600 dark:border-t-cyan-400 ${className}`}
      aria-hidden
    />
  );
}

export function Empty({ icon, title, hint, action }: { icon?: ReactNode; title: string; hint?: string; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-zinc-300 px-6 py-12 text-center dark:border-zinc-700">
      {icon && <div className="mb-1 text-zinc-400 dark:text-zinc-500">{icon}</div>}
      <p className="text-sm font-medium text-zinc-700 dark:text-zinc-200">{title}</p>
      {hint && <p className="max-w-sm text-xs text-zinc-500 dark:text-zinc-400">{hint}</p>}
      {action && <div className="mt-3">{action}</div>}
    </div>
  );
}

export function ErrorBox({ message, hint, onRetry }: { message: string; hint?: string; onRetry?: () => void }) {
  const { t } = useT();
  return (
    <div className="rounded-xl border border-red-500/30 bg-red-500/5 p-4 dark:bg-red-500/10">
      <p className="text-sm font-medium text-red-700 dark:text-red-300">{message}</p>
      {hint && <p className="mt-1 text-xs text-red-600/80 dark:text-red-400/80">{hint}</p>}
      {onRetry && (
        <Btn variant="outline" size="sm" className="mt-3" onClick={onRetry}>
          {t('common.retry')}
        </Btn>
      )}
    </div>
  );
}

export function Modal({
  title,
  onClose,
  children,
  footer,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
}) {
  const { t } = useT();
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" role="dialog" aria-modal="true">
      <div className="absolute inset-0 bg-black/60" onClick={onClose} />
      <div className="af-fade-up relative w-full max-w-md rounded-xl border border-zinc-200 bg-white p-5 shadow-xl dark:border-zinc-700 dark:bg-zinc-900">
        <h2 className="text-base font-semibold text-zinc-900 dark:text-zinc-50">{title}</h2>
        <div className="mt-3 text-sm text-zinc-600 dark:text-zinc-300">{children}</div>
        <div className="mt-5 flex justify-end gap-2">
          <Btn variant="ghost" onClick={onClose}>
            {t('common.cancel')}
          </Btn>
          {footer}
        </div>
      </div>
    </div>
  );
}
