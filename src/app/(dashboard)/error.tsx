"use client";

import { useEffect } from "react";
import { useTranslations } from "next-intl";
import { AlertTriangle } from "lucide-react";

// Catches a crash inside any dashboard page, keeping the sidebar and header on
// screen. Unlike Next's built-in "This page couldn't load", it shows the actual
// error text, so whoever hits it can send a screenshot that says what failed.
export default function DashboardError({
  error,
  unstable_retry,
}: {
  error: Error & { digest?: string };
  unstable_retry: () => void;
}) {
  const t = useTranslations("ErrorBoundary");

  useEffect(() => {
    console.error("[dashboard] page crashed:", error);
  }, [error]);

  return (
    <div className="flex h-full flex-1 items-center justify-center p-6">
      <div className="max-w-md space-y-4">
        <AlertTriangle className="size-8 text-muted-foreground" />
        <h2 className="text-lg font-semibold text-foreground">{t("title")}</h2>
        <p className="text-sm text-muted-foreground">{t("description")}</p>
        <pre className="max-h-40 overflow-auto rounded-md bg-muted p-3 text-xs whitespace-pre-wrap text-muted-foreground">
          {error.name}: {error.message}
          {error.digest ? `\n(${error.digest})` : ""}
        </pre>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => unstable_retry()}
            className="rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:opacity-90"
          >
            {t("retry")}
          </button>
          <button
            type="button"
            onClick={() => window.location.reload()}
            className="rounded-md border border-border px-3 py-1.5 text-sm font-medium text-foreground hover:bg-muted"
          >
            {t("reload")}
          </button>
        </div>
      </div>
    </div>
  );
}
