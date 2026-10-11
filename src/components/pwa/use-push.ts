"use client";

import { useCallback, useEffect, useState, useSyncExternalStore } from "react";

// Client side of phone notifications (docs/ios-app.md). The service worker
// is registered by <PwaProvider>; this hook subscribes / unsubscribes the
// device and keeps the server's list of devices in sync.

export type PushState =
  | "loading"
  /** Browser can't do Web Push here (on iPhone: not opened from the home screen). */
  | "unsupported"
  /** Server has no VAPID keys configured. */
  | "unconfigured"
  | "denied"
  | "off"
  | "on";

/** Opened from the home-screen icon rather than a browser tab. */
export function isStandalone(): boolean {
  if (typeof window === "undefined") return false;
  return (
    window.matchMedia("(display-mode: standalone)").matches ||
    (navigator as Navigator & { standalone?: boolean }).standalone === true
  );
}

export function isIos(): boolean {
  if (typeof navigator === "undefined") return false;
  return (
    /iPad|iPhone|iPod/.test(navigator.userAgent) ||
    // iPadOS reports itself as a Mac with touch.
    (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1)
  );
}

export interface DeviceEnv {
  ios: boolean;
  standalone: boolean;
  /** Real Safari — the only iOS browser that could add to the home screen before iOS 16.4. */
  safari: boolean;
}

let deviceEnv: DeviceEnv | null = null;
function readDeviceEnv(): DeviceEnv {
  if (!deviceEnv) {
    const ua = navigator.userAgent;
    deviceEnv = {
      ios: isIos(),
      standalone: isStandalone(),
      safari: /Safari/.test(ua) && !/CriOS|FxiOS|EdgiOS|GSA/.test(ua),
    };
  }
  return deviceEnv;
}
const noSubscribe = () => () => {};

/** Device facts; null during server render, where they don't exist. */
export function useDeviceEnv(): DeviceEnv | null {
  return useSyncExternalStore(noSubscribe, readDeviceEnv, () => null);
}

function urlBase64ToUint8Array(base64: string): Uint8Array<ArrayBuffer> {
  const padding = "=".repeat((4 - (base64.length % 4)) % 4);
  const raw = atob((base64 + padding).replace(/-/g, "+").replace(/_/g, "/"));
  const out = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

function pushSupported(): boolean {
  return (
    typeof window !== "undefined" &&
    "serviceWorker" in navigator &&
    "PushManager" in window &&
    "Notification" in window
  );
}

async function saveSubscription(sub: PushSubscription): Promise<boolean> {
  const res = await fetch("/api/push", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(sub.toJSON()),
  });
  return res.ok;
}

export function usePush() {
  const [state, setState] = useState<PushState>("loading");
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    if (!pushSupported()) {
      setState("unsupported");
      return;
    }
    if (Notification.permission === "denied") {
      setState("denied");
      return;
    }
    try {
      const reg = await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.getSubscription();
      if (sub) {
        // Re-save on every app start: keeps the server copy alive if it
        // was pruned, and moves it over when another user signs in here.
        void saveSubscription(sub).catch(() => {});
        setState("on");
        return;
      }
      const { publicKey } = await fetch("/api/push").then((r) => r.json());
      setState(publicKey ? "off" : "unconfigured");
    } catch {
      setState("off");
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  /** Must be called from a tap — iOS only shows the permission prompt then. */
  const enable = useCallback(async (): Promise<PushState> => {
    if (!pushSupported()) return "unsupported";
    setBusy(true);
    try {
      const permission = await Notification.requestPermission();
      if (permission !== "granted") {
        const next = permission === "denied" ? "denied" : "off";
        setState(next);
        return next;
      }
      const { publicKey } = await fetch("/api/push").then((r) => r.json());
      if (!publicKey) {
        setState("unconfigured");
        return "unconfigured";
      }
      const reg = await navigator.serviceWorker.ready;
      const sub =
        (await reg.pushManager.getSubscription()) ??
        (await reg.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: urlBase64ToUint8Array(publicKey),
        }));
      const ok = await saveSubscription(sub);
      const next = ok ? "on" : "off";
      setState(next);
      return next;
    } catch (err) {
      console.error("[push] enable failed:", err);
      setState("off");
      return "off";
    } finally {
      setBusy(false);
    }
  }, []);

  const disable = useCallback(async () => {
    if (!pushSupported()) return;
    setBusy(true);
    try {
      const reg = await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.getSubscription();
      if (sub) {
        await fetch("/api/push", {
          method: "DELETE",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ endpoint: sub.endpoint }),
        }).catch(() => {});
        await sub.unsubscribe();
      }
      setState("off");
    } finally {
      setBusy(false);
    }
  }, []);

  const sendTest = useCallback(async () => {
    const res = await fetch("/api/push", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ test: true }),
    });
    return res.ok;
  }, []);

  return { state, busy, enable, disable, sendTest };
}
