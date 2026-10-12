"use client";

import { useCallback, useEffect, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { AuthProvider, useAuth } from "@/hooks/use-auth";
import { canOpenPath, minRoleForPath } from "@/lib/auth/nav-access";
import { Sidebar } from "@/components/layout/sidebar";
import { Header } from "@/components/layout/header";
import { AccountAccessAlert } from "@/components/layout/account-access-alert";
import { PresenceHeartbeat } from "@/components/presence/presence-heartbeat";
import { UnreadCountsProvider } from "@/hooks/use-unread-counts";
import { PwaProvider } from "@/components/pwa/pwa-provider";
import { PwaPrompts } from "@/components/pwa/pwa-prompts";
import { MobileTabBar } from "@/components/pwa/mobile-tab-bar";

// Auth-gated dashboard shell. Extracted from the layout so the layout
// itself can stay a server component and export metadata (noindex) —
// client components can't export Next's metadata object.

function DashboardShellInner({ children }: { children: React.ReactNode }) {
  const { user, loading, accountRole, profileLoading } = useAuth();
  const router = useRouter();
  const pathname = usePathname();

  // Technical areas (automations, follow-ups, flows, AI agents, broadcasts,
  // exports, pipelines) are for admins and the owner. Typing the address of
  // one as a closer sends you back to the inbox instead of opening it.
  // While the role is still loading, a restricted page just waits.
  const roleKnown = !profileLoading && accountRole !== null;
  const blocked = roleKnown
    ? !canOpenPath(accountRole, pathname)
    : profileLoading && minRoleForPath(pathname) !== "viewer";

  useEffect(() => {
    if (roleKnown && !canOpenPath(accountRole, pathname)) {
      router.replace("/inbox");
    }
  }, [roleKnown, accountRole, pathname, router]);

  // Sidebar drawer state — only used on mobile. On lg+ the sidebar is
  // always visible and this stays at `false` (ignored by the component).
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const closeSidebar = useCallback(() => setSidebarOpen(false), []);

  useEffect(() => {
    if (!loading && !user) {
      router.push("/login");
    }
  }, [user, loading, router]);

  if (loading) {
    return (
      <div className="flex h-screen items-center justify-center bg-background">
        <div className="flex flex-col items-center gap-3">
          <div className="h-8 w-8 animate-spin rounded-full border-2 border-primary border-t-transparent" />
          <p className="text-sm text-muted-foreground">Loading...</p>
        </div>
      </div>
    );
  }

  if (!user) return null;

  // The inbox is the phone app's home screen: on phones it draws its own
  // WhatsApp-style "Chats" title bar, so the generic header steps aside.
  const isInbox = pathname === "/inbox";

  return (
    <UnreadCountsProvider>
    {/* On phones the app is pinned edge to edge (fixed, top and bottom 0,
        under the notch and the home indicator), so the page underneath never
        scrolls or rubber-bands; only lists scroll. While the keyboard is open
        --app-top / --app-height shrink it to the visible area (PwaProvider). */}
    <div className="flex h-[var(--app-height,100dvh)] overflow-hidden bg-background max-lg:fixed max-lg:inset-x-0 max-lg:top-[var(--app-top,0px)] max-lg:bottom-0 max-lg:h-[var(--app-height,auto)]">
      {/* Reports this tab's online/away presence once we know a user is
          signed in. Headless — renders nothing. */}
      <PresenceHeartbeat />
      <PwaProvider />
      <Sidebar open={sidebarOpen} onClose={closeSidebar} />
      <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
        <Header
          onOpenSidebar={() => setSidebarOpen(true)}
          className={isInbox ? "max-lg:hidden" : undefined}
        />
        {/* Thinner horizontal padding on mobile so cards have room to breathe. */}
        <main
          className={
            isInbox
              ? "flex min-h-0 flex-1 flex-col overflow-hidden lg:p-6"
              : "flex-1 overscroll-contain overflow-y-auto p-4 sm:p-6"
          }
        >
          {/* Above every page: writes are being rejected and here's why.
              Renders nothing unless the account/role failed to resolve. */}
          <AccountAccessAlert />
          {blocked ? (
            <div className="flex items-center justify-center py-24">
              <div className="h-6 w-6 animate-spin rounded-full border-2 border-primary border-t-transparent" />
            </div>
          ) : (
            children
          )}
        </main>
        <PwaPrompts />
        <MobileTabBar onOpenMore={() => setSidebarOpen(true)} />
      </div>
    </div>
    </UnreadCountsProvider>
  );
}

export function DashboardShell({ children }: { children: React.ReactNode }) {
  return (
    <AuthProvider>
      <DashboardShellInner>{children}</DashboardShellInner>
    </AuthProvider>
  );
}
