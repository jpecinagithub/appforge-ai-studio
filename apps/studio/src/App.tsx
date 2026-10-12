import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { Analytics } from '@vercel/analytics/react';
import { AgentProvider } from './agent';
import { AuthProvider, useAuth } from './auth';
import { LanguageProvider } from './i18n';
import { ThemeProvider } from './theme';
import { AppLayout } from './layout/AppLayout';
import { Assets } from './pages/Assets';
import { BuildsPage } from './pages/Builds';
import { CreateApp } from './pages/CreateApp';
import { Dashboard } from './pages/Dashboard';
import { Library } from './pages/Library';
import { Login } from './pages/Login';
import { ProjectView } from './pages/ProjectView';
import { Projects } from './pages/Projects';
import { Revisions } from './pages/Revisions';
import { Settings } from './pages/Settings';

function Shell() {
  const { authRequired } = useAuth();
  if (authRequired) return <Login sessionExpired />;
  return (
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
  );
}

export function App() {
  return (
    <BrowserRouter>
      <LanguageProvider>
        <ThemeProvider>
          <AuthProvider>
            <AgentProvider>
              <Shell />
              <Analytics />
            </AgentProvider>
          </AuthProvider>
        </ThemeProvider>
      </LanguageProvider>
    </BrowserRouter>
  );
}
