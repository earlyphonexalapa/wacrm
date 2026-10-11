"use client";

import { useTranslations } from "next-intl";
import { BellRing, Loader2, Smartphone } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { useDeviceEnv, usePush } from "./use-push";

// "Phone app" card on the Notifications page: shows whether this device
// runs the installed app and lets the user turn phone notifications on/off
// and send themselves a test. See docs/ios-app.md.
export function PhoneAppCard() {
  const t = useTranslations("Mobile");
  const push = usePush();
  const env = useDeviceEnv();
  if (!env) return null;

  const status =
    push.state === "on"
      ? t("settingsPushOn")
      : push.state === "denied"
        ? t("pushDenied")
        : push.state === "unconfigured"
          ? t("pushUnavailable")
          : push.state === "unsupported" && env.ios
            ? t("settingsPushNeedsInstall")
            : t("settingsPushOff");

  return (
    <div className="rounded-xl border border-border bg-card p-4">
      <div className="flex items-start gap-3">
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary">
          <Smartphone className="h-5 w-5" />
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold text-foreground">{t("settingsTitle")}</p>
          <p className="mt-0.5 text-xs text-muted-foreground">{t("settingsDesc")}</p>
          <p className="mt-2 text-xs text-muted-foreground">
            {env.standalone ? t("settingsInstalled") : t("settingsNotInstalled")}
          </p>
          <p className="mt-2 flex items-center gap-1.5 text-xs font-medium text-foreground">
            <BellRing className="h-3.5 w-3.5 text-primary" />
            {status}
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            {push.state === "off" && (
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
                {push.busy && <Loader2 className="h-4 w-4 animate-spin" />}
                {t("pushEnable")}
              </Button>
            )}
            {push.state === "on" && (
              <>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={async () => {
                    if (await push.sendTest()) toast.success(t("pushTestSent"));
                    else toast.error(t("pushFailed"));
                  }}
                >
                  {t("pushTest")}
                </Button>
                <Button size="sm" variant="ghost" disabled={push.busy} onClick={push.disable}>
                  {t("pushDisable")}
                </Button>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
