import { sql } from 'drizzle-orm'
import type { withTenant } from '@campusos/db'
import { settingsWithin } from '@campusos/module-finance/api'
import { DEFAULT_ZONE } from './rules'

type Tx = Parameters<Parameters<typeof withTenant>[1]>[0]

/**
 * Wall-clock helpers for the door and the closing sweep (P2-22a, D1310).
 *
 * Every function takes the instant it should reason about, never SQL `now()`,
 * so a test (and the sweep) can set the clock. The zone is the one the books
 * keep, or India's when the institution keeps none.
 */
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

/** The instant at which the wall clock of `zone` reads `day` `time`. */
export async function localInstant(tx: Tx, day: string, time: string, zone: string): Promise<Date> {
  const [r] = (await tx.execute(sql`select (((${day}::date + ${time}::time)) at time zone ${zone})::timestamptz as t`)).rows as { t: Date | string }[]
  return new Date(r!.t)
}

export interface PresenceSettings {
  opensAt: string
  closesAt: string
  closingReminderMin: number
  autoCloseAfterMin: number
  presenceRetentionDays: number
}

export const DEFAULT_PRESENCE: PresenceSettings = {
  opensAt: '09:00:00',
  closesAt: '20:00:00',
  closingReminderMin: 15,
  autoCloseAfterMin: 30,
  presenceRetentionDays: 90,
}

/** Door hours and sweep timings, or the defaults when the library has no settings row yet. */
export async function presenceSettings(tx: Tx, tenant: string): Promise<PresenceSettings> {
  const rows = (await tx.execute(sql`
    select opens_at::text as "opensAt", closes_at::text as "closesAt", closing_reminder_min as "closingReminderMin",
           auto_close_after_min as "autoCloseAfterMin", presence_retention_days as "presenceRetentionDays"
      from library_settings where institution_id = ${tenant}`)).rows as unknown as PresenceSettings[]
  return rows[0] ?? DEFAULT_PRESENCE
}
