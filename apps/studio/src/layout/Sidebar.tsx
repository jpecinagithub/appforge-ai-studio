import { NavLink } from 'react-router-dom';
import {
  ChevronLeft,
  ChevronRight,
  FolderKanban,
  Hammer,
  History,
  Image,
  LayoutDashboard,
  Library,
  PlusCircle,
  Settings,
} from 'lucide-react';
import { useT } from '../i18n';
import type { TKey } from '../i18n/strings';

interface NavItem {
  to: string;
  key: TKey;
  icon: React.ReactNode;
}

const ITEMS: NavItem[] = [
  { to: '/', key: 'nav.dashboard', icon: <LayoutDashboard size={18} /> },
  { to: '/projects', key: 'nav.projects', icon: <FolderKanban size={18} /> },
  { to: '/projects/new', key: 'nav.createApp', icon: <PlusCircle size={18} /> },
  { to: '/library', key: 'nav.library', icon: <Library size={18} /> },
  { to: '/assets', key: 'nav.assets', icon: <Image size={18} /> },
  { to: '/builds', key: 'nav.builds', icon: <Hammer size={18} /> },
  { to: '/revisions', key: 'nav.revisions', icon: <History size={18} /> },
  { to: '/settings', key: 'nav.settings', icon: <Settings size={18} /> },
];

export function Sidebar({ collapsed, onToggle }: { collapsed: boolean; onToggle: () => void }) {
  const { t } = useT();
  return (
    <aside
      className={`hidden shrink-0 flex-col border-r border-zinc-200 bg-white transition-[width] dark:border-zinc-800 dark:bg-zinc-950 md:flex ${
        collapsed ? 'w-16' : 'w-56'
      }`}
    >
      <nav className="flex-1 space-y-0.5 overflow-y-auto p-2">
        {ITEMS.map((item) => (
          <NavLink
            key={item.to}
            to={item.to}
            end={item.to === '/'}
            title={t(item.key)}
            className={({ isActive }) =>
              `flex items-center gap-3 rounded-lg px-3 py-2 text-sm transition-colors ${
                isActive
                  ? 'bg-cyan-500/10 font-medium text-cyan-700 dark:text-cyan-300'
                  : 'text-zinc-600 hover:bg-zinc-100 hover:text-zinc-900 dark:text-zinc-400 dark:hover:bg-zinc-900 dark:hover:text-zinc-100'
              } ${collapsed ? 'justify-center px-0' : ''}`
            }
          >
            <span className="shrink-0">{item.icon}</span>
            {!collapsed && <span className="truncate">{t(item.key)}</span>}
          </NavLink>
        ))}
      </nav>
      <div className="border-t border-zinc-200 p-2 dark:border-zinc-800">
        <button
          onClick={onToggle}
          title={collapsed ? t('nav.expand') : t('nav.collapse')}
          aria-label={collapsed ? t('nav.expand') : t('nav.collapse')}
          className="flex w-full items-center justify-center rounded-lg px-3 py-2 text-zinc-500 hover:bg-zinc-100 dark:text-zinc-400 dark:hover:bg-zinc-900"
        >
          {collapsed ? <ChevronRight size={18} /> : <ChevronLeft size={18} />}
        </button>
      </div>
    </aside>
  );
}

/** Barra inferior de iconos para móvil. */
export function MobileNav() {
  const { t } = useT();
  // En móvil: navegación esencial + chat como pantalla principal (vista proyecto).
  const mobileItems = ITEMS.filter((i) =>
    ['/', '/projects', '/projects/new', '/library', '/settings'].includes(i.to),
  );
  return (
    <nav className="fixed inset-x-0 bottom-0 z-40 flex items-stretch justify-around border-t border-zinc-200 bg-white/95 pb-[env(safe-area-inset-bottom)] backdrop-blur dark:border-zinc-800 dark:bg-zinc-950/95 md:hidden">
      {mobileItems.map((item) => (
        <NavLink
          key={item.to}
          to={item.to}
          end={item.to === '/'}
          aria-label={t(item.key)}
          className={({ isActive }) =>
            `flex flex-1 flex-col items-center gap-0.5 py-2 text-[10px] ${
              isActive ? 'text-cyan-600 dark:text-cyan-300' : 'text-zinc-500 dark:text-zinc-400'
            }`
          }
        >
          {item.icon}
          <span className="max-w-16 truncate">{t(item.key)}</span>
        </NavLink>
      ))}
    </nav>
  );
}
