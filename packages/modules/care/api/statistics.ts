import { and, asc, eq, gte, sql } from 'drizzle-orm'
import { withTenant } from '@campusos/db'
import { appointments, counsellors, instruments, requests, results, settings } from '../schema'
import { BUILT_IN, type CheckBand } from './instruments'
import { CareError, words, type Actor } from './operations'
import { periodSchema } from './schemas'

/**
 * Counselling statistics, as KIIT's reports list them -- and counts only.
 *
 * What describes the service -- requests received, how long they waited,
 * appointments held and missed, each counsellor's load -- is shown as it is.
 * What describes students -- what they asked about, how their self-checks
 * came out -- is a count of people, and a small count of people in a small
 * college is a person: so any count from 1 to 4 is shown as "fewer than 5",
 * and where that alone could be worked out from the total, the next smallest
 * count beside it is hidden too.
 */

/** The smallest count shown as itself. */
export const SMALL = 5

/**
 * Hide the small counts of one group -- the bands of one check, the topics
 * asked about -- so that none can be read off, and none worked out from the
 * group's total by subtraction. Null means hidden; zero is shown, since
 * "nobody" names nobody.
 */
export function suppress(counts: number[]): (number | null)[] {
  const out: (number | null)[] = counts.map((n) => (n > 0 && n < SMALL ? null : n))
  const hidden = out.filter((n) => n === null).length
  if (hidden === 1) {
    // One hidden cell is the total minus the rest. Hide the next smallest too.
    let at = -1
    out.forEach((n, i) => {
      if (n !== null && n > 0 && (at < 0 || n < (out[at] as number))) at = i
    })
    if (at >= 0) out[at] = null
  }
  return out
}

export const shown = (n: number | null) => (n === null ? 'fewer than 5' : String(n))
/** A count on its own -- a total, a single figure. */
export const alone = (n: number) => shown(n > 0 && n < SMALL ? null : n)

const PERIODS = { '30d': 'the last 30 days', '12m': 'the last 12 months', all: 'all time' } as const

const median = (xs: number[]) => {
  if (!xs.length) return null
  const s = [...xs].sort((a, b) => a - b)
  const m = Math.floor(s.length / 2)
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2
}

