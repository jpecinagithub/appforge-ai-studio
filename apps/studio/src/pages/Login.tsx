import { useState } from 'react';
import { FlaskConical, KeyRound } from 'lucide-react';
import { setDemoMode } from '../api/client';
import { useAuth } from '../auth';
import { useT } from '../i18n';
import { Btn, Card, Field, TextInput } from '../components/ui';

export function Login({ sessionExpired }: { sessionExpired?: boolean }) {
  const { t } = useT();
  const { setToken } = useAuth();
  const [value, setValue] = useState('');
  const [error, setError] = useState(false);

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!value.trim()) {
      setError(true);
      return;
    }
    setToken(value.trim());
  };

  const enterDemo = () => {
    setDemoMode(true);
    window.location.reload();
  };

  return (
    <div className="flex h-full items-center justify-center bg-zinc-100 p-4 dark:bg-zinc-950">
      <Card className="af-fade-up w-full max-w-sm p-6">
        <div className="mb-5 flex flex-col items-center text-center">
          <img src="/icons/icon.svg" alt="AppForge" className="mb-3 h-12 w-12" />
          <h1 className="text-lg font-bold tracking-tight text-zinc-900 dark:text-zinc-50">
            AppForge <span className="text-cyan-600 dark:text-cyan-300">AI Studio</span>
          </h1>
          <p className="mt-1 text-sm text-teal-600 dark:text-teal-400">
            {t('brand.tagline')}
          </p>
          <p className="mt-2 text-sm text-zinc-500 dark:text-zinc-400">{t('login.subtitle')}</p>
        </div>

        {sessionExpired && (
          <p className="mb-4 rounded-lg bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-300">
            {t('login.sessionExpired')}
          </p>
        )}

        <form onSubmit={submit} className="space-y-4">
          <Field label={t('login.tokenLabel')}>
            <div className="relative">
              <KeyRound size={15} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-zinc-400" />
              <TextInput
                type="password"
                value={value}
                onChange={(e) => {
                  setValue(e.target.value);
                  setError(false);
                }}
                placeholder={t('login.tokenPlaceholder')}
                className="pl-9"
                autoComplete="off"
              />
            </div>
          </Field>
          {error && <p className="text-xs text-red-600 dark:text-red-400">{t('login.errorRequired')}</p>}
          <Btn type="submit" variant="primary" className="w-full">
            {t('login.saveToken')}
          </Btn>
          <button
            type="button"
            onClick={() => setToken(null)}
            className="w-full text-center text-xs text-zinc-500 underline-offset-2 hover:underline dark:text-zinc-400"
          >
            {t('login.continueWithout')}
          </button>
          <p className="text-center text-[11px] text-zinc-400 dark:text-zinc-500">{t('login.continueHint')}</p>
        </form>

        <div className="my-5 border-t border-zinc-200 dark:border-zinc-800" />

        <div className="text-center">
          <p className="text-sm font-medium text-zinc-700 dark:text-zinc-200">{t('login.demoTitle')}</p>
          <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">{t('login.demoDesc')}</p>
          <Btn variant="outline" size="sm" className="mt-3" onClick={enterDemo}>
            <FlaskConical size={14} />
            {t('login.useDemo')}
          </Btn>
        </div>
      </Card>
    </div>
  );
}
