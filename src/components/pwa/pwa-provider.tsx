"use client";

import { useEffect } from "react";
import { usePathname, useRouter } from "next/navigation";
import { useUnreadCounts } from "@/hooks/use-unread-counts";

// Headless glue for the installable phone app (docs/ios-app.md):
//   - registers the service worker (push notifications live there)
//   - opens the tapped chat when a notification is tapped while the app runs
//   - keeps the home-screen icon badge equal to the unread chat count
//   - sizes the app to the visible area so the iOS keyboard pushes the
//     composer up instead of sliding the whole app off screen

/** Fired on window when a notification asks for a chat; the inbox listens. */
export const OPEN_CONVERSATION_EVENT = "wacrm:open-conversation";

export function PwaProvider() {
  const router = useRouter();
  const pathname = usePathname();
  const { chats } = useUnreadCounts();

  useEffect(() => {
    if (!("serviceWorker" in navigator)) return;
    navigator.serviceWorker
      .register("/sw.js", { scope: "/", updateViaCache: "none" })
      .catch((err) => console.error("[pwa] service worker registration failed:", err));
  }, []);

  useEffect(() => {
    if (!("serviceWorker" in navigator)) return;
    const onMessage = (event: MessageEvent) => {
      if (event.data?.type !== "open-url" || typeof event.data.url !== "string") return;
      const url = new URL(event.data.url, window.location.origin);
      if (url.origin !== window.location.origin) return;
      const conversationId = url.searchParams.get("c");
      if (url.pathname === "/inbox" && conversationId && pathname === "/inbox") {
        // Already in the inbox: switch chats in place, no reload.
        window.dispatchEvent(
          new CustomEvent(OPEN_CONVERSATION_EVENT, { detail: { conversationId } }),
        );
      } else {
        router.push(url.pathname + url.search);
      }
    };
    navigator.serviceWorker.addEventListener("message", onMessage);
    return () => navigator.serviceWorker.removeEventListener("message", onMessage);
  }, [router, pathname]);

  useEffect(() => {
    const nav = navigator as Navigator & {
      setAppBadge?: (n?: number) => Promise<void>;
      clearAppBadge?: () => Promise<void>;
    };
    if (!nav.setAppBadge) return;
    (chats > 0 ? nav.setAppBadge(chats) : nav.clearAppBadge?.())?.catch(() => {});
  }, [chats]);

  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv || !window.matchMedia("(pointer: coarse)").matches) return;
    const root = document.documentElement;
    const apply = () => {
      root.style.setProperty("--app-height", `${Math.round(vv.height)}px`);
      // iOS scrolls the page to reveal the focused input; the app already
      // shrank to fit, so undo that scroll to keep the header in place.
      if (window.scrollY !== 0) window.scrollTo(0, 0);
    };
    apply();
    vv.addEventListener("resize", apply);
    vv.addEventListener("scroll", apply);
    return () => {
      vv.removeEventListener("resize", apply);
      vv.removeEventListener("scroll", apply);
      root.style.removeProperty("--app-height");
    };
  }, []);

  return null;
}
