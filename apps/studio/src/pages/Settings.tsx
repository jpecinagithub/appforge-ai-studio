import { useCallback, useEffect, useState } from 'react';
import { Save } from 'lucide-react';
import { API_BASE, api } from '../api/client';
import type { Settings } from '../api/types';
import { useT } from '../i18n';
import { useTheme } from '../theme';
import { Badge, Btn, Card, ErrorBox, Field, PageHeader, Select, Spinner, TextInput, Toggle } from '../components/ui';
import { apiErrorDetail, apiErrorHintKey } from '../utils/errors';

const toNum = (v: string, fallback: number): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
};

export function Settings() {
  const { t, lang, setLang } = useT();
  const { theme, setTheme } = useTheme();
  const [settings, setSettings] = useState<Settings | null>(null);
  const [version, setVersion] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<unknown>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const [provider, setProvider] = useState<'groq' | 'openrouter'>('groq');
  const [model, setModel] = useState('');
  const [temperature, setTemperature] = useState('0.7');
  const [maxTokens, setMaxTokens] = useState('4096');
  const [maxIterations, setMaxIterations] = useState('20');
  const [llmTimeoutMs, setLlmTimeoutMs] = useState('120000');
  const [cmdTimeoutMs, setCmdTimeoutMs] = useState('60000');
  const [runTimeoutMs, setRunTimeoutMs] = useState('600000');
  const [language, setLanguage] = useState<'es' | 'en'>('es');
  const [themeSel, setThemeSel] = useState<'dark' | 'light'>('dark');
  const [autoRevision, setAutoRevision] = useState(true);
  const [autoBuild, setAutoBuild] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [settingsRes, healthRes] = await Promise.allSettled([api.getSettings(), api.health()]);
      if (settingsRes.status !== 'fulfilled') throw settingsRes.reason;
      const s = settingsRes.value;
      setSettings(s);
      setProvider(s.provider);
      setModel(s.model);
      setTemperature(String(s.temperature));
      setMaxTokens(String(s.maxTokens));
      setMaxIterations(String(s.maxIterations));
      setLlmTimeoutMs(String(s.llmTimeoutMs));
      setCmdTimeoutMs(String(s.cmdTimeoutMs));
      setRunTimeoutMs(String(s.runTimeoutMs));
      setLanguage(s.language);
      setThemeSel(s.theme);
      setAutoRevision(s.autoRevision);
      setAutoBuild(s.autoBuild);
      setVersion(healthRes.status === 'fulfilled' ? healthRes.value.version : null);
    } catch (e) {
      setError(e);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const save = async () => {
    if (saving || !settings) return;
    setSaving(true);
    setSaveError(null);
    setNotice(null);
    try {
      const patch: Partial<Settings> = {
        provider,
        model: model.trim(),
        temperature: toNum(temperature, settings.temperature),
        maxTokens: Math.round(toNum(maxTokens, settings.maxTokens)),
        maxIterations: Math.round(toNum(maxIterations, settings.maxIterations)),
        llmTimeoutMs: Math.round(toNum(llmTimeoutMs, settings.llmTimeoutMs)),
        cmdTimeoutMs: Math.round(toNum(cmdTimeoutMs, settings.cmdTimeoutMs)),
        runTimeoutMs: Math.round(toNum(runTimeoutMs, settings.runTimeoutMs)),
        language,
        theme: themeSel,
        autoRevision,
        autoBuild,
      };
      const updated = await api.patchSettings(patch);
      setSettings(updated);
      if (language !== lang) setLang(language);
      if (themeSel !== theme) setTheme(themeSel);
      setNotice(t('settings.saved'));
    } catch (e) {
      setSaveError(e);
    } finally {
      setSaving(false);
    }
  };

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
        message={t('settings.loadError')}
        hint={hintKey ? t(hintKey) : (apiErrorDetail(error) ?? undefined)}
        onRetry={load}
      />
    );
  }

  const secretRows: { key: 'groq' | 'openrouter' | 'vercel'; configured: boolean }[] = settings
    ? [
        { key: 'groq', configured: settings.secrets.groq.configured },
        { key: 'openrouter', configured: settings.secrets.openrouter.configured },
        { key: 'vercel', configured: settings.secrets.vercel.configured },
      ]
    : [];

  return (
    <div>
      <PageHeader
        title={t('settings.title')}
        subtitle={t('settings.subtitle')}
        actions={
          <Btn variant="primary" onClick={() => void save()} disabled={saving}>
            {saving ? <Spinner className="h-4 w-4" /> : <Save className="h-4 w-4" />}
            {saving ? t('common.saving') : t('settings.save')}
          </Btn>
        }
      />

      {notice && (
        <div className="mb-4 rounded-xl border border-emerald-500/30 bg-emerald-500/10 px-4 py-2.5 text-sm text-emerald-700 dark:text-emerald-300">
          {notice}
        </div>
      )}

      {saveError != null && (
        <div className="mb-4">
          <ErrorBox
            message={t('settings.saveError')}
            hint={apiErrorDetail(saveError) ?? undefined}
          />
        </div>
      )}

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Card className="p-5">
          <h2 className="mb-4 text-sm font-semibold text-zinc-900 dark:text-zinc-50">
            {t('settings.aiSection')}
          </h2>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field label={t('settings.provider')}>
              <Select value={provider} onChange={(e) => setProvider(e.target.value as 'groq' | 'openrouter')}>
                <option value="groq">groq</option>
                <option value="openrouter">openrouter</option>
              </Select>
            </Field>
            <Field label={t('settings.model')}>
              <TextInput value={model} onChange={(e) => setModel(e.target.value)} placeholder={t('settings.modelPh')} />
            </Field>
            <Field label={t('settings.temperature')}>
              <TextInput type="number" step={0.1} min={0} max={2} value={temperature} onChange={(e) => setTemperature(e.target.value)} />
            </Field>
            <Field label={t('settings.maxTokens')}>
              <TextInput type="number" min={1} value={maxTokens} onChange={(e) => setMaxTokens(e.target.value)} />
            </Field>
            <Field label={t('settings.maxIterations')}>
              <TextInput type="number" min={1} value={maxIterations} onChange={(e) => setMaxIterations(e.target.value)} />
            </Field>
            <Field label={`${t('settings.llmTimeout')} (${t('settings.ms')})`}>
              <TextInput type="number" min={1000} step={1000} value={llmTimeoutMs} onChange={(e) => setLlmTimeoutMs(e.target.value)} />
            </Field>
            <Field label={`${t('settings.cmdTimeout')} (${t('settings.ms')})`}>
              <TextInput type="number" min={1000} step={1000} value={cmdTimeoutMs} onChange={(e) => setCmdTimeoutMs(e.target.value)} />
            </Field>
            <Field label={`${t('settings.runTimeout')} (${t('settings.ms')})`}>
              <TextInput type="number" min={1000} step={1000} value={runTimeoutMs} onChange={(e) => setRunTimeoutMs(e.target.value)} />
            </Field>
          </div>
        </Card>

        <div className="space-y-4">
          <Card className="p-5">
            <h2 className="mb-4 text-sm font-semibold text-zinc-900 dark:text-zinc-50">
              {t('settings.infraSection')}
            </h2>
            <Field label={t('settings.apiUrl')} hint={t('settings.apiUrlHint')}>
              <TextInput value={API_BASE || '(mismo origen)'} readOnly disabled />
            </Field>
            <div className="mt-4">
              <Field label={t('settings.serverVersion')}>
                <TextInput value={version ?? t('settings.versionUnknown')} readOnly disabled />
              </Field>
            </div>
          </Card>

          <Card className="p-5">
            <h2 className="mb-4 text-sm font-semibold text-zinc-900 dark:text-zinc-50">
              {t('settings.prefsSection')}
            </h2>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <Field label={t('settings.language')}>
                <Select value={language} onChange={(e) => setLanguage(e.target.value as 'es' | 'en')}>
                  <option value="es">Español</option>
                  <option value="en">English</option>
                </Select>
              </Field>
              <Field label={t('settings.theme')}>
                <Select value={themeSel} onChange={(e) => setThemeSel(e.target.value as 'dark' | 'light')}>
                  <option value="dark">{t('settings.themeDark')}</option>
                  <option value="light">{t('settings.themeLight')}</option>
                </Select>
              </Field>
            </div>
            <div className="mt-3 divide-y divide-zinc-100 dark:divide-zinc-800">
              <Toggle checked={autoRevision} onChange={setAutoRevision} label={t('settings.autoRevision')} />
              <Toggle checked={autoBuild} onChange={setAutoBuild} label={t('settings.autoBuild')} />
            </div>
          </Card>

          <Card className="p-5">
            <h2 className="text-sm font-semibold text-zinc-900 dark:text-zinc-50">
              {t('settings.secretsTitle')}
            </h2>
            <p className="mb-3 mt-1 text-xs text-zinc-500 dark:text-zinc-400">{t('settings.secretsHint')}</p>
            <ul className="divide-y divide-zinc-100 dark:divide-zinc-800">
              {secretRows.map(({ key, configured }) => (
                <li key={key} className="flex items-center justify-between py-2.5">
                  <span className="font-mono text-sm text-zinc-700 dark:text-zinc-200">{key}</span>
                  <Badge tone={configured ? 'green' : 'zinc'}>
                    {configured ? t('settings.configured') : t('settings.notConfigured')}
                  </Badge>
                </li>
              ))}
            </ul>
          </Card>
        </div>
      </div>
    </div>
  );
}
