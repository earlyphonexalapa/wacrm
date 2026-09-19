'use client';

import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { useTranslations } from 'next-intl';
import { Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { DEFAULT_FOLLOWUP_SETTINGS, type FollowupSettings } from '@/lib/followups/types';
import type { Tag } from '@/types';
import { TagMultiSelect } from './shared';

const TIMEZONES = [
  'America/Mexico_City',
  'America/Bogota',
  'America/Lima',
  'America/Santiago',
  'America/Argentina/Buenos_Aires',
  'America/Caracas',
  'America/New_York',
  'America/Chicago',
  'America/Los_Angeles',
  'Europe/Madrid',
  'UTC',
];

const toTime = (min: number) =>
  `${String(Math.floor(min / 60) % 24).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;

/** "21:00" → 1260. "24:00" isn't valid for <input type=time>, so an
 *  end of midnight is stored as 1440 and shown as 23:59. */
const fromTime = (value: string) => {
  const [h, m] = value.split(':').map(Number);
  return (h || 0) * 60 + (m || 0);
};

export function SettingsTab({ canEdit, tags }: { canEdit: boolean; tags: Tag[] }) {
  const t = useTranslations('Followups.settings');
  const [settings, setSettings] = useState<FollowupSettings>(DEFAULT_FOLLOWUP_SETTINGS);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/followups/settings', { cache: 'no-store' });
      const data = await res.json();
      if (res.ok) setSettings(data.settings);
      else toast.error(data.error ?? t('loadFailed'));
    } catch {
      toast.error(t('loadFailed'));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    void load();
  }, [load]);

  const save = async () => {
    setSaving(true);
    try {
      const res = await fetch('/api/followups/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(settings),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(data.error ?? t('saveFailed'));
        return;
      }
      toast.success(t('saved'));
    } catch {
      toast.error(t('saveFailed'));
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center py-10 text-sm text-muted-foreground">
        <Loader2 className="mr-2 h-4 w-4 animate-spin" /> {t('loading')}
      </div>
    );
  }

  const zones = TIMEZONES.includes(settings.timezone) ? TIMEZONES : [settings.timezone, ...TIMEZONES];
  const set = <K extends keyof FollowupSettings>(key: K, value: FollowupSettings[K]) =>
    setSettings((s) => ({ ...s, [key]: value }));

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle className="text-base">{t('hoursTitle')}</CardTitle>
          <CardDescription>{t('hoursDesc')}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center justify-between gap-4 rounded-md border border-border p-3">
            <div>
              <p className="text-sm font-medium text-foreground">{t('limitHours')}</p>
              <p className="text-xs text-muted-foreground">{t('limitHoursDesc')}</p>
            </div>
            <Switch checked={settings.send_window_enabled} onCheckedChange={(v) => set('send_window_enabled', v)} disabled={!canEdit || saving} />
          </div>

          <div className="grid gap-3 sm:grid-cols-3">
            <div className="space-y-1.5">
              <Label>{t('timezone')}</Label>
              <Select value={settings.timezone} onValueChange={(v) => v && set('timezone', v)} disabled={!canEdit || saving}>
                <SelectTrigger className="w-full">
                  <SelectValue>{settings.timezone}</SelectValue>
                </SelectTrigger>
                <SelectContent>
                  {zones.map((z) => (
                    <SelectItem key={z} value={z}>
                      {z}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="fu-start">{t('from')}</Label>
              <Input id="fu-start" type="time" value={toTime(settings.window_start_min)} onChange={(e) => set('window_start_min', fromTime(e.target.value))} disabled={!canEdit || saving || !settings.send_window_enabled} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="fu-end">{t('until')}</Label>
              <Input id="fu-end" type="time" value={toTime(Math.min(settings.window_end_min, 1439))} onChange={(e) => set('window_end_min', fromTime(e.target.value))} disabled={!canEdit || saving || !settings.send_window_enabled} />
            </div>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">{t('stopTitle')}</CardTitle>
          <CardDescription>{t('stopDesc')}</CardDescription>
        </CardHeader>
        <CardContent>
          {tags.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t('noTags')}</p>
          ) : (
            <TagMultiSelect tags={tags} value={settings.stop_tag_ids} onChange={(v) => set('stop_tag_ids', v)} disabled={!canEdit || saving} />
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">{t('nameTitle')}</CardTitle>
          <CardDescription>{t('nameDesc')}</CardDescription>
        </CardHeader>
        <CardContent>
          <Input value={settings.name_fallback} onChange={(e) => set('name_fallback', e.target.value)} maxLength={40} className="w-full sm:w-64" disabled={!canEdit || saving} />
        </CardContent>
      </Card>

      {canEdit ? (
        <div className="flex justify-end">
          <Button onClick={save} disabled={saving}>
            {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            {t('save')}
          </Button>
        </div>
      ) : (
        <p className="text-xs text-muted-foreground">{t('adminOnly')}</p>
      )}
    </div>
  );
}
