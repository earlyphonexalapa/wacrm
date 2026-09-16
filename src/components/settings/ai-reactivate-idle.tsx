'use client';

import { useState } from 'react';
import { toast } from 'sonner';
import { Loader2, UserCheck } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from '@/components/ui/card';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog';
import { useTranslations } from 'next-intl';

const IDLE_DAY_OPTIONS = [1, 3, 7, 14, 30];

export function AiReactivateIdleCard({ canEdit }: { canEdit: boolean }) {
  const t = useTranslations('Settings.aiReactivateIdle');
  const [idleDays, setIdleDays] = useState(3);
  const [checking, setChecking] = useState(false);
  const [applying, setApplying] = useState(false);
  const [previewCount, setPreviewCount] = useState<number | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);

  const check = async () => {
    setChecking(true);
    setPreviewCount(null);
    try {
      const res = await fetch('/api/ai/reactivate-idle', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ idle_days: idleDays, dry_run: true }),
      });
      const data = await res.json();
      if (!res.ok) {
        toast.error(data.error ?? t('checkFailed'));
        return;
      }
      setPreviewCount(data.count ?? 0);
      if ((data.count ?? 0) > 0) setConfirmOpen(true);
      else toast.info(t('noneFound'));
    } catch {
      toast.error(t('checkFailed'));
    } finally {
      setChecking(false);
    }
  };

  const apply = async () => {
    setApplying(true);
    try {
      const res = await fetch('/api/ai/reactivate-idle', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ idle_days: idleDays, dry_run: false }),
      });
      const data = await res.json();
      if (!res.ok) {
        toast.error(data.error ?? t('applyFailed'));
        return;
      }
      toast.success(t('applySuccess', { count: data.count ?? 0 }));
      setConfirmOpen(false);
      setPreviewCount(null);
    } catch {
      toast.error(t('applyFailed'));
    } finally {
      setApplying(false);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <UserCheck className="h-4 w-4 text-primary" /> {t('title')}
        </CardTitle>
        <CardDescription>{t('description')}</CardDescription>
      </CardHeader>
      <CardContent>
        {canEdit ? (
          <div className="flex flex-wrap items-center gap-3">
            <Select
              value={String(idleDays)}
              onValueChange={(v) => setIdleDays(Number(v))}
              disabled={checking || applying}
            >
              <SelectTrigger className="w-44">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {IDLE_DAY_OPTIONS.map((d) => (
                  <SelectItem key={d} value={String(d)}>
                    {t('idleDaysOption', { count: d })}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button variant="outline" size="sm" onClick={check} disabled={checking || applying}>
              {checking && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              {t('checkButton')}
            </Button>
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">{t('noPermission')}</p>
        )}
      </CardContent>

      <Dialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('confirmTitle')}</DialogTitle>
            <DialogDescription>
              {t('confirmDesc', { count: previewCount ?? 0, days: idleDays })}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              type="button"
              variant="ghost"
              onClick={() => setConfirmOpen(false)}
              disabled={applying}
            >
              {t('cancel')}
            </Button>
            <Button type="button" onClick={apply} disabled={applying}>
              {applying && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              {t('confirmButton', { count: previewCount ?? 0 })}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}
