import { useState } from 'react';
import { Outlet } from 'react-router-dom';
import { ActiveProjectProvider } from '../project/active';
import { MobileNav, Sidebar } from './Sidebar';
import { TopBar } from './TopBar';

export function AppLayout() {
  const [collapsed, setCollapsed] = useState(false);
  return (
    <ActiveProjectProvider>
      <div className="flex h-full flex-col bg-zinc-100 dark:bg-zinc-950">
        <TopBar />
        <div className="flex min-h-0 flex-1">
          <Sidebar collapsed={collapsed} onToggle={() => setCollapsed((c) => !c)} />
          <main className="min-w-0 flex-1 overflow-y-auto">
            <div className="mx-auto max-w-7xl p-4 pb-24 md:p-6 md:pb-10">
              <Outlet />
            </div>
          </main>
        </div>
        <MobileNav />
      </div>
    </ActiveProjectProvider>
  );
}
