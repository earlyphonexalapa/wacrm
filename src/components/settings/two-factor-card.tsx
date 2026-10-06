'use client';

import { useCallback, useEffect, useState } from 'react';
import { Loader2, ShieldCheck, ShieldOff } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';

import { TotpEnroll } from '@/components/auth/totp-enroll';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { createClient } from '@/lib/supabase/client';
import { SettingsChip } from './settings-chip';

/**
 * Settings → Login & security: turn two-step verification (authenticator
 * app) on or off. While it's on, opening the CRM asks for a 6-digit code.
 */
export function TwoFactorCard() {
  const t = useTranslations('TwoFactor');
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [enrolling, setEnrolling] = useState(false);
  const [disabling, setDisabling] = useState(false);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const { data } = await createClient().auth.mfa.listFactors();
    setEnabled((data?.totp.length ?? 0) > 0);
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function disable(e: React.FormEvent) {
    e.preventDefault();
    if (code.length !== 6) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/auth/2fa/disable', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code }),
      });
      if (res.ok) {
        toast.success(t('disabledToast'));
        setDisabling(false);
        setCode('');
        await refresh();
        return;
      }
      setError(res.status === 429 ? t('tooMany') : t('invalidCode'));
      setCode('');
    } catch {
      setError(t('invalidCode'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex items-start justify-between gap-3">
          <div>
            <CardTitle>{t('cardTitle')}</CardTitle>
            <CardDescription className="mt-1">{t('cardDesc')}</CardDescription>
          </div>
          {enabled !== null && (
            <SettingsChip variant={enabled ? 'ok' : 'muted'}>
              {enabled ? <ShieldCheck /> : <ShieldOff />}
              {enabled ? t('statusOn') : t('statusOff')}
            </SettingsChip>
          )}
        </div>
      </CardHeader>
      <CardContent>
        {enabled === null ? (
          <Loader2 className="size-5 animate-spin text-primary" />
        ) : enrolling ? (
          <TotpEnroll
            onCancel={() => setEnrolling(false)}
            onDone={() => {
              setEnrolling(false);
              toast.success(t('enabledToast'));
              void refresh();
            }}
          />
        ) : enabled ? (
          disabling ? (
            <form onSubmit={disable} className="max-w-xs space-y-3">
              <p className="text-sm text-muted-foreground">{t('disableDesc')}</p>
              <div className="space-y-1.5">
                <Label htmlFor="totp-disable-code">{t('codeLabel')}</Label>
                <Input
                  id="totp-disable-code"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  maxLength={6}
                  value={code}
                  onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                  className="text-center text-lg tracking-[0.5em]"
                  placeholder="••••••"
                />
              </div>
              {error && <p className="text-sm text-red-400">{error}</p>}
              <div className="flex gap-2">
                <Button type="submit" variant="outline" disabled={busy || code.length !== 6}>
                  {busy && <Loader2 className="size-4 animate-spin" />}
                  {t('disable')}
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  onClick={() => {
                    setDisabling(false);
                    setCode('');
                    setError(null);
                  }}
                  disabled={busy}
                >
                  {t('cancel')}
                </Button>
              </div>
            </form>
          ) : (
            <Button variant="outline" onClick={() => setDisabling(true)}>
              {t('disable')}
            </Button>
          )
        ) : (
          <Button onClick={() => setEnrolling(true)}>{t('enable')}</Button>
        )}
      </CardContent>
    </Card>
  );
}
