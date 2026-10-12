"use client";

import { useEffect } from "react";
import { usePathname, useRouter } from "next/navigation";
import { useUnreadCounts } from "@/hooks/use-unread-counts";
import { isStandalone } from "./use-push";

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

  // iOS only shows :active (pressed) styles when the page listens for
  // touches. Without this, taps give no feedback until the action finishes,
  // which reads as lag.
  useEffect(() => {
    const noop = () => {};
    document.addEventListener("touchstart", noop, { passive: true });
    return () => document.removeEventListener("touchstart", noop);
  }, []);

  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv || !window.matchMedia("(pointer: coarse)").matches) return;
    const root = document.documentElement;
    let frame = 0;
    const apply = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        // Keyboard closed: leave the shell pinned top-to-bottom of the
        // screen (inset 0). Measured heights can't be trusted there — an
        // installed iPhone app reports the screen minus the status bar,
        // which left a strip under the tab bar.
        const keyboardOpen = window.innerHeight - vv.height > 120;
        if (!keyboardOpen) {
          root.style.removeProperty("--app-height");
          root.style.removeProperty("--app-top");
          // iOS bug in installed apps: the window is shorter than the screen
          // by the status-bar height, leaving a strip at the bottom that the
          // page can't draw into (only its background shows there — painted
          // the tab-bar colour in globals.css). That strip already covers the
          // home-indicator area, so the tab bar and composer subtract it from
          // their bottom safe-area padding instead of adding a second gap.
          const portrait = window.matchMedia("(orientation: portrait)").matches;
          const shortfall = Math.round(window.screen.height - window.innerHeight);
          if (isStandalone() && portrait && shortfall > 0 && shortfall < 100) {
            root.style.setProperty("--app-bottom-gap", `${shortfall}px`);
          } else {
            root.style.removeProperty("--app-bottom-gap");
          }
          return;
        }
        root.style.removeProperty("--app-bottom-gap");
        // Keyboard open: iOS shrinks the visual viewport and may pan it, so
        // the app follows both and the composer sits right on the keyboard.
        root.style.setProperty("--app-height", `${Math.round(vv.height)}px`);
        root.style.setProperty("--app-top", `${Math.round(vv.offsetTop)}px`);
      });
    };
    apply();
    vv.addEventListener("resize", apply);
    vv.addEventListener("scroll", apply);
    return () => {
      cancelAnimationFrame(frame);
      vv.removeEventListener("resize", apply);
      vv.removeEventListener("scroll", apply);
      root.style.removeProperty("--app-height");
      root.style.removeProperty("--app-top");
      root.style.removeProperty("--app-bottom-gap");
    };
  }, []);

  return null;
}
