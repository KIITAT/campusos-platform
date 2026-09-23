import { and, asc, desc, eq, gte, inArray, isNull, lte, or, sql } from 'drizzle-orm'
import { withTenant } from '@campusos/db'
import {
  leaveRequests,
  payslips,
  shiftAssignments,
  shiftRequests,
  shiftTypes,
  staff,
} from '../schema'
import {
  HrError,
  isHr,
  requireHr,
  shiftDays,
  tenantOf,
  type Actor,
  type Tx,
} from './guards'
import type { Component } from './payroll'
import {
  assignShiftSchema,
  createShiftTypeSchema,
  decideShiftSchema,
  requestShiftSchema,
  rotateShiftsSchema,
} from './schemas'

/**
 * Shifts: kinds of shift, who is on which, requests to swap, weekly rotations,
 * and the roster that falls out of them.
 *
 * Assignments never overlap for one person -- the database refuses it -- so
 * placing a new one carves the old ones around it: the part before stays, the
 * part after resumes, the part underneath goes. That is what "cover nights for
 * two weeks, then back to days" means, and it is one operation here rather than
 * three edits somebody has to get in the right order.
 */

const errCode = (e: unknown) =>
  (e as { cause?: { code?: string } }).cause?.code ?? (e as { code?: string }).code

// --- shift types -----------------------------------------------------------

export async function createShiftType(actor: Actor, input: unknown) {
  const tenant = requireHr(actor)
  const d = createShiftTypeSchema.parse(input)
  return withTenant(tenant, async (tx) => {
    const [row] = await tx
      .insert(shiftTypes)
      .values({
        institutionId: tenant,
        code: d.code,
        name: d.name,
        startsAt: d.startsAt,
        endsAt: d.endsAt,
        breakMinutes: d.breakMinutes,
        allowancePaise: d.allowance,
      })
      .onConflictDoNothing()
      .returning()
    if (!row) throw new HrError(409, 'exists', 'that shift code already exists')
    return row
  })
}

/** Paid working minutes in a shift, across midnight when it ends before it starts. */
export const shiftMinutes = (startsAt: string, endsAt: string, breakMinutes = 0) => {
  const m = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5))
  const span = (m(endsAt) - m(startsAt) + 24 * 60) % (24 * 60)
  return Math.max(0, span - breakMinutes)
}

export async function listShiftTypes(actor: Actor) {
  const tenant = requireHr(actor)
  return withTenant(tenant, async (tx) => {
    const rows = await tx.select().from(shiftTypes).orderBy(asc(shiftTypes.code))
    return rows.map((r) => ({
      ...r,
      hours: shiftMinutes(r.startsAt, r.endsAt, r.breakMinutes) / 60,
      overnight: r.endsAt < r.startsAt,
    }))
  })
}

// --- placing a shift -------------------------------------------------------

/**
 * Put somebody on a shift over [from, to], carving existing assignments around
 * it. `to` null means until further notice, which replaces everything after.
 *
 * Refused on a month payroll has already run for this person: the allowance on
 * that payslip was computed from the roster as it stood, and quietly changing
 * the roster underneath it would make the document disagree with its inputs.
 */
