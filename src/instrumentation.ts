/**
 * Runs once when a new server instance starts, before it accepts any
 * requests (Next.js instrumentation hook). Used to recover AI
 * auto-reply debounces that were scheduled but never fired because the
 * previous instance restarted mid-wait — see
 * src/lib/ai/inbound-buffer.ts for why that can otherwise lose a reply
 * silently.
 *
 * Guarded to the Node runtime: this project has at least one edge
 * route, and `register()` runs there too — the service-role Supabase
 * client this pulls in is Node-only.
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return

  const { recoverPendingAiReplies } = await import('@/lib/ai/inbound-buffer')
  await recoverPendingAiReplies()
}
