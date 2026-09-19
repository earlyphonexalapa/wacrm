/**
 * Runs once when a new server instance starts, before it accepts any
 * requests (Next.js instrumentation hook):
 *
 *  - recovers AI auto-reply debounces that were scheduled but never
 *    fired because the previous instance restarted mid-wait — see
 *    src/lib/ai/inbound-buffer.ts for why that can otherwise lose a
 *    reply silently;
 *  - starts the follow-ups scheduler (src/lib/followups/scheduler.ts).
 *
 * Each task is isolated: a failure in one must never stop the other, or
 * the server from booting.
 *
 * Guarded to the Node runtime: this project has at least one edge
 * route, and `register()` runs there too — the service-role Supabase
 * client these pull in is Node-only.
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return

  try {
    const { recoverPendingAiReplies } = await import('@/lib/ai/inbound-buffer')
    await recoverPendingAiReplies()
  } catch (err) {
    console.error('[instrumentation] AI reply recovery failed:', err)
  }

  try {
    const { startFollowupScheduler } = await import('@/lib/followups/scheduler')
    startFollowupScheduler()
  } catch (err) {
    console.error('[instrumentation] follow-up scheduler failed to start:', err)
  }
}
