"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { BellRing, Share, X } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { useDeviceEnv, usePush } from "./use-push";

// Two one-time nudges for phones, shown above the bottom tabs:
//   1. In Safari on an iPhone: how to install the app (Share → Add to Home
//      Screen). iOS has no install button a page can trigger.
//   2. Inside the installed app: turn on notifications. iOS only shows the
//      permission prompt after a tap, so it can't be asked on load.
// Dismissing either one hides it on this device for two weeks.

const INSTALL_KEY = "wacrm:pwa:install-dismissed-at";
const PUSH_KEY = "wacrm:pwa:push-dismissed-at";
const SNOOZE_MS = 14 * 24 * 60 * 60 * 1000;

function snoozed(key: string): boolean {
  try {
    const at = Number(localStorage.getItem(key));
    return !!at && Date.now() - at < SNOOZE_MS;
  } catch {
    return false;
  }
}

function snooze(key: string) {
  try {
    localStorage.setItem(key, String(Date.now()));
  } catch {
    // Best-effort.
  }
}

export function PwaPrompts() {
  const t = useTranslations("Mobile");
  const push = usePush();
  const env = useDeviceEnv();
  // Only ever rendered client-side (the dashboard shell waits for auth), so
  // reading localStorage up front can't cause a hydration mismatch.
  const [hidden, setHidden] = useState(() => ({
    install: snoozed(INSTALL_KEY),
    push: snoozed(PUSH_KEY),
  }));

  if (!env) return null;

  if (env.ios && !env.standalone && !hidden.install) {
    return (
      <Nudge
        icon={<Share className="h-5 w-5" />}
        title={t("installTitle")}
        onDismiss={() => {
          snooze(INSTALL_KEY);
          setHidden((h) => ({ ...h, install: true }));
        }}
        dismissLabel={t("dismiss")}
      >
        {env.safari
          ? t.rich("installBody", {
              share: () => <Share className="inline h-3.5 w-3.5 align-[-2px]" />,
            })
          : t("installNotSafari")}
      </Nudge>
    );
  }

  if (env.standalone && push.state === "off" && !hidden.push) {
    const later = () => {
      snooze(PUSH_KEY);
      setHidden((h) => ({ ...h, push: true }));
    };
    return (
      <Nudge
        icon={<BellRing className="h-5 w-5" />}
        title={t("pushTitle")}
        onDismiss={later}
        dismissLabel={t("dismiss")}
      >
        <p>{t("pushBody")}</p>
        <div className="mt-2 flex gap-2">
          <Button
            size="sm"
            disabled={push.busy}
            onClick={async () => {
              const result = await push.enable();
              if (result === "on") toast.success(t("pushEnabled"));
              else if (result === "denied") toast.error(t("pushDenied"));
              else if (result === "unconfigured") toast.error(t("pushUnavailable"));
              else toast.error(t("pushFailed"));
            }}
          >
            {t("pushEnable")}
          </Button>
          <Button size="sm" variant="ghost" onClick={later}>
            {t("pushLater")}
          </Button>
        </div>
      </Nudge>
    );
  }

  return null;
}

function Nudge({
  icon,
  title,
  children,
  onDismiss,
  dismissLabel,
}: {
  icon: React.ReactNode;
  title: string;
  children: React.ReactNode;
  onDismiss: () => void;
  dismissLabel: string;
}) {
  return (
    <div className="mx-2 mb-2 flex gap-3 rounded-2xl border border-border bg-card p-3 text-sm shadow-lg lg:hidden [html[data-chat-open]_&]:hidden">
      <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-primary/15 text-primary">
        {icon}
      </div>
      <div className="min-w-0 flex-1 text-muted-foreground">
        <p className="font-semibold text-foreground">{title}</p>
        <div className="mt-0.5 text-xs leading-relaxed">{children}</div>
      </div>
      <button
        type="button"
        onClick={onDismiss}
        aria-label={dismissLabel}
        className="-mt-1 -mr-1 flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-muted-foreground hover:bg-muted"
      >
        <X className="h-4 w-4" />
      </button>
    </div>
  );
}
