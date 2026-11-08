'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { AlertTriangle, CheckCircle2, Loader2, Smartphone } from 'lucide-react';
import { useTranslations } from 'next-intl';

import { Button } from '@/components/ui/button';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { parseSignupData, type SignupResult } from '@/lib/whatsapp/coexistence';
import type { WhatsAppConfig } from '@/types';

// ---- Facebook JS SDK, loaded only when the admin opens this screen ------------------------------

const SDK_URL = 'https://connect.facebook.net/en_US/sdk.js';
const SDK_VERSION = 'v27.0';

interface FbLoginResponse {
  authResponse?: { code?: string } | null;
}
interface FbSdk {
  init: (opts: Record<string, unknown>) => void;
  login: (cb: (response: FbLoginResponse) => void, opts: Record<string, unknown>) => void;
}
declare global {
  interface Window {
    FB?: FbSdk;
    fbAsyncInit?: () => void;
  }
}

let sdkPromise: Promise<FbSdk> | null = null;
function loadFacebookSdk(appId: string): Promise<FbSdk> {
  if (sdkPromise) return sdkPromise;
  sdkPromise = new Promise<FbSdk>((resolve, reject) => {
    const init = () => {
      if (!window.FB) return reject(new Error('sdk'));
      window.FB.init({ appId, autoLogAppEvents: true, xfbml: true, version: SDK_VERSION });
      resolve(window.FB);
    };
    if (window.FB) return init();
    window.fbAsyncInit = init;
    const script = document.createElement('script');
    script.src = SDK_URL;
    script.async = true;
    script.defer = true;
    script.crossOrigin = 'anonymous';
    script.onerror = () => reject(new Error('sdk'));
    document.body.appendChild(script);
  }).catch((err) => {
    sdkPromise = null; // let the next click try again
    throw err;
  });
  return sdkPromise;
}

interface SignupConfig {
  configured: boolean;
  missing: string[];
  appId: string | null;
  configId: string | null;
}

interface Props {
  config: WhatsAppConfig | null;
  /** Called after the number was saved, so the page reloads its state. */
  onConnected: () => void | Promise<void>;
}

