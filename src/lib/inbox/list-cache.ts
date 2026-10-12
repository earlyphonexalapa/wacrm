import type { Conversation } from "@/types";

// Last-seen top of the chat list, kept on the device so opening the app
// paints the chats instantly while the live list loads behind it (the way
// WhatsApp opens straight into your chats). Per user, and wiped on sign-out.

const PREFIX = "wacrm:inbox-cache:";
const MAX_ROWS = 80;

export function readInboxCache(userId: string | null): Conversation[] | null {
  if (!userId) return null;
  try {
    const raw = localStorage.getItem(PREFIX + userId);
    if (!raw) return null;
    const rows = JSON.parse(raw);
    return Array.isArray(rows) && rows.length > 0 ? (rows as Conversation[]) : null;
  } catch {
    return null;
  }
}

export function writeInboxCache(userId: string | null, conversations: Conversation[]): void {
  if (!userId) return;
  try {
    localStorage.setItem(PREFIX + userId, JSON.stringify(conversations.slice(0, MAX_ROWS)));
  } catch {
    // Full or blocked storage — the cache is only a speed-up.
  }
}

export function clearInboxCaches(): void {
  try {
    for (let i = localStorage.length - 1; i >= 0; i--) {
      const key = localStorage.key(i);
      if (key?.startsWith(PREFIX)) localStorage.removeItem(key);
    }
  } catch {
    // Best-effort.
  }
}
