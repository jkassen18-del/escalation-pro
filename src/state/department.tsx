import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { api } from '@/lib/api';
import { useAuth } from '@/state/auth';
import type { Team } from '@shared/types';

/** "all": every department this person may see. Otherwise a department id. */
export type DepartmentScope = 'all' | string;

interface DepartmentState {
  /** Every department, so the selector can show the locked ones too. */
  departments: Team[];
  /** The departments this person may open: their own, or all of them with tickets.view_all. */
  accessible: Team[];
  scope: DepartmentScope;
  /** The selected department, or null for "all". */
  current: Team | null;
  setScope: (scope: DepartmentScope) => void;
  canOpen: (teamId: string) => boolean;
  reload: () => Promise<void>;
}

const DepartmentContext = createContext<DepartmentState | null>(null);
const STORAGE_KEY = 'escalation-pro.department';

function readStored(): string | null {
  try {
    return localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

/**
 * The department the app is looking at. Chosen in the top bar; pages that
 * work per department (tickets, the command centre, on-call, schedules,
 * handovers, integrations) follow it. It narrows what is shown - it never
 * widens it: the server still decides what each person may see.
 */
export function DepartmentProvider({ children }: { children: ReactNode }) {
  const { user, can } = useAuth();
  const [departments, setDepartments] = useState<Team[]>([]);
  const [scope, setScopeState] = useState<DepartmentScope>(() => readStored() ?? 'all');

  const reload = useCallback(async () => {
    try {
      setDepartments((await api.teams.list()).teams);
    } catch {
      setDepartments([]);
    }
  }, []);

  useEffect(() => {
    if (user) void reload();
  }, [user, reload]);

  const seesAll = can('tickets.view_all');
  const canOpen = useCallback((teamId: string) => seesAll || Boolean(user?.teamIds.includes(teamId)), [seesAll, user]);
  const accessible = useMemo(() => departments.filter((team) => canOpen(team.id)), [departments, canOpen]);

  // A remembered department that no longer exists, or is no longer open to them, falls back to all.
  useEffect(() => {
    if (!departments.length || scope === 'all') return;
    if (!accessible.some((team) => team.id === scope)) setScopeState('all');
  }, [departments, accessible, scope]);

  const setScope = useCallback(
    (next: DepartmentScope) => {
      if (next !== 'all' && !canOpen(next)) return;
      setScopeState(next);
      try {
        localStorage.setItem(STORAGE_KEY, next);
      } catch {
        // A private window: the choice lasts for this visit only.
      }
    },
    [canOpen],
  );

  const value = useMemo<DepartmentState>(
    () => ({
      departments,
      accessible,
      scope,
      current: scope === 'all' ? null : (departments.find((team) => team.id === scope) ?? null),
      setScope,
      canOpen,
      reload,
    }),
    [departments, accessible, scope, setScope, canOpen, reload],
  );

  return <DepartmentContext.Provider value={value}>{children}</DepartmentContext.Provider>;
}

export function useDepartment(): DepartmentState {
  const context = useContext(DepartmentContext);
  if (!context) throw new Error('useDepartment must be used inside <DepartmentProvider>');
  return context;
}
