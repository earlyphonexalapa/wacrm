'use client';

import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { useTranslations } from 'next-intl';
import {
  AlertTriangle,
  ArrowRight,
  FileText,
  Loader2,
  MessageSquare,
  Pencil,
  Plus,
  Sparkles,
  Trash2,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Switch } from '@/components/ui/switch';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { cn } from '@/lib/utils';
import { formatDelayRange } from '@/lib/followups/timing';
import type { FollowupSequence, SequenceStats } from '@/lib/followups/types';
import type { MessageTemplate, Tag } from '@/types';
import { SequenceEditor } from './sequence-editor';
import { formatRelative, TagChip } from './shared';

interface SchedulerStatus {
  scheduler: { running: boolean; lastTickAt: string | null; lastError: string | null };
  activeEnrollments: number;
  overdue: number;
}

export function SequencesTab({
  canEdit,
  tags,
  templates,
  onTagsChanged,
}: {
  canEdit: boolean;
  tags: Tag[];
  templates: MessageTemplate[];
  onTagsChanged: () => void;
}) {
  const t = useTranslations('Followups.sequences');
  const [sequences, setSequences] = useState<FollowupSequence[]>([]);
  const [stats, setStats] = useState<Record<string, SequenceStats>>({});
  const [statsDays, setStatsDays] = useState(30);
  const [status, setStatus] = useState<SchedulerStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<{ sequence: FollowupSequence | null } | null>(null);
  const [deleting, setDeleting] = useState<FollowupSequence | null>(null);
  const [seeding, setSeeding] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());

  const load = useCallback(async () => {
    try {
      const [seqRes, statusRes] = await Promise.all([
        fetch('/api/followups/sequences', { cache: 'no-store' }),
        fetch('/api/followups/status', { cache: 'no-store' }),
      ]);
      const seqData = await seqRes.json();
      if (seqRes.ok) {
        setSequences(seqData.sequences ?? []);
        setStats(seqData.stats ?? {});
        setStatsDays(seqData.statsWindowDays ?? 30);
      } else {
        toast.error(seqData.error ?? t('loadFailed'));
      }
      if (statusRes.ok) setStatus(await statusRes.json());
      setNow(Date.now());
    } catch {
      toast.error(t('loadFailed'));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    void load();
    const id = setInterval(() => void load(), 30_000);
    return () => clearInterval(id);
  }, [load]);

  const toggle = async (seq: FollowupSequence, next: boolean) => {
    setBusyId(seq.id);
    try {
      const res = await fetch(`/api/followups/sequences/${seq.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ is_active: next }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(data.error ?? t('toggleFailed'));
        return;
      }
      toast.success(next ? t('activated') : t('deactivated'));
      await load();
    } catch {
      toast.error(t('toggleFailed'));
    } finally {
      setBusyId(null);
    }
  };

  const remove = async () => {
    if (!deleting) return;
    setBusyId(deleting.id);
    try {
      const res = await fetch(`/api/followups/sequences/${deleting.id}`, { method: 'DELETE' });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        toast.error(data.error ?? t('deleteFailed'));
        return;
      }
      toast.success(t('deleted'));
      setDeleting(null);
      await load();
    } finally {
      setBusyId(null);
    }
  };

  const seed = async () => {
    setSeeding(true);
    try {
      const res = await fetch('/api/followups/seed', { method: 'POST' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(data.error ?? t('seedFailed'));
        return;
      }
      toast.success(t('seeded', { count: data.sequencesCreated?.length ?? 0 }));
      onTagsChanged();
      await load();
    } catch {
      toast.error(t('seedFailed'));
    } finally {
      setSeeding(false);
    }
  };

  const tagById = (id: string) => tags.find((x) => x.id === id);

  if (loading) {
    return (
      <div className="flex items-center py-10 text-sm text-muted-foreground">
        <Loader2 className="mr-2 h-4 w-4 animate-spin" /> {t('loading')}
      </div>
    );
  }

  // ---- scheduler pill ---------------------------------------------------
  const lastTick = status?.scheduler.lastTickAt ? formatRelative(status.scheduler.lastTickAt, now).text : null;
  const pill = !status
    ? null
    : !status.scheduler.running
      ? { tone: 'amber', text: t('schedulerDown') }
      : status.overdue > 0
        ? { tone: 'amber', text: t('schedulerOverdue', { count: status.overdue }) }
        : { tone: 'green', text: lastTick ? t('schedulerOk', { ago: lastTick }) : t('schedulerStarting') };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        {pill ? (
          <span
            className={cn(
              'inline-flex items-center gap-2 rounded-full border px-3 py-1 text-xs font-medium',
              pill.tone === 'green'
                ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400'
                : 'border-amber-500/40 bg-amber-500/10 text-amber-600 dark:text-amber-400',
            )}
          >
            <span className={cn('h-2 w-2 rounded-full', pill.tone === 'green' ? 'bg-emerald-500' : 'bg-amber-500')} />
            {pill.text}
          </span>
        ) : (
          <span />
        )}
        {canEdit && (
          <Button size="sm" onClick={() => setEditing({ sequence: null })}>
            <Plus className="mr-2 h-4 w-4" /> {t('new')}
          </Button>
        )}
      </div>

      {sequences.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center gap-3 py-10 text-center">
            <Sparkles className="h-8 w-8 text-primary" />
            <div>
              <p className="text-sm font-medium text-foreground">{t('emptyTitle')}</p>
              <p className="mt-1 max-w-md text-xs text-muted-foreground">{t('emptyDesc')}</p>
            </div>
            {canEdit && (
              <div className="flex flex-wrap justify-center gap-2">
                <Button size="sm" onClick={seed} disabled={seeding}>
                  {seeding ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Sparkles className="mr-2 h-4 w-4" />}
                  {t('loadStarter')}
                </Button>
                <Button size="sm" variant="outline" onClick={() => setEditing({ sequence: null })}>
                  {t('startBlank')}
                </Button>
              </div>
            )}
          </CardContent>
        </Card>
      ) : (
        sequences.map((seq) => {
          const st = stats[seq.id];
          const trigger = tagById(seq.trigger_tag_id);
          const needsTemplate = seq.steps.some((s) => s.message_type === 'template' && !s.template_name);
          return (
            <Card key={seq.id} className={cn(!seq.is_active && 'opacity-90')}>
              <CardContent className="space-y-3 py-4">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-semibold text-foreground">{seq.name}</p>
                    {seq.description && <p className="mt-0.5 text-xs text-muted-foreground">{seq.description}</p>}
                  </div>
                  <div className="flex shrink-0 items-center gap-1">
                    {canEdit && (
                      <>
                        <Button variant="ghost" size="sm" className="h-8 w-8 p-0" onClick={() => setEditing({ sequence: seq })} title={t('edit')}>
                          <Pencil className="h-4 w-4" />
                        </Button>
                        <Button variant="ghost" size="sm" className="h-8 w-8 p-0 text-destructive hover:text-destructive" onClick={() => setDeleting(seq)} title={t('delete')}>
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      </>
                    )}
                    <Switch
                      checked={seq.is_active}
                      onCheckedChange={(v) => void toggle(seq, v)}
                      disabled={!canEdit || busyId === seq.id}
                      aria-label={t('activeSwitch')}
                    />
                  </div>
                </div>

                <div className="flex flex-wrap items-center gap-1.5 text-xs">
                  <span className="text-muted-foreground">{t('startsWhen')}</span>
                  <TagChip tag={trigger} />
                  {seq.stop_tag_ids.length > 0 && (
                    <>
                      <span className="ml-1 text-muted-foreground">{t('stopsOn')}</span>
                      {seq.stop_tag_ids.map((id) => (
                        <TagChip key={id} tag={tagById(id)} className="opacity-80" />
                      ))}
                    </>
                  )}
                </div>

                <div className="flex flex-wrap items-center gap-1.5 text-xs">
                  {seq.steps.map((s, i) => (
                    <span key={s.position} className="inline-flex items-center gap-1.5">
                      {i > 0 && <ArrowRight className="h-3 w-3 text-muted-foreground" />}
                      <span
                        className={cn(
                          'inline-flex items-center gap-1 rounded-full border px-2 py-0.5',
                          s.message_type === 'template' ? 'border-amber-500/40 text-amber-500' : 'border-primary/40 text-primary',
                        )}
                      >
                        {s.message_type === 'template' ? <FileText className="h-3 w-3" /> : <MessageSquare className="h-3 w-3" />}
                        {formatDelayRange(s.delay_min_minutes, s.delay_max_minutes)}
                      </span>
                    </span>
                  ))}
                </div>

                {needsTemplate && (
                  <div className="flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 p-2 text-xs text-amber-600 dark:text-amber-400">
                    <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                    <span>{t('needsTemplate')}</span>
                  </div>
                )}

                {st && (
                  <p className="text-xs text-muted-foreground">
                    {t('stats', { active: st.active, sent: st.sent, replied: st.replied, days: statsDays })}
                  </p>
                )}
              </CardContent>
            </Card>
          );
        })
      )}

      {sequences.length > 0 && canEdit && (
        <Button size="sm" variant="ghost" onClick={seed} disabled={seeding} className="text-muted-foreground">
          {seeding ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Sparkles className="mr-2 h-4 w-4" />}
          {t('loadStarterAgain')}
        </Button>
      )}

      {editing && (
        <SequenceEditor
          key={editing.sequence?.id ?? 'new'}
          open
          onOpenChange={(o) => !o && setEditing(null)}
          sequence={editing.sequence}
          tags={tags}
          templates={templates}
          canEdit={canEdit}
          onSaved={() => void load()}
        />
      )}

      <Dialog open={deleting !== null} onOpenChange={(o) => !o && setDeleting(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('deleteTitle')}</DialogTitle>
            <DialogDescription>{t('deleteDesc', { name: deleting?.name ?? '' })}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setDeleting(null)}>
              {t('cancel')}
            </Button>
            <Button variant="destructive" onClick={remove} disabled={busyId !== null}>
              {busyId !== null && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              {t('delete')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
