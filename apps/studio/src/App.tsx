import { lazy, Suspense } from 'react';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { Analytics } from '@vercel/analytics/react';
import { AgentProvider } from './agent';
import { AuthProvider, useAuth } from './auth';
import { LanguageProvider } from './i18n';
import { ThemeProvider } from './theme';
import { AppLayout } from './layout/AppLayout';
import { Login } from './pages/Login';

const Assets = lazy(() => import('./pages/Assets').then((m) => ({ default: m.Assets })));
const BuildsPage = lazy(() => import('./pages/Builds').then((m) => ({ default: m.BuildsPage })));
const CreateApp = lazy(() => import('./pages/CreateApp').then((m) => ({ default: m.CreateApp })));
const Dashboard = lazy(() => import('./pages/Dashboard').then((m) => ({ default: m.Dashboard })));
const Library = lazy(() => import('./pages/Library').then((m) => ({ default: m.Library })));
const ProjectView = lazy(() => import('./pages/ProjectView').then((m) => ({ default: m.ProjectView })));
const Projects = lazy(() => import('./pages/Projects').then((m) => ({ default: m.Projects })));
const Revisions = lazy(() => import('./pages/Revisions').then((m) => ({ default: m.Revisions })));
const Settings = lazy(() => import('./pages/Settings').then((m) => ({ default: m.Settings })));

function RouteFallback() {
  return (
    <div className="flex min-h-48 items-center justify-center" role="status" aria-label="Loading">
      <span className="h-6 w-6 animate-spin rounded-full border-2 border-zinc-500 border-t-cyan-400" />
    </div>
  );
}

function Shell() {
  const { authRequired, sessionExpired } = useAuth();
  if (authRequired) return <Login sessionExpired={sessionExpired} />;
  return (
    <Suspense fallback={<RouteFallback />}>
      <Routes>
        <Route element={<AppLayout />}>
          <Route index element={<Dashboard />} />
          <Route path="projects" element={<Projects />} />
          <Route path="projects/new" element={<CreateApp />} />
          <Route path="projects/:id" element={<ProjectView />} />
          <Route path="library" element={<Library />} />
          <Route path="assets" element={<Assets />} />
          <Route path="builds" element={<BuildsPage />} />
          <Route path="revisions" element={<Revisions />} />
          <Route path="settings" element={<Settings />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Route>
      </Routes>
    </Suspense>
  );
}

export function App() {
  const analyticsEnabled = import.meta.env.VITE_VERCEL_ANALYTICS === '1';
  return (
    <BrowserRouter>
      <LanguageProvider>
        <ThemeProvider>
          <AuthProvider>
            <AgentProvider>
              <Shell />
              {analyticsEnabled && <Analytics />}
            </AgentProvider>
          </AuthProvider>
        </ThemeProvider>
      </LanguageProvider>
    </BrowserRouter>
  );
}