async function place(
  tx: Tx,
  tenant: string,
  actorId: string,
  p: { staffId: string; shiftTypeId: string; fromOn: string; toOn: string | null; requestId?: string },
) {
  const [person] = await tx.select().from(staff).where(eq(staff.id, p.staffId))
  if (!person) throw new HrError(404, 'no_such_staff', 'no such staff record')
  const [type] = await tx.select().from(shiftTypes).where(eq(shiftTypes.id, p.shiftTypeId))
  if (!type) throw new HrError(404, 'no_such_shift', 'no such shift type')

  const [slip] = await tx
    .select({ period: payslips.period })
    .from(payslips)
    .where(
      and(
        eq(payslips.staffId, p.staffId),
        gte(payslips.period, `${p.fromOn.slice(0, 7)}-01`),
      ),
    )
    .limit(1)
  if (slip) {
    throw new HrError(
      409,
      'payroll_run',
      `payroll for ${slip.period.slice(0, 7)} has already run for them; the roster before it stands`,
    )
  }

  const overlapping = await tx
    .select()
    .from(shiftAssignments)
    .where(
      and(
        eq(shiftAssignments.staffId, p.staffId),
        or(isNull(shiftAssignments.toOn), gte(shiftAssignments.toOn, p.fromOn)),
        p.toOn ? lte(shiftAssignments.fromOn, p.toOn) : undefined,
      ),
    )

  for (const a of overlapping) {
    const runsPast = p.toOn !== null && (a.toOn === null || a.toOn > p.toOn)
    if (a.fromOn < p.fromOn) {
      // The part before stays.
      await tx
        .update(shiftAssignments)
        .set({ toOn: shiftDays(p.fromOn, -1) })
        .where(eq(shiftAssignments.id, a.id))
      if (runsPast) {
        // ...and the part after resumes.
        await tx.insert(shiftAssignments).values({
          institutionId: tenant,
          staffId: a.staffId,
          shiftTypeId: a.shiftTypeId,
          fromOn: shiftDays(p.toOn!, 1),
          toOn: a.toOn,
          createdBy: actorId,
        })
      }
    } else if (runsPast) {
      await tx
        .update(shiftAssignments)
        .set({ fromOn: shiftDays(p.toOn!, 1) })
        .where(eq(shiftAssignments.id, a.id))
    } else {
      await tx.delete(shiftAssignments).where(eq(shiftAssignments.id, a.id))
    }
  }

  try {
    const [row] = await tx
      .insert(shiftAssignments)
      .values({
        institutionId: tenant,
        staffId: p.staffId,
        shiftTypeId: p.shiftTypeId,
        fromOn: p.fromOn,
        toOn: p.toOn,
        requestId: p.requestId ?? null,
        createdBy: actorId,
      })
      .returning()
    return row!
  } catch (e) {
    if (errCode(e) === '23514') {
      throw new HrError(400, 'outside_employment', 'that shift falls outside the employment')
    }
    throw e
  }
}

export async function assignShift(actor: Actor, input: unknown) {
  const tenant = requireHr(actor)
  const d = assignShiftSchema.parse(input)
  if (d.toOn && d.toOn < d.fromOn) throw new HrError(400, 'bad_dates', 'a shift cannot end before it starts')
  return withTenant(tenant, (tx) =>
    place(tx, tenant, actor.id, {
      staffId: d.staffId,
      shiftTypeId: d.shiftTypeId,
      fromOn: d.fromOn,
      toOn: d.toOn ?? null,
    }),
  )
}

/**
 * A weekly rotation: person i gets shift (i + week) mod n, week after week. The
 * pattern hostels and security actually run, written as ordinary assignments
 * so everything downstream -- the roster, the payslip -- reads one thing.
 */
export async function rotateShifts(actor: Actor, input: unknown) {
  const tenant = requireHr(actor)
  const d = rotateShiftsSchema.parse(input)
  return withTenant(tenant, async (tx) => {
    let made = 0
    for (let w = 0; w < d.weeks; w++) {
      const from = shiftDays(d.fromOn, 7 * w)
      const to = shiftDays(from, 6)
      for (let i = 0; i < d.staffIds.length; i++) {
        await place(tx, tenant, actor.id, {
          staffId: d.staffIds[i]!,
          shiftTypeId: d.shiftTypeIds[(i + w) % d.shiftTypeIds.length]!,
          fromOn: from,
          toOn: to,
        })
        made++
      }
    }
    return { assignments: made, from: d.fromOn, to: shiftDays(d.fromOn, 7 * d.weeks - 1) }
  })
}

// --- requests --------------------------------------------------------------

export async function requestShift(actor: Actor, input: unknown) {
  const tenant = tenantOf(actor)
  const d = requestShiftSchema.parse(input)
  if (d.toOn < d.fromOn) throw new HrError(400, 'bad_dates', 'a shift cannot end before it starts')

  return withTenant(tenant, async (tx) => {
    const [person] = await tx.select().from(staff).where(eq(staff.id, d.staffId))
    if (!person) throw new HrError(404, 'no_such_staff', 'no such staff record')
    if (!isHr(actor.role) && person.userId !== actor.id) {
      throw new HrError(403, 'forbidden', 'not permitted')
    }
    const [row] = await tx
      .insert(shiftRequests)
      .values({
        institutionId: tenant,
        staffId: d.staffId,
        shiftTypeId: d.shiftTypeId,
        fromOn: d.fromOn,
        toOn: d.toOn,
        reason: d.reason,
      })
      .returning()
    return row!
  })
}

