import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { PageHeader } from '@/components/PageHeader';
import { OnCallTabs, type DirectoryPerson } from '@/components/ops/OnCallShared';
import { OnCallNow } from '@/components/ops/OnCallNow';
import { ScheduleTab, loadPeople } from '@/components/ops/ScheduleTab';
import { PolicyTab } from '@/components/ops/PolicyTab';
import { OnCallPhone } from '@/components/ops/OnCallPhone';
import { useAuth } from '@/state/auth';
import { useDocumentTitle } from '@/state/branding';
import type { Team } from '@shared/types';

type Tab = 'now' | 'schedules' | 'policies' | 'phone';

export function OnCallPage() {
  useDocumentTitle('On-call');
  const { can } = useAuth();
  const [tab, setTab] = useState<Tab>('now');
  const [people, setPeople] = useState<DirectoryPerson[]>([]);
  const [teams, setTeams] = useState<Team[]>([]);

  useEffect(() => {
    void loadPeople()
      .then(setPeople)
      .catch(() => setPeople([]));
    void api.teams
      .list()
      .then((result) => setTeams(result.teams))
      .catch(() => setTeams([]));
  }, []);

  const tabs: Array<{ value: Tab; label: string }> = [
    { value: 'now', label: 'Now' },
    { value: 'schedules', label: 'Schedules' },
    { value: 'policies', label: 'Escalation policies' },
    ...(can('oncall.manage') ? [{ value: 'phone' as const, label: 'Phone & SMS' }] : []),
  ];

  return (
    <div>
      <PageHeader title="On-call" description="Who is on call, what is paging them, and how alerts escalate until someone acknowledges.">
        <OnCallTabs value={tab} onChange={setTab} tabs={tabs} />
      </PageHeader>
      {tab === 'now' && <OnCallNow people={people} />}
      {tab === 'schedules' && <ScheduleTab people={people} teams={teams} />}
      {tab === 'policies' && <PolicyTab people={people} teams={teams} />}
      {tab === 'phone' && can('oncall.manage') && <OnCallPhone />}
    </div>
  );
}
