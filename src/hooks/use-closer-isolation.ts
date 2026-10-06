'use client'

import { useEffect, useState } from 'react'

import { useAuth } from '@/hooks/use-auth'
import { createClient } from '@/lib/supabase/client'

/**
 * Whether "each closer only sees their own chats" is switched on for this
 * account (migration 056), and whether it applies to the signed-in user.
 * Admins and the owner are never restricted. Until the answer arrives — or
 * on a database that predates the migration — nothing is restricted.
 */
export function useCloserIsolation(): {
  loading: boolean
  isolationOn: boolean
  /** Isolation is on AND this user is below admin. */
  restricted: boolean
} {
  const { accountId, canEditSettings } = useAuth()
  const [on, setOn] = useState<boolean | null>(null)

  useEffect(() => {
    if (!accountId) return
    let cancelled = false
    createClient()
      .rpc('closer_isolation_on', { p_account: accountId })
      .then(({ data, error }) => {
        if (!cancelled) setOn(error ? false : data === true)
      })
    return () => {
      cancelled = true
    }
  }, [accountId])

  return {
    loading: on === null,
    isolationOn: on === true,
    restricted: on === true && !canEditSettings,
  }
}