export async function decideShift(actor: Actor, input: unknown) {
  const tenant = requireHr(actor)
  const d = decideShiftSchema.parse(input)
  return withTenant(tenant, async (tx) => {
    const [row] = await tx.select().from(shiftRequests).where(eq(shiftRequests.id, d.requestId))
    if (!row) throw new HrError(404, 'no_such_request', 'no such request')
    if (row.status !== 'pending') {
      throw new HrError(409, 'already_decided', `that request is already ${row.status}`)
    }
    const [person] = await tx.select().from(staff).where(eq(staff.id, row.staffId))
    if (person?.userId && person.userId === actor.id) {
      throw new HrError(403, 'self_approval', 'a shift request is not approved by the person making it')
    }
    if (d.approve) {
      await place(tx, tenant, actor.id, {
        staffId: row.staffId,
        shiftTypeId: row.shiftTypeId,
        fromOn: row.fromOn,
        toOn: row.toOn,
        requestId: row.id,
      })
    }
    const [updated] = await tx
      .update(shiftRequests)
      .set({
        status: d.approve ? 'approved' : 'rejected',
        decidedBy: actor.id,
        decidedAt: new Date(),
        decisionNote: d.note ?? null,
      })
      .where(eq(shiftRequests.id, row.id))
      .returning()
    return updated!
  })
}

export async function listShiftRequests(actor: Actor, pendingOnly = false) {
  const tenant = requireHr(actor)
  return withTenant(tenant, (tx) =>
    tx
      .select({
        id: shiftRequests.id,
        staffId: shiftRequests.staffId,
        staffName: staff.name,
        employeeCode: staff.employeeCode,
        shiftCode: shiftTypes.code,
        fromOn: shiftRequests.fromOn,
        toOn: shiftRequests.toOn,
        reason: shiftRequests.reason,
        status: shiftRequests.status,
      })
      .from(shiftRequests)
      .innerJoin(staff, eq(staff.id, shiftRequests.staffId))
      .innerJoin(shiftTypes, eq(shiftTypes.id, shiftRequests.shiftTypeId))
      .where(pendingOnly ? eq(shiftRequests.status, 'pending') : undefined)
      .orderBy(desc(shiftRequests.fromOn))
      .limit(300),
  )
}

// --- the roster ------------------------------------------------------------

const eachDay = (from: string, to: string) => {
  const out: string[] = []
  for (let d = from; d <= to; d = shiftDays(d, 1)) out.push(d)
  return out
}

/**
 * Who is on what, day by day. Approved leave shows through the shift: a warden
 * rostered on nights and on leave that night is not on nights, and both the
 * roll call and the allowance need to know that.
 */
async function rosterWithin(tx: Tx, from: string, to: string, staffIds?: string[]) {
  const assignments = await tx
    .select({
      staffId: shiftAssignments.staffId,
      fromOn: shiftAssignments.fromOn,
      toOn: shiftAssignments.toOn,
      shiftTypeId: shiftAssignments.shiftTypeId,
      code: shiftTypes.code,
      allowancePaise: shiftTypes.allowancePaise,
      name: shiftTypes.name,
    })
    .from(shiftAssignments)
    .innerJoin(shiftTypes, eq(shiftTypes.id, shiftAssignments.shiftTypeId))
    .where(
      and(
        lte(shiftAssignments.fromOn, to),
        or(isNull(shiftAssignments.toOn), gte(shiftAssignments.toOn, from)),
        staffIds ? inArray(shiftAssignments.staffId, staffIds) : undefined,
      ),
    )

  const leave = await tx
    .select({ staffId: leaveRequests.staffId, fromOn: leaveRequests.fromOn, toOn: leaveRequests.toOn })
    .from(leaveRequests)
    .where(
      and(
        eq(leaveRequests.status, 'approved'),
        lte(leaveRequests.fromOn, to),
        gte(leaveRequests.toOn, from),
        staffIds ? inArray(leaveRequests.staffId, staffIds) : undefined,
      ),
    )

  const days = eachDay(from, to)
  const byStaff = new Map<string, Map<string, (typeof assignments)[number] | 'leave'>>()
  for (const a of assignments) {
    const m = byStaff.get(a.staffId) ?? new Map()
    for (const day of days) {
      if (day >= a.fromOn && (a.toOn === null || day <= a.toOn)) m.set(day, a)
    }
    byStaff.set(a.staffId, m)
  }
  for (const l of leave) {
    const m = byStaff.get(l.staffId)
    if (!m) continue
    for (const day of days) if (day >= l.fromOn && day <= l.toOn && m.has(day)) m.set(day, 'leave')
  }
  return { days, byStaff }
}

