import { useEffect, useMemo, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { api, ApiError } from '@/lib/api';
import { useToast } from '@/components/ui/Toast';
import { Button } from '@/components/ui/Button';
import { Select } from '@/components/ui/Field';
import type { LinearTeamMapping, Team } from '@shared/types';

interface Row {
  linearTeamId: string;
  linearTeamKey: string | null;
  linearTeamName: string | null;
  teamId: string;
  isPrimary: boolean;
}

/**
 * Every Linear team, and the department its issues belong to.
 *
 * Issues raised in a linked Linear team become tickets for that department.
 * Several Linear teams can feed one department; the primary one is where
 * that department's tickets are mirrored out to.
 */
export function LinearTeamMap({ apiKey }: { apiKey?: string }) {
  const toast = useToast();
  const [rows, setRows] = useState<Row[]>([]);
  const [teams, setTeams] = useState<Team[]>([]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [loadedFromLinear, setLoadedFromLinear] = useState(false);

  useEffect(() => {
    void Promise.all([api.integrations.linearTeamMap(), api.teams.list()])
      .then(([map, teamList]) => {
        setRows(map.mappings.map((mapping) => ({ ...mapping })));
        setTeams(teamList.teams);
      })
      .catch(() => undefined);
  }, []);

  const loadFromLinear = async () => {
    setLoading(true);
    try {
      const result = await api.integrations.linearTeams(apiKey || undefined);
      // Keep what is already linked, and add every Linear team not yet listed.
      setRows((current) => {
        const byId = new Map(current.map((row) => [row.linearTeamId, row]));
        const merged = result.teams.map((team) => ({
          linearTeamId: team.id,
          linearTeamKey: team.key,
          linearTeamName: team.name,
          teamId: byId.get(team.id)?.teamId ?? '',
          isPrimary: byId.get(team.id)?.isPrimary ?? false,
        }));
        const stale = current.filter((row) => !result.teams.some((team) => team.id === row.linearTeamId));
        return [...merged, ...stale];
      });
      setLoadedFromLinear(true);
      if (!result.teams.length) toast.error('That key works, but it can see no teams in Linear.');
    } catch (caught) {
      toast.error('Could not load Linear teams', caught instanceof ApiError ? caught.message : 'Linear could not be reached.');
    } finally {
      setLoading(false);
    }
  };

  const save = async () => {
    setSaving(true);
    try {
      const mappings: LinearTeamMapping[] = rows
        .filter((row) => row.teamId)
        .map((row) => ({ ...row, isPrimary: row.isPrimary }));
      const result = await api.integrations.saveLinearTeamMap(mappings);
      const saved = new Map(result.mappings.map((mapping) => [mapping.linearTeamId, mapping]));
      setRows((current) => current.map((row) => ({ ...row, isPrimary: saved.get(row.linearTeamId)?.isPrimary ?? false })));
      toast.success('Team links saved', `${result.mappings.length} Linear team(s) linked to departments.`);
    } catch (caught) {
      toast.error('Could not save the team links', caught instanceof ApiError ? caught.message : undefined);
    } finally {
      setSaving(false);
    }
  };

  // How many Linear teams point at each department: the primary choice only matters past one.
  const counts = useMemo(() => {
    const map = new Map<string, number>();
    for (const row of rows) if (row.teamId) map.set(row.teamId, (map.get(row.teamId) ?? 0) + 1);
    return map;
  }, [rows]);

  const update = (linearTeamId: string, patch: Partial<Row>) =>
    setRows((current) =>
      current.map((row) => {
        if (row.linearTeamId === linearTeamId) return { ...row, ...patch };
        // Only one primary per department.
        if (patch.isPrimary && row.teamId === current.find((r) => r.linearTeamId === linearTeamId)?.teamId) {
          return { ...row, isPrimary: false };
        }
        return row;
      }),
    );

  return (
    <div className="rounded-sm border surface-2">
      <div className="flex flex-wrap items-start justify-between gap-2 border-b px-3 py-2.5">
        <div className="min-w-0">
          <p className="text-xs font-medium">Team mapping</p>
          <p className="mt-0.5 text-2xs text-muted">
            Link each Linear team to a department here. Issues raised in a linked Linear team become tickets for that department,
            and the department's tickets are mirrored to its primary Linear team.
          </p>
        </div>
        <Button variant="secondary" size="sm" loading={loading} onClick={() => void loadFromLinear()}>
          <RefreshCw className="size-3.5" aria-hidden />
          {loadedFromLinear ? 'Reload Linear teams' : 'Load Linear teams'}
        </Button>
      </div>

      {rows.length === 0 ? (
        <p className="px-3 py-4 text-2xs text-subtle">Load your Linear teams to link them to departments.</p>
      ) : (
        <ul className="divide-y">
          {rows.map((row) => {
            const shared = row.teamId && (counts.get(row.teamId) ?? 0) > 1;
            return (
              <li key={row.linearTeamId} className="flex flex-wrap items-center gap-x-3 gap-y-1.5 px-3 py-2">
                <div className="min-w-0 flex-1 basis-40">
                  <p className="truncate text-xs">
                    {row.linearTeamKey && <span className="mr-1.5 font-mono text-2xs text-subtle">{row.linearTeamKey}</span>}
                    {row.linearTeamName ?? row.linearTeamId}
                  </p>
                </div>
                <Select
                  value={row.teamId}
                  onChange={(event) => update(row.linearTeamId, { teamId: event.target.value, isPrimary: false })}
                  className="w-full sm:w-56"
                  aria-label={`Department for ${row.linearTeamName ?? row.linearTeamId}`}
                >
                  <option value="">Not linked</option>
                  {teams.map((team) => (
                    <option key={team.id} value={team.id}>
                      {team.name}
                    </option>
                  ))}
                </Select>
                {shared ? (
                  <label className="flex cursor-pointer items-center gap-1.5 text-2xs text-muted sm:w-32">
                    <input
                      type="radio"
                      name={`primary-${row.teamId}`}
                      checked={row.isPrimary}
                      onChange={() => update(row.linearTeamId, { isPrimary: true })}
                      className="accent-[var(--accent)]"
                    />
                    Mirror tickets here
                  </label>
                ) : (
                  // Keeps the selects in one column whether or not a row has the choice.
                  <span className="hidden sm:block sm:w-32" aria-hidden />
                )}
              </li>
            );
          })}
        </ul>
      )}

      {rows.length > 0 && (
        <div className="flex justify-end border-t px-3 py-2">
          <Button variant="primary" size="sm" loading={saving} onClick={() => void save()}>
            Save team links
          </Button>
        </div>
      )}
    </div>
  );
}