export function WhatsAppCoexistenceCard({ config, onConnected }: Props) {
  const t = useTranslations('Settings.whatsapp.coexistence');
  const [setup, setSetup] = useState<SignupConfig | null>(null);
  const [phase, setPhase] = useState<'idle' | 'popup' | 'saving'>('idle');

  // What the popup reported through postMessage (it can land before or after
  // the login callback, so both are collected and joined).
  const finishedRef = useRef<SignupResult | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch('/api/whatsapp/embedded-signup')
      .then((r) => (r.ok ? r.json() : null))
      .then((data: SignupConfig | null) => {
        if (!cancelled) setSetup(data);
      })
      .catch(() => {
        if (!cancelled) setSetup(null);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    function onMessage(event: MessageEvent) {
      if (typeof event.origin !== 'string' || !event.origin.endsWith('facebook.com')) return;
      try {
        const payload = typeof event.data === 'string' ? JSON.parse(event.data) : event.data;
        if (payload?.type !== 'WA_EMBEDDED_SIGNUP') return;
        if (typeof payload.event === 'string' && payload.event.startsWith('FINISH')) {
          finishedRef.current = parseSignupData(payload.data);
        } else if (payload.event === 'CANCEL') {
          toast.message(t('cancelled'));
        } else if (payload.event === 'ERROR') {
          toast.error(t('metaError', { message: payload.data?.error_message ?? '' }));
        }
      } catch {
        // not a JSON message from the popup
      }
    }
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [t]);

  const finish = useCallback(
    async (code: string) => {
      setPhase('saving');
      try {
        // The popup's own "finished" message usually arrives within a moment
        // of the login callback; give it a few seconds.
        for (let i = 0; i < 20 && !finishedRef.current; i++) {
          await new Promise((resolve) => setTimeout(resolve, 300));
        }
        const done = finishedRef.current;
        const res = await fetch('/api/whatsapp/embedded-signup', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            code,
            waba_id: done?.wabaId ?? null,
            phone_number_id: done?.phoneNumberId ?? null,
            business_id: done?.businessId ?? null,
          }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          toast.error(data.error || t('saveFailed'), { duration: 12000 });
          return;
        }
        toast.success(t('success'));
        for (const warning of (data.warnings ?? []) as string[]) {
          toast.warning(warning, { duration: 12000 });
        }
        await onConnected();
      } catch (err) {
        console.error('[embedded-signup] finish failed:', err);
        toast.error(t('saveFailed'));
      } finally {
        finishedRef.current = null;
        setPhase('idle');
      }
    },
    [onConnected, t],
  );

  async function handleConnect() {
    if (!setup?.appId || !setup.configId) return;
    finishedRef.current = null;
    setPhase('popup');
    let fb: FbSdk;
    try {
      fb = await loadFacebookSdk(setup.appId);
    } catch {
      toast.error(t('sdkFailed'));
      setPhase('idle');
      return;
    }
    fb.login(
      (response) => {
        const code = response.authResponse?.code;
        if (code) {
          void finish(code);
        } else {
          // Closed or declined in the popup.
          setPhase('idle');
        }
      },
      {
        config_id: setup.configId,
        response_type: 'code',
        override_default_response_type: true,
        extras: {
          setup: {},
          // Connect a number that is already in the WhatsApp Business app.
          featureType: 'whatsapp_business_app_onboarding',
          sessionInfoVersion: '3',
        },
      },
    );
  }

  const busy = phase !== 'idle';
  const connected = config?.coexistence === true && config.status === 'connected';
  const history = config?.history_sync_status ?? 'none';

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-foreground flex items-center gap-2">
          <Smartphone className="size-4 text-primary" />
          {t('title')}
        </CardTitle>
        <CardDescription className="text-muted-foreground">{t('description')}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {connected && (
          <Alert className="bg-emerald-950/30 border-emerald-700/50">
            <div className="flex items-center gap-2">
              <CheckCircle2 className="size-4 text-emerald-400" />
              <AlertTitle className="mb-0 text-emerald-200">{t('connectedTitle')}</AlertTitle>
            </div>
            <AlertDescription className="mt-1 text-xs text-muted-foreground">
              {t('connectedBody')}
              <br />
              {t('historyLabel')}:{' '}
              {history === 'in_progress'
                ? t('history.in_progress', { progress: config?.history_sync_progress ?? 0 })
                : t(`history.${history}`)}
            </AlertDescription>
          </Alert>
        )}

        {config?.coexistence === true && config.status !== 'connected' && (
          <Alert className="bg-amber-950/30 border-amber-700/50">
            <div className="flex items-center gap-2">
              <AlertTriangle className="size-4 text-amber-400" />
              <AlertTitle className="mb-0 text-amber-200">{t('disconnectedTitle')}</AlertTitle>
            </div>
            <AlertDescription className="mt-1 text-xs text-muted-foreground">
              {t('disconnectedBody')}
            </AlertDescription>
          </Alert>
        )}

        <ul className="list-disc space-y-1 pl-5 text-xs text-muted-foreground">
          <li>{t('req1')}</li>
          <li>{t('req2')}</li>
          <li>{t('req3')}</li>
        </ul>

        {config && !config.coexistence && (
          <p className="text-xs text-amber-500">{t('replaceWarning')}</p>
        )}

        {setup && !setup.configured ? (
          <Alert className="bg-amber-950/30 border-amber-700/50">
            <div className="flex items-center gap-2">
              <AlertTriangle className="size-4 text-amber-400" />
              <AlertTitle className="mb-0 text-amber-200">{t('notConfiguredTitle')}</AlertTitle>
            </div>
            <AlertDescription className="mt-1 text-xs text-muted-foreground">
              {t('notConfiguredBody', { vars: setup.missing.join(', ') })}
            </AlertDescription>
          </Alert>
        ) : (
          <Button
            onClick={handleConnect}
            disabled={busy || !setup}
            className="bg-primary hover:bg-primary/90 text-primary-foreground"
          >
            {busy ? (
              <>
                <Loader2 className="size-4 animate-spin" />
                {phase === 'saving' ? t('saving') : t('connecting')}
              </>
            ) : (
              <>
                <Smartphone className="size-4" />
                {config?.coexistence ? t('reconnect') : t('connect')}
              </>
            )}
          </Button>
        )}

        <p className="text-xs leading-relaxed text-muted-foreground">{t('limits')}</p>
      </CardContent>
    </Card>
  );
}
