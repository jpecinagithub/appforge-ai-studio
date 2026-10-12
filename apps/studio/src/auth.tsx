import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { getToken, setToken as persistToken } from './api/client';

interface AuthContextValue {
  token: string | null;
  setToken: (t: string | null) => void;
  /** true cuando hay que mostrar la pantalla de login (401 recibido o logout). */
  authRequired: boolean;
  logout: () => void;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [token, setTokenState] = useState<string | null>(() => getToken());
  const [authRequired, setAuthRequired] = useState(false);

  const setToken = useCallback((t: string | null) => {
    persistToken(t);
    setTokenState(t);
    setAuthRequired(false);
  }, []);

  const logout = useCallback(() => {
    persistToken(null);
    setTokenState(null);
    setAuthRequired(true);
  }, []);

  useEffect(() => {
    const onUnauthorized = () => {
      persistToken(null);
      setTokenState(null);
      setAuthRequired(true);
    };
    window.addEventListener('appforge:unauthorized', onUnauthorized);
    return () => window.removeEventListener('appforge:unauthorized', onUnauthorized);
  }, []);

  const value = useMemo(
    () => ({ token, setToken, authRequired, logout }),
    [token, setToken, authRequired, logout],
  );
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside AuthProvider');
  return ctx;
}
