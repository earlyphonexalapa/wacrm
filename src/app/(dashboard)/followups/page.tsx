'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { Activity, CalendarClock, Settings2, ListOrdered } from 'lucide-react';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { useAuth } from '@/hooks/use-auth';
import { canEditSettings, hasMinRole } from '@/lib/auth/roles';
import { ActivityTab } from '@/components/followups/activity-tab';
import { SequencesTab } from '@/components/followups/sequences-tab';
import { SettingsTab } from '@/components/followups/settings-tab';
import { useFollowupLookups } from '@/components/followups/shared';

type Tab = 'sequences' | 'activity' | 'settings';

export default function FollowupsPage() {
  const t = useTranslations('Followups');
  const { accountRole } = useAuth();
  const canEdit = accountRole ? canEditSettings(accountRole) : false;
  const canCancel = accountRole ? hasMinRole(accountRole, 'agent') : false;
  const [tab, setTab] = useState<Tab>('sequences');
  const { tags, templates, reload } = useFollowupLookups();

  return (
    <div>
      <div className="flex items-center gap-2">
        <CalendarClock className="h-6 w-6 text-primary" />
        <h1 className="text-2xl font-bold tracking-tight text-foreground">{t('title')}</h1>
      </div>
      <p className="mt-1 text-sm text-muted-foreground">{t('subtitle')}</p>

      <Tabs value={tab} onValueChange={(v) => setTab(v as Tab)} className="mt-6">
        <TabsList>
          <TabsTrigger value="sequences">
            <ListOrdered className="mr-1.5 h-4 w-4" /> {t('tabSequences')}
          </TabsTrigger>
          <TabsTrigger value="activity">
            <Activity className="mr-1.5 h-4 w-4" /> {t('tabActivity')}
          </TabsTrigger>
          <TabsTrigger value="settings">
            <Settings2 className="mr-1.5 h-4 w-4" /> {t('tabSettings')}
          </TabsTrigger>
        </TabsList>

        <TabsContent value="sequences" className="mt-4">
          <SequencesTab canEdit={canEdit} tags={tags} templates={templates} onTagsChanged={() => void reload()} />
        </TabsContent>
        <TabsContent value="activity" className="mt-4">
          <ActivityTab canCancel={canCancel} />
        </TabsContent>
        <TabsContent value="settings" className="mt-4">
          <SettingsTab canEdit={canEdit} tags={tags} />
        </TabsContent>
      </Tabs>
    </div>
  );
}
