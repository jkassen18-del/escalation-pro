import { Checkbox } from '@/components/ui/Field';
import type { Permission } from '@shared/types';

export interface PermissionGroup {
  label: string;
  permissions: Array<{ key: Permission; label: string; hint: string }>;
}

/**
 * Grouped permission checkboxes, shared by the role editor and a person's
 * extra permissions.
 *
 * `locked` are shown ticked and cannot be changed (a person's role already
 * grants them). `grantable` limits what can be switched on to what the
 * person editing holds themselves; anything else is shown but disabled, as
 * the server would refuse it.
 */
export function PermissionPicker({
  groups,
  value,
  onChange,
  locked = [],
  grantable,
  readOnly = false,
}: {
  groups: PermissionGroup[];
  value: Permission[];
  onChange: (next: Permission[]) => void;
  locked?: Permission[];
  grantable?: Permission[];
  readOnly?: boolean;
}) {
  const canToggle = (key: Permission) =>
    !readOnly && !locked.includes(key) && (value.includes(key) || !grantable || grantable.includes(key));

  const toggle = (key: Permission) => onChange(value.includes(key) ? value.filter((item) => item !== key) : [...value, key]);

  return (
    <div className="space-y-4">
      {groups.map((group) => {
        const switchable = group.permissions.map((permission) => permission.key).filter(canToggle);
        const allOn = switchable.length > 0 && switchable.every((key) => value.includes(key));
        return (
          <div key={group.label}>
            <div className="mb-1.5 flex items-center justify-between gap-2">
              <p className="eyebrow">{group.label}</p>
              {!readOnly && switchable.length > 0 && (
                <button
                  type="button"
                  className="text-2xs text-[var(--accent)] hover:underline"
                  onClick={() =>
                    onChange(
                      allOn
                        ? value.filter((key) => !switchable.includes(key))
                        : Array.from(new Set([...value, ...switchable])),
                    )
                  }
                >
                  {allOn ? 'Clear all' : 'Select all'}
                </button>
              )}
            </div>
            <div className="grid gap-2 sm:grid-cols-2">
              {group.permissions.map((permission) => {
                const isLocked = locked.includes(permission.key);
                return (
                  <Checkbox
                    key={permission.key}
                    checked={isLocked || value.includes(permission.key)}
                    disabled={!canToggle(permission.key)}
                    onChange={() => toggle(permission.key)}
                    label={permission.label}
                    hint={isLocked ? `${permission.hint} · from the role` : permission.hint}
                  />
                );
              })}
            </div>
          </div>
        );
      })}
    </div>
  );
}
