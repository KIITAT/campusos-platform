import { sql } from 'drizzle-orm'
import type { withTenant } from '@campusos/db'
import { settingsWithin } from '@campusos/module-finance/api'

type Tx = Parameters<Parameters<typeof withTenant>[1]>[0]

/**
 * Wall-clock helpers for the curfew sweep (P2-22a, D1310, D1321).
 *
 * Every function takes the instant to reason about, never SQL `now()`, so the
 * sweep and its tests can set the clock. The zone is the one the books keep, or
 * India's when the institution keeps none.
 */
export const DEFAULT_ZONE = 'Asia/Kolkata'

export async function zoneIn(tx: Tx, tenant: string): Promise<string> {
  const [row] = (await tx.execute(sql`select to_regclass('public.finance_settings') is not null as there`)).rows as { there: boolean }[]
  return row?.there ? (await settingsWithin(tx, tenant)).timeZone : DEFAULT_ZONE
}

/** Whether an entitlement is on, read on the caller's own transaction (a job must not use the global pool). */
export async function entitled(tx: Tx, tenant: string, moduleId: string): Promise<boolean> {
  const rows = (await tx.execute(sql`select enabled from institution_modules where institution_id = ${tenant} and module_id = ${moduleId}`)).rows as { enabled: boolean }[]
  return rows[0]?.enabled === true
}

/** The local date (`YYYY-MM-DD`) and time (`HH:MM:SS`) of an instant. */
export async function localParts(tx: Tx, at: Date, zone: string): Promise<{ day: string; time: string }> {
  const iso = at.toISOString()
  const [r] = (await tx.execute(sql`
    select (${iso}::timestamptz at time zone ${zone})::date::text as day,
           (${iso}::timestamptz at time zone ${zone})::time(0)::text as time`)).rows as { day: string; time: string }[]
  return r!
}

/**
 * The hostel night of an instant (D1321): the local date of the instant minus
 * twelve hours, so a night runs from 12:00 local to 12:00 local the next day and
 * a sweep at 00:30 still serves the evening before.
 */
export async function nightOf(tx: Tx, at: Date, zone: string): Promise<string> {
  const iso = at.toISOString()
  const [r] = (await tx.execute(sql`select ((${iso}::timestamptz - interval '12 hours') at time zone ${zone})::date::text as night`)).rows as { night: string }[]
  return r!.night
}

/** The instant at which the wall clock of `zone` reads `day` `time`. */
export async function localInstant(tx: Tx, day: string, time: string, zone: string): Promise<Date> {
  const [r] = (await tx.execute(sql`select ((${day}::date + ${time}::time) at time zone ${zone}) as t`)).rows as { t: Date | string }[]
  return new Date(r!.t)
}

/** `day` plus `n` calendar days, as `YYYY-MM-DD`. */
export async function addDays(tx: Tx, day: string, n: number): Promise<string> {
  const [r] = (await tx.execute(sql`select (${day}::date + ${n}::int)::text as d`)).rows as { d: string }[]
  return r!.d
}
