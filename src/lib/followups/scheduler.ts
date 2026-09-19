import { processDueFollowups } from './processor'

// ============================================================
// In-process scheduler. Follow-ups are driven from inside the app
// (started once at boot from src/instrumentation.ts) so nothing external
// — no n8n, no cron pinger — is needed for them to go out.
//
// State lives in the database and every due row is claimed with a lease
// (see processor.ts), so a restart loses nothing and running more than
// one instance is safe — it just does redundant polling.
//
// The handle is kept on `globalThis`: Next bundles instrumentation and
// route handlers separately, so a module-level variable wouldn't be
// visible to the status endpoint, and dev HMR would start a second timer.
// ============================================================

interface SchedulerState {
  timer: ReturnType<typeof setInterval>
  tickMs: number
  busy: boolean
  startedAt: number
  lastTickAt: number | null
  lastError: string | null
}

const KEY = '__wacrmFollowupScheduler'
type GlobalWithScheduler = typeof globalThis & { [KEY]?: SchedulerState }

function state(): SchedulerState | undefined {
  return (globalThis as GlobalWithScheduler)[KEY]
}

function tickInterval(): number {
  const raw = Number(process.env.FOLLOWUP_TICK_MS)
  return Number.isFinite(raw) && raw >= 5_000 ? raw : 30_000
}

async function tick(s: SchedulerState): Promise<void> {
  if (s.busy) return // a slow batch must not stack up behind itself
  s.busy = true
  try {
    await processDueFollowups()
    s.lastError = null
  } catch (err) {
    s.lastError = err instanceof Error ? err.message : String(err)
    console.error('[followups] scheduler tick failed:', err)
  } finally {
    s.lastTickAt = Date.now()
    s.busy = false
  }
}

export function startFollowupScheduler(): void {
  if (state()) return
  const tickMs = tickInterval()
  const s: SchedulerState = {
    timer: setInterval(() => void tick(s), tickMs),
    tickMs,
    busy: false,
    startedAt: Date.now(),
    lastTickAt: null,
    lastError: null,
  }
  // Never keep the process alive just for polling.
  s.timer.unref?.()
  ;(globalThis as GlobalWithScheduler)[KEY] = s
  void tick(s)
}

export interface SchedulerStatus {
  running: boolean
  tickMs: number | null
  lastTickAt: string | null
  lastError: string | null
}

export function getSchedulerStatus(): SchedulerStatus {
  const s = state()
  if (!s) return { running: false, tickMs: null, lastTickAt: null, lastError: null }
  return {
    running: true,
    tickMs: s.tickMs,
    lastTickAt: s.lastTickAt ? new Date(s.lastTickAt).toISOString() : null,
    lastError: s.lastError,
  }
}
