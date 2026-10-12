"use client";

import { useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useTranslations } from "next-intl";
import { Bell, LayoutDashboard, Menu, MessageCircle, Users } from "lucide-react";
import { cn } from "@/lib/utils";
import { useAuth } from "@/hooks/use-auth";
import { useUnreadCounts } from "@/hooks/use-unread-counts";
import { canOpenPath } from "@/lib/auth/nav-access";

// WhatsApp-style bottom tabs for phones (hidden on lg+, where the sidebar
// is always visible). "More" opens the existing sidebar drawer for every
// other section. Hidden while a chat is open so the thread gets the whole
// screen — the inbox flags that on <html data-chat-open>.

interface MobileTabBarProps {
  onOpenMore: () => void;
}

export function MobileTabBar({ onOpenMore }: MobileTabBarProps) {
  const t = useTranslations("Sidebar");
  const tm = useTranslations("Mobile");
  const pathname = usePathname();
  const { accountRole } = useAuth();
  const { chats, notifications } = useUnreadCounts();
  // The tapped tab lights up immediately, before the page has loaded — a
  // native tab bar never waits. Ignored once the route actually changes.
  const [pending, setPending] = useState<{ from: string; href: string } | null>(null);
  const shownPath = pending && pending.from === pathname ? pending.href : pathname;

  const tabs = [
    { href: "/inbox", label: tm("chats"), icon: MessageCircle, badge: chats },
    { href: "/contacts", label: t("contacts"), icon: Users, badge: 0 },
    { href: "/notifications", label: t("notifications"), icon: Bell, badge: notifications },
    { href: "/dashboard", label: t("dashboard"), icon: LayoutDashboard, badge: 0 },
  ].filter((tab) => !accountRole || canOpenPath(accountRole, tab.href));

  return (
    <nav
      aria-label={tm("more")}
      className="flex shrink-0 items-stretch border-t border-border bg-card/95 pb-[env(safe-area-inset-bottom)] backdrop-blur select-none lg:hidden [html[data-chat-open]_&]:hidden"
    >
      {tabs.map(({ href, label, icon: Icon, badge }) => {
        const active = shownPath === href || shownPath.startsWith(`${href}/`);
        return (
          <Link
            key={href}
            href={href}
            onClick={() => setPending({ from: pathname, href })}
            className={cn(
              "relative flex flex-1 flex-col items-center gap-0.5 pt-2 pb-1.5 text-[11px] font-medium transition-opacity active:opacity-50",
              active ? "text-primary" : "text-muted-foreground",
            )}
          >
            <span className="relative">
              <Icon className={cn("h-6 w-6", active && "fill-primary/15")} />
              {badge > 0 && (
                <span className="absolute -top-1.5 left-4 flex h-[18px] min-w-[18px] items-center justify-center rounded-full bg-primary px-1 text-[10px] font-bold text-primary-foreground">
                  {badge > 99 ? "99+" : badge}
                </span>
              )}
            </span>
            {label}
          </Link>
        );
      })}
      <button
        type="button"
        onClick={onOpenMore}
        className="flex flex-1 flex-col items-center gap-0.5 pt-2 pb-1.5 text-[11px] font-medium text-muted-foreground transition-opacity active:opacity-50"
      >
        <Menu className="h-6 w-6" />
        {tm("more")}
      </button>
    </nav>
  );
}
