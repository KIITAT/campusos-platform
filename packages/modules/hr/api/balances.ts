import { and, asc, eq, sql } from 'drizzle-orm'
import { leaveAllocations, leaveEncashments, leaveRequests, leaveTypes } from '../schema'
import { spanDays, today, type Tx } from './guards'
import type { LeaveBalance } from './schemas'

/**
 * What somebody has left, per leave type, for a year.
 *
 * The base entitlement is chosen per person and type:
 *
 *   - No policy or manual allocation: the leave type's own annual figure, the
 *     same for everybody. How an institution that never defines a policy keeps
 *     working exactly as it did.
 *   - Any policy or manual allocation: their sum. Once somebody has been given
 *     ten days by policy, the type's default twelve stops applying -- otherwise
 *     they would quietly have both.
 *
 * Carried-forward and earned (compensatory) days add on top of either base,
 * because neither is a statement about what the person is entitled to; they
 * are days already owed. Lapsed allocations stop counting from their expiry.
 *
 * Taken is approved leave starting in the year; encashed is approved payouts
 * against it. Unlimited -- a zero-day type with nothing allocated, and not a
 * compensatory type -- reports remaining as null, never as zero.
 */
export async function balancesFor(
  tx: Tx,
  staffId: string,
  year: string,
  asOf: string = today(),
): Promise<LeaveBalance[]> {
  const y = Number(year)
  const types = await tx.select().from(leaveTypes).orderBy(asc(leaveTypes.code))

  const taken = await tx
    .select({
      leaveTypeId: leaveRequests.leaveTypeId,
      fromOn: leaveRequests.fromOn,
      toOn: leaveRequests.toOn,
    })
    .from(leaveRequests)
    .where(
      and(
        eq(leaveRequests.staffId, staffId),
        eq(leaveRequests.status, 'approved'),
        sql`extract(year from ${leaveRequests.fromOn}) = ${y}`,
      ),
    )

  const allocations = await tx
    .select()
    .from(leaveAllocations)
    .where(and(eq(leaveAllocations.staffId, staffId), eq(leaveAllocations.year, y)))

  const encashed = await tx
    .select({ leaveTypeId: leaveEncashments.leaveTypeId, days: leaveEncashments.days })
    .from(leaveEncashments)
    .where(
      and(
        eq(leaveEncashments.staffId, staffId),
        eq(leaveEncashments.year, y),
        eq(leaveEncashments.status, 'approved'),
      ),
    )

  return types.map((t) => {
    const mine = allocations.filter((a) => a.leaveTypeId === t.id)
    const live = mine.filter((a) => a.expiresOn === null || a.expiresOn >= asOf)
    const isBase = (a: (typeof mine)[number]) => a.source === 'policy' || a.source === 'manual'
    const managed = mine.some(isBase)
    const base = managed
      ? live.filter(isBase).reduce((n, a) => n + a.days, 0)
      : t.annualDays
    const extras = live.filter((a) => !isBase(a)).reduce((n, a) => n + a.days, 0)
    const entitlement = base + extras

    const takenDays = taken
      .filter((l) => l.leaveTypeId === t.id)
      .reduce((n, l) => n + spanDays(l.fromOn, l.toOn), 0)
    const encashedDays = encashed
      .filter((e) => e.leaveTypeId === t.id)
      .reduce((n, e) => n + e.days, 0)

    // A compensatory type starts at nothing and is never unlimited: its days are
    // earned one at a time, and a zero default must not read as "take any".
    const unlimited = !managed && t.annualDays === 0 && extras === 0 && !t.compensatory
    const raw = entitlement - takenDays - encashedDays
    return {
      typeCode: t.code,
      typeName: t.name,
      annualDays: entitlement,
      takenDays,
      encashedDays,
      // Overdrawn shows as overdrawn only where overdrawing is allowed; anywhere
      // else a negative figure is old data, and zero is the true answer to "how
      // much more may they take".
      remainingDays: unlimited ? null : t.allowNegative ? raw : Math.max(0, raw),
      managed,
    }
  })
}

/** One type's balance, or null when the type does not exist. */
export async function balanceOf(
  tx: Tx,
  staffId: string,
  leaveTypeId: string,
  year: string,
  asOf?: string,
): Promise<(LeaveBalance & { allowNegative: boolean }) | null> {
  const [type] = await tx.select().from(leaveTypes).where(eq(leaveTypes.id, leaveTypeId))
  if (!type) return null
  const all = await balancesFor(tx, staffId, year, asOf)
  const found = all.find((b) => b.typeCode === type.code)
  return found ? { ...found, allowNegative: type.allowNegative } : null
}
