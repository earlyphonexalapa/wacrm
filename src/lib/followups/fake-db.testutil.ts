import type { SupabaseClient } from '@supabase/supabase-js'

// ============================================================
// A tiny in-memory stand-in for the slice of the Supabase query
// builder the follow-up engine uses (select / insert / update with
// eq, in, lt, lte, or, order, limit, maybeSingle). Tests only —
// exists so the processor's real query flow can run without a DB.
// ============================================================

type Row = Record<string, unknown>
type Tables = Record<string, Row[]>

export function makeFakeDb(tables: Tables) {
  let idCounter = 1

  function builder(table: string) {
    let op: 'select' | 'update' | 'insert' = 'select'
    let patch: Row = {}
    let inserted: Row[] = []
    const filters: ((r: Row) => boolean)[] = []
    let orderBy: { col: string; asc: boolean } | null = null
    let limitN: number | null = null
    let single = false

    const matches = (r: Row) => filters.every((f) => f(r))

    function run(): { data: unknown; error: { code?: string; message: string } | null } {
      const rows = (tables[table] ??= [])
      if (op === 'insert') {
        for (const r of inserted) {
          rows.push({ id: `${table}-${idCounter++}`, ...r })
        }
        return { data: inserted, error: null }
      }
      let selected = rows.filter(matches)
      if (op === 'update') {
        for (const r of selected) Object.assign(r, patch)
      }
      if (orderBy) {
        const { col, asc } = orderBy
        selected = [...selected].sort((a, b) => {
          const av = String(a[col] ?? '')
          const bv = String(b[col] ?? '')
          return asc ? av.localeCompare(bv) : bv.localeCompare(av)
        })
      }
      if (limitN !== null) selected = selected.slice(0, limitN)
      return { data: single ? (selected[0] ?? null) : selected, error: null }
    }

    const api = {
      select: () => api,
      insert: (rows: Row | Row[]) => {
        op = 'insert'
        inserted = Array.isArray(rows) ? rows : [rows]
        return api
      },
      update: (p: Row) => {
        op = 'update'
        patch = p
        return api
      },
      eq: (col: string, val: unknown) => {
        filters.push((r) => r[col] === val)
        return api
      },
      in: (col: string, vals: unknown[]) => {
        filters.push((r) => vals.includes(r[col]))
        return api
      },
      lt: (col: string, val: string) => {
        filters.push((r) => r[col] != null && String(r[col]) < val)
        return api
      },
      lte: (col: string, val: string) => {
        filters.push((r) => r[col] != null && String(r[col]) <= val)
        return api
      },
      // Only the `col.is.null,col.lt.X` shape the lease query uses.
      or: (expr: string) => {
        const parts = expr.split(',').map((p) => p.split('.'))
        filters.push((r) =>
          parts.some(([col, opName, ...rest]) => {
            const v = r[col]
            if (opName === 'is') return rest[0] === 'null' ? v == null : false
            if (opName === 'lt') return v != null && String(v) < rest.join('.')
            return false
          }),
        )
        return api
      },
      order: (col: string, o?: { ascending?: boolean }) => {
        orderBy = { col, asc: o?.ascending !== false }
        return api
      },
      limit: (n: number) => {
        limitN = n
        return api
      },
      maybeSingle: () => {
        single = true
        return api
      },
      single: () => {
        single = true
        return api
      },
      then: (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) => {
        try {
          return Promise.resolve(run()).then(resolve, reject)
        } catch (e) {
          return Promise.reject(e).then(resolve, reject)
        }
      },
    }
    return api
  }

  const db = { from: (table: string) => builder(table) }
  return { db: db as unknown as SupabaseClient, tables }
}
