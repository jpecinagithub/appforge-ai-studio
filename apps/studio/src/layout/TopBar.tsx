import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Download, Loader2, LogOut, Moon, Rocket, Settings as SettingsIcon, Sun } from 'lucide-react';
import { downloadArchive, isDemoMode } from '../api/client';
import { useActiveProject } from '../project/active';
import { useAgent } from '../agent';
import { useAuth } from '../auth';
import { useT } from '../i18n';
import { useTheme } from '../theme';
import { Badge, IconBtn, StatusDot } from '../components/ui';

function Logo() {
  return (
    <Link to="/" className="flex items-center gap-2.5">
      <img src="/icons/icon.svg" alt="AppForge" className="h-8 w-8" />
      <span className="leading-tight">
        <span className="block text-[15px] font-bold tracking-tight text-zinc-900 dark:text-zinc-50">
          AppForge <span className="text-cyan-600 dark:text-cyan-300">AI Studio</span>
        </span>
        <span className="block text-xs text-teal-600 dark:text-teal-400">
          Created by jpecina
        </span>
      </span>
    </Link>
  );
}

export function TopBar() {
  const { t, lang, setLang } = useT();
  const { theme, toggle } = useTheme();
  const { logout } = useAuth();
  const { project } = useActiveProject();
  const { anyWorking } = useAgent();
  const navigate = useNavigate();
  const [downloading, setDownloading] = useState(false);

  const onDownload = async () => {
    if (!project || downloading) return;
    setDownloading(true);
    try {
      await downloadArchive(project);
    } finally {
      setDownloading(false);
    }
  };

  return (
    <header className="flex h-14 shrink-0 items-center justify-between gap-2 border-b border-zinc-200 bg-white/90 px-3 backdrop-blur dark:border-zinc-800 dark:bg-zinc-950/90 md:px-4">
      <div className="flex min-w-0 items-center gap-3">
        <Logo />
        <div className="hidden items-center gap-2 border-l border-zinc-200 pl-3 lg:flex dark:border-zinc-800">
          <span className="text-[11px] uppercase tracking-wide text-zinc-400 dark:text-zinc-500">
            {t('topbar.activeProject')}
          </span>
          {project ? (
            <button
              onClick={() => navigate(`/projects/${project.id}`)}
              className="max-w-56 truncate text-sm font-medium text-zinc-800 hover:text-cyan-600 dark:text-zinc-100 dark:hover:text-cyan-300"
              title={project.name}
            >
              {project.name}
            </button>
          ) : (
            <span className="text-sm text-zinc-400 dark:text-zinc-500">{t('topbar.noProject')}</span>
          )}
        </div>
      </div>

      <div className="flex items-center gap-1 md:gap-1.5">
        {isDemoMode() && (
          <span title={t('topbar.demoTooltip')}>
            <Badge tone="amber" className="mr-1 font-bold tracking-wide">
              {t('topbar.demo')}
            </Badge>
          </span>
        )}

        {/* Estado del agente */}
        <span
          className="mr-1 hidden items-center gap-1.5 rounded-full px-2 py-1 text-xs text-zinc-500 sm:inline-flex dark:text-zinc-400"
          title={anyWorking ? t('topbar.agentWorking') : t('topbar.agentIdle')}
        >
          <StatusDot active={anyWorking} tone={anyWorking ? 'amber' : 'green'} />
          {anyWorking ? t('topbar.agentWorking') : t('topbar.agentIdle')}
        </span>

        {/* Download ZIP (solo con proyecto activo) */}
        {project && (
          <IconBtn label={t('topbar.downloadZip')} onClick={onDownload} disabled={downloading}>
            {downloading ? <Loader2 size={17} className="animate-spin" /> : <Download size={17} />}
          </IconBtn>
        )}

        {/* Deploy: deshabilitado hasta Fase 3 */}
        <span title={t('topbar.deployTooltip')} className="inline-flex items-center">
          <button
            disabled
            className="inline-flex cursor-not-allowed items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-sm text-zinc-400 opacity-60 dark:text-zinc-500"
          >
            <Rocket size={16} />
            <span className="hidden md:inline">{t('topbar.deploy')}</span>
            <Badge tone="zinc" className="text-[10px]">
              Fase 3
            </Badge>
          </button>
        </span>

        {/* Idioma */}
        <div className="flex items-center rounded-lg border border-zinc-200 p-0.5 text-xs font-semibold dark:border-zinc-700">
          {(['es', 'en'] as const).map((l) => (
            <button
              key={l}
              onClick={() => setLang(l)}
              className={`rounded-md px-2 py-1 uppercase transition-colors ${
                lang === l
                  ? 'bg-cyan-500/15 text-cyan-700 dark:text-cyan-300'
                  : 'text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-300'
              }`}
            >
              {l}
            </button>
          ))}
        </div>

        <IconBtn
          label={theme === 'dark' ? t('topbar.themeDark') : t('topbar.themeLight')}
          onClick={toggle}
        >
          {theme === 'dark' ? <Sun size={17} /> : <Moon size={17} />}
        </IconBtn>

        <Link to="/settings" title={t('topbar.settings')} aria-label={t('topbar.settings')}>
          <span className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-zinc-500 transition-colors hover:bg-zinc-200/70 hover:text-zinc-800 dark:text-zinc-400 dark:hover:bg-zinc-800 dark:hover:text-zinc-100">
            <SettingsIcon size={17} />
          </span>
        </Link>

        <IconBtn label={t('topbar.logout')} onClick={logout}>
          <LogOut size={17} />
        </IconBtn>
      </div>
    </header>
  );
}
