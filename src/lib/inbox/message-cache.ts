import { createClient } from "@/lib/supabase/client";
import type { Message } from "@/types";

// In-memory cache of recently opened threads, so going back into a chat
// shows its messages instantly (then refreshes in the background), and a
// tap on a list row can start loading the thread before the tap completes.
// Lives only for the page's lifetime — nothing is written to disk.

const MAX_THREADS = 30;
const cache = new Map<string, Message[]>();
const inflight = new Map<string, Promise<MessagesResult>>();

export interface MessagesResult {
  data: Message[] | null;
  error: { message: string } | null;
}

export function getCachedMessages(conversationId: string): Message[] | undefined {
  return cache.get(conversationId);
}

export function setCachedMessages(conversationId: string, messages: Message[]): void {
  // Re-insert so the Map's order doubles as least-recently-used.
  cache.delete(conversationId);
  cache.set(conversationId, messages);
  if (cache.size > MAX_THREADS) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
}

/** Fetch a thread's messages; concurrent calls for the same thread share one request. */
export function fetchMessages(conversationId: string): Promise<MessagesResult> {
  const pending = inflight.get(conversationId);
  if (pending) return pending;
  const request = (async (): Promise<MessagesResult> => {
    const { data, error } = await createClient()
      .from("messages")
      .select("*")
      .eq("conversation_id", conversationId)
      .order("created_at", { ascending: true });
    if (!error && data) setCachedMessages(conversationId, data as Message[]);
    return { data: (data as Message[] | null) ?? null, error };
  })().finally(() => inflight.delete(conversationId));
  inflight.set(conversationId, request);
  return request;
}

/** Start loading a thread the user is about to open (e.g. on touch-down). */
export function prefetchMessages(conversationId: string): void {
  if (cache.has(conversationId) || inflight.has(conversationId)) return;
  void fetchMessages(conversationId);
}
