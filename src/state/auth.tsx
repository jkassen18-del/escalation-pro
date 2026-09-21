import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { api, ApiError } from '@/lib/api';
import type { Permission, PublicUser } from '@shared/types';

interface AuthState {
  user: PublicUser | null;
  loading: boolean;
  setupRequired: boolean;
  organizationName: string;
  login: (login: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  completeSetup: (input: {
    name: string;
    email: string;
    password: string;
    organizationName: string;
  }) => Promise<void>;
  refresh: () => Promise<void>;
  can: (permission: Permission) => boolean;
}

const AuthContext = createContext<AuthState | null>(null);

export function useAuth(): AuthState {
  const context = useContext(AuthContext);
  if (!context) throw new Error('useAuth must be used inside <AuthProvider>');
  return context;
}

/** Convenience hook for the common "is this control allowed?" check. */
export function usePermission(permission: Permission): boolean {
  return useAuth().can(permission);
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<PublicUser | null>(null);
  const [loading, setLoading] = useState(true);
  const [setupRequired, setSetupRequired] = useState(false);
  const [organizationName, setOrganizationName] = useState('Escalation Pro');

  const loadSession = useCallback(async () => {
    try {
      const boot = await api.auth.bootstrap();
      setSetupRequired(boot.setupRequired);
      setOrganizationName(boot.organizationName);

      if (boot.setupRequired) {
        setUser(null);
        return;
      }

      const { user: currentUser } = await api.auth.me();
      setUser(currentUser);
    } catch (error) {
      // A 401 here simply means "not signed in", which is not an error state.
      if (!(error instanceof ApiError && error.status === 401)) {
        console.error('[auth] failed to restore session', error);
      }
      setUser(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadSession();
  }, [loadSession]);

  const login = useCallback(async (loginValue: string, password: string) => {
    const { user: signedIn } = await api.auth.login({ login: loginValue, password });
    setUser(signedIn);
    setSetupRequired(false);
  }, []);

  const logout = useCallback(async () => {
    await api.auth.logout();
    setUser(null);
  }, []);

  const completeSetup = useCallback(
    async (input: { name: string; email: string; password: string; organizationName: string }) => {
      const { user: admin } = await api.auth.setup(input);
      setUser(admin);
      setSetupRequired(false);
      setOrganizationName(input.organizationName);
    },
    [],
  );

  const refresh = useCallback(async () => {
    const { user: currentUser } = await api.auth.me();
    setUser(currentUser);
  }, []);

  const can = useCallback(
    (permission: Permission) => Boolean(user?.permissions.includes(permission)),
    [user],
  );

  const value = useMemo<AuthState>(
    () => ({ user, loading, setupRequired, organizationName, login, logout, completeSetup, refresh, can }),
    [user, loading, setupRequired, organizationName, login, logout, completeSetup, refresh, can],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}
