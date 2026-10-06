/**
 * When the tab comes back into view the Inbox refetches its conversation
 * list and the open thread, in case realtime missed something while the tab
 * was in the background. That is a heavy request (up to ~1,000 chats with
 * their contacts and tags), and a quick alt-tab can't have lost anything: a
 * dropped realtime connection triggers its own resync when it reconnects.
 * So only refetch after a real absence.
 */
export const RESYNC_AFTER_AWAY_MS = 30_000

/** `hiddenAt` is when the tab was hidden (null if we never saw it hide). */
export function shouldResyncAfterAway(
  hiddenAt: number | null,
  now: number,
  thresholdMs: number = RESYNC_AFTER_AWAY_MS,
): boolean {
  if (hiddenAt === null) return true
  return now - hiddenAt >= thresholdMs
}
