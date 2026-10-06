'use client';

import { useEffect, useRef, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { useTranslations } from 'next-intl';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { createClient } from '@/lib/supabase/client';

/**
 * Sets up an authenticator app: shows the QR code, then confirms the first
 * 6-digit code through /api/auth/2fa/verify (which also hands this browser
 * the "verified" cookie, so finishing setup doesn't immediately ask again).
 * Shared by the forced /2fa setup page and Settings → Login & security.
 */
export function TotpEnroll({
  onDone,
  onCancel,
}: {
  onDone: () => void;
  onCancel?: () => void;
}) {
  const t = useTranslations('TwoFactor');
  const [factor, setFactor] = useState<{ id: string; qr: string; secret: string } | null>(null);
  const [failed, setFailed] = useState(false);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const started = useRef(false);

  useEffect(() => {
    // React strict mode runs effects twice in dev; enrolling twice would
    // leave a stray unverified factor behind.
    if (started.current) return;
    started.current = true;

    void (async () => {
      const supabase = createClient();
      // An abandoned earlier attempt is still "unverified" and would block
      // a new one with the same name, so clear those first.
      const { data: existing } = await supabase.auth.mfa.listFactors();
      for (const f of existing?.all ?? []) {
        if (f.factor_type === 'totp' && f.status === 'unverified') {
          await supabase.auth.mfa.unenroll({ factorId: f.id });
        }
      }

      const { data: userData } = await supabase.auth.getUser();
      const label = userData.user?.email ?? 'wacrm';
      let result = await supabase.auth.mfa.enroll({ factorType: 'totp', issuer: 'WaCRM', friendlyName: label });
      if (result.error) {
        result = await supabase.auth.mfa.enroll({
          factorType: 'totp',
          issuer: 'WaCRM',
          friendlyName: `${label} ${Date.now().toString(36)}`,
        });
      }
      if (result.error || !result.data) {
        console.error('[2fa] enroll failed:', result.error);
        setFailed(true);
        return;
      }
      setFactor({
        id: result.data.id,
        qr: result.data.totp.qr_code,
        secret: result.data.totp.secret,
      });
    })();
  }, []);

  async function confirm(e: React.FormEvent) {
    e.preventDefault();
    if (!factor || code.length !== 6) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/auth/2fa/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code, factor_id: factor.id }),
      });
      if (res.ok) {
        onDone();
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

  if (failed) {
    return <p className="text-sm text-red-400">{t('loadFailed')}</p>;
  }
  if (!factor) {
    return (
      <div className="flex items-center justify-center py-8">
        <Loader2 className="size-5 animate-spin text-primary" />
      </div>
    );
  }

  return (
    <form onSubmit={confirm} className="space-y-4">
      <p className="text-sm text-muted-foreground">{t('scanHint')}</p>
      <div className="flex justify-center">
        {/* The QR is a data: SVG from Supabase, not something next/image can optimise. */}
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={factor.qr} alt="" className="size-44 rounded-md bg-white p-2" />
      </div>
      <div className="space-y-1">
        <p className="text-xs text-muted-foreground">{t('manualHint')}</p>
        <code className="block break-all rounded-md bg-muted px-3 py-2 text-xs text-foreground select-all">
          {factor.secret}
        </code>
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="totp-enroll-code">{t('codeLabel')}</Label>
        <Input
          id="totp-enroll-code"
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
        <Button type="submit" disabled={busy || code.length !== 6}>
          {busy && <Loader2 className="size-4 animate-spin" />}
          {busy ? t('verifying') : t('verify')}
        </Button>
        {onCancel && (
          <Button type="button" variant="outline" onClick={onCancel} disabled={busy}>
            {t('cancel')}
          </Button>
        )}
      </div>
    </form>
  );
}
