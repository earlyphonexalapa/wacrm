'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { toast } from 'sonner';
import { useTranslations } from 'next-intl';
import { CheckCircle2, Clock, Loader2, RefreshCw, SkipForward, XCircle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { cn } from '@/lib/utils';
import { formatRelative, formatRemaining } from './shared';

interface Enrollment {
  id: string;
  status: 'active' | 'completed' | 'cancelled';
  cancel_reason: string | null;
  next_step_position: number;
  next_run_at: string;
  last_sent_at: string | null;
  ended_at: string | null;
  step_count: number;
  conversation_id: string;
  contact: { id: string; name: string | null; phone: string } | null;
  sequence: { id: string; name: string } | null;
  window: { open: boolean; remaining_ms: number } | null;
}

interface SendLog {
  id: string;
  step_position: number;
  status: 'sent' | 'skipped' | 'failed';
  detail: string | null;
  created_at: string;
  contact: { name: string | null; phone: string } | null;
  sequence_name: string | null;
}

type Filter = 'active' | 'completed' | 'cancelled' | 'all';

const contactLabel = (c: { name: string | null; phone: string } | null) =>
  c ? c.name?.trim() || c.phone : '—';

export function ActivityTab({ canCancel }: { canCancel: boolean }) {
  const t = useTranslations('Followups.activity');
  const [filter, setFilter] = useState<Filter>('active');
  const [rows, setRows] = useState<Enrollment[]>([]);
  const [sends, setSends] = useState<SendLog[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());

  const load = useCallback(async () => {
    try {
      const [enrRes, sendRes] = await Promise.all([
        fetch(`/api/followups/enrollments?status=${filter}`, { cache: 'no-store' }),
        fetch('/api/followups/sends', { cache: 'no-store' }),
      ]);
      const enr = await enrRes.json();
      if (enrRes.ok) setRows(enr.enrollments ?? []);
      else toast.error(enr.error ?? t('loadFailed'));
      if (sendRes.ok) setSends((await sendRes.json()).sends ?? []);
      setNow(Date.now());
    } catch {
      toast.error(t('loadFailed'));
    } finally {
      setLoading(false);
    }
  }, [filter, t]);

  useEffect(() => {
    setLoading(true);
    void load();
    const id = setInterval(() => void load(), 30_000);
    return () => clearInterval(id);
  }, [load]);

  const cancel = async (id: string) => {
    setBusyId(id);
    try {
      const res = await fetch(`/api/followups/enrollments/${id}/cancel`, { method: 'POST' });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        toast.error(data.error ?? t('cancelFailed'));
        return;
      }
      toast.success(t('cancelled'));
      await load();
    } finally {
      setBusyId(null);
    }
  };

  const reason = (r: string | null) => (r ? t(`reason_${r}` as never) : '');

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Select value={filter} onValueChange={(v) => setFilter((v ?? 'active') as Filter)}>
          <SelectTrigger className="w-44">
            <SelectValue>{t(`filter_${filter}` as never)}</SelectValue>
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="active">{t('filter_active')}</SelectItem>
            <SelectItem value="completed">{t('filter_completed')}</SelectItem>
            <SelectItem value="cancelled">{t('filter_cancelled')}</SelectItem>
            <SelectItem value="all">{t('filter_all')}</SelectItem>
          </SelectContent>
        </Select>
        <Button variant="ghost" size="sm" onClick={() => void load()} className="text-muted-foreground">
          <RefreshCw className="mr-2 h-4 w-4" /> {t('refresh')}
        </Button>
      </div>

      {loading ? (
        <div className="flex items-center py-8 text-sm text-muted-foreground">
          <Loader2 className="mr-2 h-4 w-4 animate-spin" /> {t('loading')}
        </div>
      ) : rows.length === 0 ? (
        <p className="rounded-lg border border-dashed border-border py-10 text-center text-sm text-muted-foreground">{t('empty')}</p>
      ) : (
        <ul className="space-y-2">
          {rows.map((r) => {
            const next = formatRelative(r.next_run_at, now);
            return (
              <li key={r.id} className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border bg-card px-4 py-3">
                <div className="min-w-0">
                  <Link href={`/inbox?c=${r.conversation_id}`} className="truncate text-sm font-medium text-foreground hover:underline">
                    {contactLabel(r.contact)}
                  </Link>
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    {r.sequence?.name ?? '—'} · {t('stepOf', { n: Math.min(r.next_step_position + 1, r.step_count || 1), total: r.step_count })}
                  </p>
                </div>

                <div className="flex flex-wrap items-center gap-2">
                  {r.status === 'active' && (
                    <>
                      <span className="inline-flex items-center gap-1 rounded-full border border-border px-2.5 py-1 text-xs text-muted-foreground" title={new Date(r.next_run_at).toLocaleString()}>
                        <Clock className="h-3 w-3" />
                        {next.future ? t('nextIn', { time: next.text }) : t('overdueBy', { time: next.text })}
                      </span>
                      {r.window && (
                        <span
                          className={cn(
                            'rounded-full border px-2.5 py-1 text-xs font-medium',
                            r.window.open ? 'border-primary/30 bg-primary/10 text-primary' : 'border-destructive/30 bg-destructive/10 text-destructive',
                          )}
                          title={t('windowTitle')}
                        >
                          {r.window.open ? t('windowRemaining', { time: formatRemaining(r.window.remaining_ms) }) : t('windowClosed')}
                        </span>
                      )}
                      {canCancel && (
                        <Button variant="ghost" size="sm" onClick={() => void cancel(r.id)} disabled={busyId === r.id} className="text-muted-foreground">
                          {busyId === r.id ? <Loader2 className="h-4 w-4 animate-spin" /> : t('cancel')}
                        </Button>
                      )}
                    </>
                  )}
                  {r.status === 'completed' && (
                    <span className="inline-flex items-center gap-1 rounded-full border border-emerald-500/30 bg-emerald-500/10 px-2.5 py-1 text-xs text-emerald-600 dark:text-emerald-400">
                      <CheckCircle2 className="h-3 w-3" /> {t('completed')}
                    </span>
                  )}
                  {r.status === 'cancelled' && (
                    <span className="inline-flex items-center gap-1 rounded-full border border-border bg-muted px-2.5 py-1 text-xs text-muted-foreground">
                      <XCircle className="h-3 w-3" /> {reason(r.cancel_reason) || t('cancelledLabel')}
                    </span>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">{t('recentTitle')}</CardTitle>
        </CardHeader>
        <CardContent>
          {sends.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t('recentEmpty')}</p>
          ) : (
            <ul className="divide-y divide-border">
              {sends.map((s) => (
                <li key={s.id} className="flex items-start gap-3 py-2.5">
                  {s.status === 'sent' ? (
                    <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-500" />
                  ) : s.status === 'skipped' ? (
                    <SkipForward className="mt-0.5 h-4 w-4 shrink-0 text-amber-500" />
                  ) : (
                    <XCircle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
                  )}
                  <div className="min-w-0 flex-1">
                    <p className="text-sm text-foreground">
                      <span className="font-medium">{contactLabel(s.contact)}</span>
                      <span className="text-muted-foreground"> · {s.sequence_name ?? '—'} · {t('stepN', { n: s.step_position + 1 })}</span>
                    </p>
                    {s.detail && <p className="mt-0.5 text-xs text-muted-foreground">{s.detail}</p>}
                  </div>
                  <span className="shrink-0 text-xs text-muted-foreground" title={new Date(s.created_at).toLocaleString()}>
                    {t('ago', { time: formatRelative(s.created_at, now).text })}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