export async function roster(actor: Actor, from: string, to: string) {
  const tenant = requireHr(actor)
  if (to < from) throw new HrError(400, 'bad_dates', 'a roster cannot end before it starts')
  if (eachDay(from, to).length > 62) throw new HrError(400, 'too_long', 'at most two months at a time')
  return withTenant(tenant, async (tx) => {
    const { days, byStaff } = await rosterWithin(tx, from, to)
    const people = byStaff.size
      ? await tx.select().from(staff).where(inArray(staff.id, [...byStaff.keys()])).orderBy(asc(staff.employeeCode))
      : []
    return {
      days,
      rows: people.map((p) => ({
        staffId: p.id,
        employeeCode: p.employeeCode,
        staffName: p.name,
        days: days.map((d) => {
          const v = byStaff.get(p.id)?.get(d)
          return v === undefined ? '' : v === 'leave' ? 'leave' : v.code
        }),
      })),
    }
  })
}

/**
 * What a month of shifts adds to somebody's payslip: each shift type's
 * allowance, times the days actually on it -- rostered, employed, and not on
 * leave. One line per shift type, so the payslip says what it is paying for.
 */
export async function shiftAllowances(
  tx: Tx,
  person: { id: string; joinedOn: string; leftOn: string | null },
  period: string,
): Promise<Component[]> {
  const monthStart = `${period.slice(0, 7)}-01`
  const next = new Date(`${monthStart}T00:00:00Z`)
  next.setUTCMonth(next.getUTCMonth() + 1)
  const monthEnd = shiftDays(next.toISOString().slice(0, 10), -1)
  const from = person.joinedOn > monthStart ? person.joinedOn : monthStart
  const to = person.leftOn && person.leftOn < monthEnd ? person.leftOn : monthEnd
  if (to < from) return []

  const { byStaff } = await rosterWithin(tx, from, to, [person.id])
  const counts = new Map<string, { code: string; name: string; allowance: number; days: number }>()
  for (const v of byStaff.get(person.id)?.values() ?? []) {
    if (v === 'leave' || v.allowancePaise === 0) continue
    const c = counts.get(v.shiftTypeId) ?? { code: v.code, name: v.name, allowance: v.allowancePaise, days: 0 }
    c.days++
    counts.set(v.shiftTypeId, c)
  }
  return [...counts.values()].map((c) => ({
    code: `shift:${c.code}`,
    label: `${c.name} allowance, ${c.days} days`,
    kind: 'earning' as const,
    amountPaise: c.allowance * c.days,
  }))
}

/** How many people are on each shift today. */
export async function shiftCoverage(actor: Actor, on: string) {
  const tenant = requireHr(actor)
  return withTenant(tenant, (tx) =>
    tx
      .select({
        code: shiftTypes.code,
        name: shiftTypes.name,
        people: sql<number>`count(${shiftAssignments.id})::int`,
      })
      .from(shiftTypes)
      .leftJoin(
        shiftAssignments,
        and(
          eq(shiftAssignments.shiftTypeId, shiftTypes.id),
          lte(shiftAssignments.fromOn, on),
          or(isNull(shiftAssignments.toOn), gte(shiftAssignments.toOn, on)),
        ),
      )
      .groupBy(shiftTypes.code, shiftTypes.name)
      .orderBy(asc(shiftTypes.code)),
  )
}
