"use client";

import { Suspense, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { Loader2, ShieldCheck } from "lucide-react";
import { useTranslations } from "next-intl";

import { TotpEnroll } from "@/components/auth/totp-enroll";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { safeNextPath } from "@/lib/auth/mfa-gate";
import { createClient } from "@/lib/supabase/client";

// `useSearchParams` needs a Suspense boundary (see the login page).
export default function TwoFactorPage() {
  return (
    <Suspense fallback={null}>
      <TwoFactorPageInner />
    </Suspense>
  );
}

type Mode = "loading" | "verify" | "enroll";

function TwoFactorPageInner() {
  const t = useTranslations("TwoFactor");
  const params = useSearchParams();
  const next = safeNextPath(params.get("next"));
  // The middleware adds setup=1 only when everyone is required to have 2FA.
  const forcedSetup = params.get("setup") === "1";

  const [mode, setMode] = useState<Mode>("loading");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const supabase = createClient();
      const {
        data: { user },
      } = await supabase.auth.getUser();
      if (cancelled) return;
      if (!user) {
        window.location.href = "/login";
        return;
      }
      const { data: factors } = await supabase.auth.mfa.listFactors();
      if (cancelled) return;
      if ((factors?.totp.length ?? 0) > 0) setMode("verify");
      else if (forcedSetup) setMode("enroll");
      // Nothing to verify and setup isn't required: carry on to the app.
      else window.location.href = next;
    })();
    return () => {
      cancelled = true;
    };
  }, [forcedSetup, next]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (code.length !== 6) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/auth/2fa/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code }),
      });
      if (res.ok) {
        // Full navigation so the request carries the cookie just set.
        window.location.href = next;
        return;
      }
      setError(res.status === 429 ? t("tooMany") : t("invalidCode"));
      setCode("");
    } catch {
      setError(t("invalidCode"));
    } finally {
      setBusy(false);
    }
  }

  async function signOut() {
    await createClient().auth.signOut();
    window.location.href = "/login";
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
      <Card className="w-full max-w-md border-border bg-card">
        <CardHeader className="items-center text-center">
          <div className="mb-2 flex size-12 items-center justify-center rounded-full bg-primary/10 text-primary">
            <ShieldCheck className="size-6" />
          </div>
          <CardTitle className="text-xl text-foreground">
            {mode === "enroll" ? t("setupTitle") : t("verifyTitle")}
          </CardTitle>
          <CardDescription className="text-muted-foreground">
            {mode === "enroll" ? t("setupDesc") : t("verifyDesc")}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {mode === "loading" && (
            <div className="flex justify-center py-6">
              <Loader2 className="size-6 animate-spin text-primary" />
            </div>
          )}

          {mode === "verify" && (
            <form onSubmit={submit} className="space-y-4">
              <div className="space-y-1.5">
                <Label htmlFor="totp-code">{t("codeLabel")}</Label>
                <Input
                  id="totp-code"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  autoFocus
                  maxLength={6}
                  value={code}
                  onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
                  className="text-center text-lg tracking-[0.5em]"
                  placeholder="••••••"
                />
              </div>
              {error && <p className="text-sm text-red-400">{error}</p>}
              <Button type="submit" className="w-full" disabled={busy || code.length !== 6}>
                {busy && <Loader2 className="size-4 animate-spin" />}
                {busy ? t("verifying") : t("verify")}
              </Button>
            </form>
          )}

          {mode === "enroll" && <TotpEnroll onDone={() => (window.location.href = next)} />}

          {mode !== "loading" && (
            <button
              type="button"
              onClick={signOut}
              className="w-full text-center text-xs text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
            >
              {t("signOut")}
            </button>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
