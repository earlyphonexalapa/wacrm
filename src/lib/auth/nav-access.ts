import { hasMinRole, type AccountRole } from './roles'

// ============================================================
// Which parts of the CRM each role can open. Pure and unit tested; the
// sidebar, the dashboard shell and the settings page all read from here so
// the menu and the direct-URL guard can never disagree.
//
// Everyone gets: Panel, Bandeja, Notificaciones, Contactos and the personal
// part of Configuración. The technical areas — automations, follow-ups,
// flows, AI agents, broadcasts, exports and pipelines — are for admins and
// the owner. (The API routes behind them enforce the same rule; hiding a
// link is only the convenience layer.)
// ============================================================

const ADMIN_ONLY_PREFIXES = [
  '/automations',
  '/followups',
  '/flows',
  '/agents',
  '/exports',
  '/broadcasts',
  '/pipelines',
] as const

/** The lowest role allowed to open `pathname`. */
export function minRoleForPath(pathname: string): AccountRole {
  const restricted = ADMIN_ONLY_PREFIXES.some(
    (prefix) => pathname === prefix || pathname.startsWith(prefix + '/'),
  )
  return restricted ? 'admin' : 'viewer'
}

/**
 * Whether a user with `role` may open `pathname`. While the role is still
 * unknown (`null`) only the open-to-everyone pages count, so a restricted
 * link never flashes up for someone who turns out not to be allowed.
 */
export function canOpenPath(role: AccountRole | null, pathname: string): boolean {
  const min = minRoleForPath(pathname)
  if (role === null) return min === 'viewer'
  return hasMinRole(role, min)
}
