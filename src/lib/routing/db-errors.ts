/**
 * True when a Supabase/PostgREST error means the lead-routing tables are
 * not there yet (migration 055 hasn't run): Postgres "undefined_table" or
 * PostgREST's schema-cache miss. The routes turn it into a clear message
 * instead of a 500.
 */
export function isMissingRoutingTable(error: { code?: string; message?: string } | null | undefined): boolean {
  if (!error) return false
  if (error.code === '42P01' || error.code === 'PGRST205') return true
  return /lead_routing|ad_campaign_cache/.test(error.message ?? '') && /does not exist|schema cache/i.test(error.message ?? '')
}