export async function statistics(actor: Actor, periodInput?: string | null) {
  if (!actor.institutionId) throw new CareError(400, 'no_institution', 'no institution for this session')
  const tenant = actor.institutionId
  const period = periodSchema.parse(periodInput ?? undefined)
  return withTenant(tenant, async (tx) => {
    const admin = actor.role === 'institution_admin' || actor.role === 'super_admin'
    const [mine] = await tx
      .select({ id: counsellors.id })
      .from(counsellors)
      .where(and(eq(counsellors.userId, actor.id), eq(counsellors.active, true)))
    if (!admin && !mine) throw new CareError(403, 'forbidden', 'the office and the counsellors see these')

    const [s] = await tx.select({ timeZone: settings.timeZone }).from(settings).where(eq(settings.institutionId, tenant))
    const zone = s?.timeZone ?? 'Asia/Kolkata'
    const since =
      period === '30d' ? new Date(Date.now() - 30 * 86_400_000) : period === '12m' ? new Date(Date.now() - 365 * 86_400_000) : null
    const asked = since ? gte(requests.createdAt, since) : undefined

    const all = await tx.select().from(requests).where(asked)
    const firstAppointment = await tx
      .select({ requestId: appointments.requestId, first: sql<string>`min(${appointments.startsAt})` })
      .from(appointments)
      .where(sql`${appointments.status} in ('booked', 'held')`)
      .groupBy(appointments.requestId)
    const firstOf = new Map(firstAppointment.map((f) => [f.requestId, new Date(f.first)]))
    const days = (a: Date, b: Date) => (b.getTime() - a.getTime()) / 86_400_000
    // A session recorded after the fact -- a walk-in written up later -- can
    // start before the request was made: that is no wait, not a negative one.
    const toTaken = all.filter((r) => r.acceptedAt).map((r) => Math.max(0, days(r.createdAt, r.acceptedAt!)))
    const toFirst = all.filter((r) => firstOf.has(r.id)).map((r) => Math.max(0, days(r.createdAt, firstOf.get(r.id)!)))
    const round = (n: number | null) =>
      n === null ? '—' : n < 1 / 24 ? 'under an hour' : n < 1 ? `${Math.round(n * 24)} hours` : `${Math.round(n * 10) / 10} days`

    const appts = await tx
      .select({ status: appointments.status, n: sql<number>`count(*)`.mapWith(Number) })
      .from(appointments)
      .where(since ? gte(appointments.startsAt, since) : undefined)
      .groupBy(appointments.status)
    const count = (st: string) => appts.find((a) => a.status === st)?.n ?? 0

    const months = await tx.execute(sql`
      select to_char(date_trunc('month', created_at at time zone ${zone}), 'YYYY-MM') as month,
             count(*)::int as requests,
             count(*) filter (where urgency = 'today')::int as today,
             count(*) filter (where accepted_at is not null)::int as taken,
             count(*) filter (where status = 'closed')::int as closed
        from care_requests
       where ${since ? sql`created_at >= ${since}` : sql`true`}
       group by 1 order by 1`)

    const byTopic = Object.keys(words.topics).map((t) => all.filter((r) => r.topic === t).length)
    const topicShown = suppress(byTopic)

    const taken = await tx
      .select({
        code: results.instrumentCode,
        id: results.instrumentId,
        rank: results.bandRank,
        band: results.band,
        n: sql<number>`count(*)`.mapWith(Number),
      })
      .from(results)
      .where(since ? gte(results.takenAt, since) : undefined)
      .groupBy(results.instrumentCode, results.instrumentId, results.bandRank, results.band)
    const own = await tx.select().from(instruments).orderBy(asc(instruments.name))
    const checks = [
      ...BUILT_IN.map((c) => ({ key: `b:${c.code}`, name: c.name, bands: c.bands, match: (t: (typeof taken)[number]) => !t.id && t.code.toUpperCase() === c.code.toUpperCase() })),
      ...own.map((c) => ({ key: `i:${c.id}`, name: c.name, bands: c.bands as CheckBand[], match: (t: (typeof taken)[number]) => t.id === c.id })),
    ]
    const checkRows = checks.flatMap((c) => {
      const counts = c.bands.map((_, i) => taken.filter((t) => c.match(t) && t.rank === i).reduce((n, t) => n + t.n, 0))
      const total = counts.reduce((a, b) => a + b, 0)
      if (!total) return []
      const hidden = suppress(counts)
      return [
        { check: c.name, band: 'All', count: alone(total), total: true },
        ...c.bands.map((b, i) => ({ check: c.name, band: b.label, count: shown(hidden[i]!), total: false })),
      ]
    })
    const [people] = await tx
      .select({
        students: sql<number>`count(distinct ${results.studentId})`.mapWith(Number),
        safety: sql<number>`count(*) filter (where ${results.safety})`.mapWith(Number),
      })
      .from(results)
      .where(since ? gte(results.takenAt, since) : undefined)

    const load = await tx.execute(sql`
      select u.name, c.title, c.active,
             (select count(*) from care_requests q where q.counsellor_id = c.user_id and q.status = 'accepted')::int as open,
             (select count(*) from care_appointments a where a.counsellor_id = c.user_id and a.status = 'held'
                and ${since ? sql`a.starts_at >= ${since}` : sql`true`})::int as held
        from care_counsellors c join users u on u.id = c.user_id
       order by c.active desc, u.name`)

    return {
      period,
      periodText: PERIODS[period],
      figures: {
        requests: all.length,
        waiting: all.filter((r) => r.status === 'waiting').length,
        medianToTaken: round(median(toTaken)),
        medianToFirst: round(median(toFirst)),
        held: count('held'),
        missed: count('missed'),
        students: alone(people?.students ?? 0),
        safety: alone(people?.safety ?? 0),
      },
      months: (months.rows as { month: string; requests: number; today: number; taken: number; closed: number }[]).map((m) => ({ ...m })),
      topics: Object.entries(words.topics).map(([, label], i) => ({ topic: label, count: shown(topicShown[i]!) })),
      outcomes: Object.entries(words.outcomes).map(([k, label]) => ({ outcome: label, count: all.filter((r) => r.outcome === k).length })),
      checks: checkRows,
      counsellors: (load.rows as { name: string | null; title: string; active: boolean; open: number; held: number }[]).map((c) => ({
        name: c.name ?? '',
        title: c.title,
        state: c.active ? 'active' : 'inactive',
        open: c.open,
        held: c.held,
      })),
    }
  })
}

