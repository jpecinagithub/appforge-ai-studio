import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Info, Wand2 } from 'lucide-react';
import { ApiError, api } from '../api/client';
import { useT } from '../i18n';
import { Btn, Card, ErrorBox, Field, PageHeader, Select, Spinner, TextArea, TextInput } from '../components/ui';
import { apiErrorDetail, apiErrorHintKey, apiErrorKey } from '../utils/errors';

export function CreateApp() {
  const { t } = useT();
  const navigate = useNavigate();
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [type, setType] = useState<'static' | 'dynamic'>('static');
  const [prompt, setPrompt] = useState('');
  const [creating, setCreating] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);

  const submit = async () => {
    if (creating) return;
    if (!name.trim()) {
      setFormError(t('create.errorName'));
      return;
    }
    if (!prompt.trim()) {
      setFormError(t('create.errorPrompt'));
      return;
    }
    setFormError(null);
    setError(null);
    setCreating(true);
    try {
      const project = await api.createProject({
        name: name.trim(),
        description: description.trim() || undefined,
        type,
      });
      try {
        await api.createRun(project.id, prompt.trim());
      } catch (e) {
        if (!(e instanceof ApiError && e.code === 'RUN_ACTIVE')) throw e;
      }
      navigate(`/projects/${project.id}`);
    } catch (e) {
      setError(e);
    } finally {
      setCreating(false);
    }
  };

  const steps = [t('create.step1'), t('create.step2'), t('create.step3'), t('create.step4')];

  return (
    <div>
      <PageHeader title={t('create.title')} subtitle={t('create.subtitle')} />

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <Card className="space-y-4 p-5 lg:col-span-2">
          <Field label={t('create.nameLabel')}>
            <TextInput
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={t('create.namePh')}
              disabled={creating}
            />
          </Field>

          <Field label={`${t('create.descLabel')} (${t('common.optional')})`}>
            <TextInput
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder={t('create.descPh')}
              disabled={creating}
            />
          </Field>

          <Field label={t('create.typeLabel')}>
            <Select value={type} onChange={(e) => setType(e.target.value as 'static' | 'dynamic')} disabled={creating}>
              <option value="static">{t('projects.typeStatic')}</option>
              <option value="dynamic">{t('projects.typeDynamic')}</option>
            </Select>
          </Field>

          <Field label={t('create.promptLabel')} hint={t('create.promptHint')}>
            <TextArea
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder={t('create.promptPh')}
              rows={8}
              disabled={creating}
            />
          </Field>

          {formError && (
            <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-3.5 py-2.5 text-sm text-amber-700 dark:text-amber-300">
              {formError}
            </div>
          )}

          {error != null && (
            <ErrorBox
              message={t(apiErrorKey(error))}
              hint={apiErrorHintKey(error) ? t(apiErrorHintKey(error)!) : (apiErrorDetail(error) ?? undefined)}
            />
          )}

          <Btn variant="primary" onClick={() => void submit()} disabled={creating}>
            {creating ? <Spinner className="h-4 w-4" /> : <Wand2 className="h-4 w-4" />}
            {creating ? t('create.generating') : t('create.generate')}
          </Btn>
        </Card>

        <Card className="h-fit p-5">
          <h2 className="mb-3 text-sm font-semibold text-zinc-900 dark:text-zinc-50">
            {t('create.whatHappens')}
          </h2>
          <ol className="space-y-3">
            {steps.map((s, i) => (
              <li key={i} className="flex items-start gap-3">
                <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-cyan-500/15 text-xs font-semibold text-cyan-700 dark:text-cyan-300">
                  {i + 1}
                </span>
                <span className="text-sm text-zinc-600 dark:text-zinc-300">{s}</span>
              </li>
            ))}
          </ol>
          <div className="mt-4 flex items-start gap-2 rounded-lg bg-zinc-100 p-3 text-xs text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400">
            <Info className="mt-0.5 h-4 w-4 shrink-0" />
            <span>{t('create.note')}</span>
          </div>
        </Card>
      </div>
    </div>
  );
}
