import { and, asc, desc, eq, inArray, isNull, lte, or, sql } from 'drizzle-orm'
import { withTenant } from '@campusos/db'
import {
  compOffRequests,
  leaveAllocations,
  leaveEncashments,
  leavePolicies,
  leavePolicyAssignments,
  leavePolicyLines,
  leaveTypes,
  payComponents,
  payslips,
  salaryPayments,
  staff,
} from '../schema'
import { balanceOf, balancesFor } from './balances'
import {
  HrError,
  isHr,
  requireAdmin,
  requireHr,
  shiftDays,
  tenantOf,
  today,
  type Actor,
  type Tx,
} from './guards'
import { daysInMonth, inForce } from './payroll'
import {
  allocateYearSchema,
  assignPolicySchema,
  createLeavePolicySchema,
  decideCompOffSchema,
  decideEncashmentSchema,
  manualAllocationSchema,
  requestCompOffSchema,
  requestEncashmentSchema,
} from './schemas'

/**
 * Leave as policy: who is entitled to what, what carries over, what is earned
 * by working a holiday, and what is paid out.
 *
 * The balance arithmetic lives in balances.ts, shared with the approval step,
 * so "how much do they have" has exactly one implementation.
 */

const dayBefore = (d: string) => shiftDays(d, -1)

// --- policies --------------------------------------------------------------

export async function createLeavePolicy(actor: Actor, input: unknown) {
  const tenant = requireAdmin(actor)
  const d = createLeavePolicySchema.parse(input)
  const typeIds = d.lines.map((l) => l.leaveTypeId)
  if (new Set(typeIds).size !== typeIds.length) {
    throw new HrError(400, 'duplicate_type', 'a policy names each leave type once')
  }

  return withTenant(tenant, async (tx) => {
    const known = await tx
      .select({ id: leaveTypes.id })
      .from(leaveTypes)
      .where(inArray(leaveTypes.id, typeIds))
    if (known.length !== typeIds.length) {
      throw new HrError(404, 'no_such_leave_type', 'a line names a leave type that does not exist')
    }

    const [row] = await tx
      .insert(leavePolicies)
      .values({
        institutionId: tenant,
        code: d.code,
        name: d.name,
        prorateJoiners: d.prorateJoiners,
      })
      .onConflictDoNothing()
      .returning()
    if (!row) throw new HrError(409, 'exists', 'that policy code already exists')

    await tx.insert(leavePolicyLines).values(
      d.lines.map((l) => ({
        institutionId: tenant,
        policyId: row.id,
        leaveTypeId: l.leaveTypeId,
        annualDays: l.annualDays,
      })),
    )
    return { ...row, lines: d.lines.length }
  })
}

export async function listLeavePolicies(actor: Actor) {
  const tenant = requireHr(actor)
  return withTenant(tenant, async (tx) => {
    const policies = await tx.select().from(leavePolicies).orderBy(asc(leavePolicies.code))
    if (policies.length === 0) return []
    const lines = await tx
      .select({
        policyId: leavePolicyLines.policyId,
        leaveTypeId: leavePolicyLines.leaveTypeId,
        typeCode: leaveTypes.code,
        annualDays: leavePolicyLines.annualDays,
      })
      .from(leavePolicyLines)
      .innerJoin(leaveTypes, eq(leaveTypes.id, leavePolicyLines.leaveTypeId))
      .orderBy(asc(leaveTypes.code))
    const people = await tx
      .select({
        policyId: leavePolicyAssignments.policyId,
        n: sql<number>`count(*)::int`,
      })
      .from(leavePolicyAssignments)
      .where(isNull(leavePolicyAssignments.effectiveTo))
      .groupBy(leavePolicyAssignments.policyId)

    return policies.map((p) => ({
      ...p,
      lines: lines.filter((l) => l.policyId === p.id),
      people: people.find((x) => x.policyId === p.id)?.n ?? 0,
    }))
  })
}

/**
 * Put somebody on a policy from a date. Supersedes the policy they were on,
 * closed the day before, so last year's allocation still explains itself.
 */
export async function assignPolicy(actor: Actor, input: unknown) {
  const tenant = requireAdmin(actor)
  const d = assignPolicySchema.parse(input)

  return withTenant(tenant, async (tx) => {
    const [person] = await tx.select().from(staff).where(eq(staff.id, d.staffId))
    if (!person) throw new HrError(404, 'no_such_staff', 'no such staff record')
    if (d.effectiveFrom < person.joinedOn) {
      throw new HrError(400, 'bad_dates', 'a policy cannot apply before somebody joined')
    }
    const [policy] = await tx
      .select()
      .from(leavePolicies)
      .where(eq(leavePolicies.id, d.policyId))
    if (!policy) throw new HrError(404, 'no_such_policy', 'no such leave policy')

    await tx
      .update(leavePolicyAssignments)
      .set({ effectiveTo: dayBefore(d.effectiveFrom) })
      .where(
        and(
          eq(leavePolicyAssignments.staffId, d.staffId),
          isNull(leavePolicyAssignments.effectiveTo),
          lte(leavePolicyAssignments.effectiveFrom, dayBefore(d.effectiveFrom)),
        ),
      )

    const [row] = await tx
      .insert(leavePolicyAssignments)
      .values({
        institutionId: tenant,
        staffId: d.staffId,
        policyId: d.policyId,
        effectiveFrom: d.effectiveFrom,
      })
      .returning()
    return row!
  })
}

/** Months from the joining month to December, inclusive. */
const monthsLeft = (joinedOn: string, year: number) =>
  Number(joinedOn.slice(0, 4)) < year ? 12 : 12 - (Number(joinedOn.slice(5, 7)) - 1)

/**
 * The year's leave, written down.
 *
 * For everybody employed at some point in the year: the policy in force on the
 * first day they were employed that year becomes allocations, and whatever the
 * leave type allows to carry comes across from last year. Idempotent by a
 * unique index, so running it twice -- or again after hiring somebody in June --
 * allocates only what is missing.
 */
export async function allocateYear(actor: Actor, input: unknown) {
  const tenant = requireHr(actor)
  const d = allocateYearSchema.parse(input)
  const y = d.year
  const jan1 = `${y}-01-01`
  const dec31 = `${y}-12-31`

  return withTenant(tenant, async (tx) => {
    const people = await tx
      .select()
      .from(staff)
      .where(
        and(
          d.staffId ? eq(staff.id, d.staffId) : undefined,
          lte(staff.joinedOn, dec31),
          or(isNull(staff.leftOn), sql`${staff.leftOn} >= ${jan1}`),
        ),
      )
      .orderBy(asc(staff.employeeCode))

    const types = await tx.select().from(leaveTypes)
    let allocated = 0
    let carried = 0
    let unassigned = 0

    for (const person of people) {
      const from = person.joinedOn > jan1 ? person.joinedOn : jan1
      const [assignment] = await tx
        .select()
        .from(leavePolicyAssignments)
        .where(
          and(
            eq(leavePolicyAssignments.staffId, person.id),
            lte(leavePolicyAssignments.effectiveFrom, from),
            or(
              isNull(leavePolicyAssignments.effectiveTo),
              sql`${leavePolicyAssignments.effectiveTo} >= ${from}`,
            ),
          ),
        )

      if (assignment) {
        const [policy] = await tx
          .select()
          .from(leavePolicies)
          .where(eq(leavePolicies.id, assignment.policyId))
        const lines = await tx
          .select()
          .from(leavePolicyLines)
          .where(eq(leavePolicyLines.policyId, assignment.policyId))
        const months = policy!.prorateJoiners ? monthsLeft(person.joinedOn, y) : 12

        for (const line of lines) {
          const days = Math.floor((line.annualDays * months) / 12)
          if (days < 1) continue
          const [made] = await tx
            .insert(leaveAllocations)
            .values({
              institutionId: tenant,
              staffId: person.id,
              leaveTypeId: line.leaveTypeId,
              year: y,
              days,
              source: 'policy',
              reason: months < 12 ? `${policy!.code}, ${months} of 12 months` : policy!.code,
              createdBy: actor.id,
            })
            .onConflictDoNothing()
            .returning({ id: leaveAllocations.id })
          if (made) allocated++
        }
      } else {
        unassigned++
      }

      // Carry forward, from the balance as it stood on the last day of last year.
      const carrying = types.filter((t) => t.maxCarryForward > 0)
      if (carrying.length > 0 && person.joinedOn < jan1) {
        const last = await balancesFor(tx, person.id, String(y - 1), `${y - 1}-12-31`)
        for (const t of carrying) {
          const left = last.find((b) => b.typeCode === t.code)?.remainingDays ?? 0
          const days = Math.min(Math.max(0, left ?? 0), t.maxCarryForward)
          if (days < 1) continue
          const [made] = await tx
            .insert(leaveAllocations)
            .values({
              institutionId: tenant,
              staffId: person.id,
              leaveTypeId: t.id,
              year: y,
              days,
              source: 'carry_forward',
              reason: `carried from ${y - 1}`,
              createdBy: actor.id,
            })
            .onConflictDoNothing()
            .returning({ id: leaveAllocations.id })
          if (made) carried++
        }
      }
    }

    return { year: y, people: people.length, allocated, carried, unassigned }
  })
}

export async function allocateManually(actor: Actor, input: unknown) {
  const tenant = requireAdmin(actor)
  const d = manualAllocationSchema.parse(input)

  return withTenant(tenant, async (tx) => {
    const [person] = await tx.select().from(staff).where(eq(staff.id, d.staffId))
    if (!person) throw new HrError(404, 'no_such_staff', 'no such staff record')
    const [row] = await tx
      .insert(leaveAllocations)
      .values({
        institutionId: tenant,
        staffId: d.staffId,
        leaveTypeId: d.leaveTypeId,
        year: d.year,
        days: d.days,
        source: 'manual',
        expiresOn: d.expiresOn ?? null,
        reason: d.reason,
        createdBy: actor.id,
      })
      .returning()
    return row!
  })
}

export async function listAllocations(actor: Actor, staffId: string, year?: string) {
  const tenant = requireHr(actor)
  const y = Number(year ?? new Date().getFullYear())
  return withTenant(tenant, (tx) =>
    tx
      .select({
        id: leaveAllocations.id,
        typeCode: leaveTypes.code,
        typeName: leaveTypes.name,
        year: leaveAllocations.year,
        days: leaveAllocations.days,
        source: leaveAllocations.source,
        expiresOn: leaveAllocations.expiresOn,
        reason: leaveAllocations.reason,
      })
      .from(leaveAllocations)
      .innerJoin(leaveTypes, eq(leaveTypes.id, leaveAllocations.leaveTypeId))
      .where(and(eq(leaveAllocations.staffId, staffId), eq(leaveAllocations.year, y)))
      .orderBy(asc(leaveTypes.code), asc(leaveAllocations.createdAt)),
  )
}

// --- compensatory leave ----------------------------------------------------

async function personFor(tx: Tx, actor: Actor, staffId: string) {
  const [person] = await tx.select().from(staff).where(eq(staff.id, staffId))
  if (!person) throw new HrError(404, 'no_such_staff', 'no such staff record')
  // Anyone may file for themselves; only HR may file on somebody's behalf.
  if (!isHr(actor.role) && person.userId !== actor.id) {
    throw new HrError(403, 'forbidden', 'not permitted')
  }
  return person
}

/** A claim to have worked a day off. A claim, until somebody approves it. */
export async function requestCompOff(actor: Actor, input: unknown) {
  const tenant = tenantOf(actor)
  const d = requestCompOffSchema.parse(input)

  return withTenant(tenant, async (tx) => {
    const person = await personFor(tx, actor, d.staffId)
    const [type] = await tx.select().from(leaveTypes).where(eq(leaveTypes.id, d.leaveTypeId))
    if (!type) throw new HrError(404, 'no_such_leave_type', 'no such leave type')
    if (!type.compensatory) {
      throw new HrError(400, 'not_compensatory', `${type.code} is not earned by working a day off`)
    }
    if (d.workedOn > today()) {
      throw new HrError(400, 'bad_dates', 'a day cannot be claimed before it has been worked')
    }
    if (d.workedOn < person.joinedOn || (person.leftOn && d.workedOn > person.leftOn)) {
      throw new HrError(400, 'bad_dates', 'that day falls outside the employment')
    }

    const [row] = await tx
      .insert(compOffRequests)
      .values({
        institutionId: tenant,
        staffId: d.staffId,
        leaveTypeId: d.leaveTypeId,
        workedOn: d.workedOn,
        days: d.days,
        reason: d.reason,
      })
      .onConflictDoNothing()
      .returning()
    if (!row) throw new HrError(409, 'already_claimed', 'that day has already been claimed')
    return row
  })
}

/**
 * Approving a claim is what turns it into leave: an allocation of the earned
 * days, lapsing after the type's validity when it has one.
 */
export async function decideCompOff(actor: Actor, input: unknown) {
  const tenant = requireHr(actor)
  const d = decideCompOffSchema.parse(input)

  return withTenant(tenant, async (tx) => {
    const [row] = await tx.select().from(compOffRequests).where(eq(compOffRequests.id, d.requestId))
    if (!row) throw new HrError(404, 'no_such_request', 'no such request')
    if (row.status !== 'pending') {
      throw new HrError(409, 'already_decided', `that request is already ${row.status}`)
    }
    const [person] = await tx.select().from(staff).where(eq(staff.id, row.staffId))
    if (person?.userId && person.userId === actor.id) {
      throw new HrError(403, 'self_approval', 'a claim is not approved by the person making it')
    }

    let allocationId: string | null = null
    if (d.approve) {
      const [type] = await tx.select().from(leaveTypes).where(eq(leaveTypes.id, row.leaveTypeId))
      const [alloc] = await tx
        .insert(leaveAllocations)
        .values({
          institutionId: tenant,
          staffId: row.staffId,
          leaveTypeId: row.leaveTypeId,
          year: Number(row.workedOn.slice(0, 4)),
          days: row.days,
          source: 'compensatory',
          expiresOn: type!.compOffValidityDays
            ? shiftDays(row.workedOn, type!.compOffValidityDays)
            : null,
          reason: `worked ${row.workedOn}`,
          createdBy: actor.id,
        })
        .returning({ id: leaveAllocations.id })
      allocationId = alloc!.id
    }

    const [updated] = await tx
      .update(compOffRequests)
      .set({
        status: d.approve ? 'approved' : 'rejected',
        decidedBy: actor.id,
        decidedAt: new Date(),
        decisionNote: d.note ?? null,
        allocationId,
      })
      .where(eq(compOffRequests.id, row.id))
      .returning()
    return updated!
  })
}

export async function listCompOffs(actor: Actor, pendingOnly = false) {
  const tenant = requireHr(actor)
  return withTenant(tenant, (tx) =>
    tx
      .select({
        id: compOffRequests.id,
        staffId: compOffRequests.staffId,
        staffName: staff.name,
        employeeCode: staff.employeeCode,
        typeCode: leaveTypes.code,
        workedOn: compOffRequests.workedOn,
        days: compOffRequests.days,
        reason: compOffRequests.reason,
        status: compOffRequests.status,
      })
      .from(compOffRequests)
      .innerJoin(staff, eq(staff.id, compOffRequests.staffId))
      .innerJoin(leaveTypes, eq(leaveTypes.id, compOffRequests.leaveTypeId))
      .where(pendingOnly ? eq(compOffRequests.status, 'pending') : undefined)
      .orderBy(desc(compOffRequests.workedOn))
      .limit(300),
  )
}

// --- encashment ------------------------------------------------------------

export async function requestEncashment(actor: Actor, input: unknown) {
  const tenant = tenantOf(actor)
  const d = requestEncashmentSchema.parse(input)

  return withTenant(tenant, async (tx) => {
    await personFor(tx, actor, d.staffId)
    const [type] = await tx.select().from(leaveTypes).where(eq(leaveTypes.id, d.leaveTypeId))
    if (!type) throw new HrError(404, 'no_such_leave_type', 'no such leave type')
    if (!type.encashable) {
      throw new HrError(400, 'not_encashable', `${type.code} cannot be paid out`)
    }
    await assertBalance(tx, d.staffId, d.leaveTypeId, String(d.year), d.days)

    const [row] = await tx
      .insert(leaveEncashments)
      .values({
        institutionId: tenant,
        staffId: d.staffId,
        leaveTypeId: d.leaveTypeId,
        year: d.year,
        days: d.days,
        period: d.period,
        reason: d.reason,
      })
      .returning()
    return row!
  })
}

export async function assertBalance(
  tx: Tx,
  staffId: string,
  leaveTypeId: string,
  year: string,
  days: number,
) {
  const b = await balanceOf(tx, staffId, leaveTypeId, year)
  if (!b) throw new HrError(404, 'no_such_leave_type', 'no such leave type')
  if (b.remainingDays !== null && !b.allowNegative && days > b.remainingDays) {
    throw new HrError(
      409,
      'insufficient_balance',
      `${days} days asked for, ${b.remainingDays} of ${b.typeCode} left in ${year}`,
    )
  }
}

/**
 * Approving a payout fixes its amount: a day's worth of the components the
 * leave type names, from the pay in force that month, over the days in it --
 * the same per-day figure loss of pay uses, so selling a day back and losing
 * one cost the same.
 */
export async function decideEncashment(actor: Actor, input: unknown) {
  const tenant = requireAdmin(actor)
  const d = decideEncashmentSchema.parse(input)

  return withTenant(tenant, async (tx) => {
    const [row] = await tx
      .select()
      .from(leaveEncashments)
      .where(eq(leaveEncashments.id, d.requestId))
    if (!row) throw new HrError(404, 'no_such_request', 'no such request')
    if (row.status !== 'pending') {
      throw new HrError(409, 'already_decided', `that request is already ${row.status}`)
    }

    if (!d.approve) {
      const [updated] = await tx
        .update(leaveEncashments)
        .set({ status: 'rejected', decidedBy: actor.id, decidedAt: new Date() })
        .where(eq(leaveEncashments.id, row.id))
        .returning()
      return updated!
    }

    const [paid] = await tx
      .select({ id: salaryPayments.id })
      .from(salaryPayments)
      .where(eq(salaryPayments.period, row.period))
    const [slip] = await tx
      .select({ id: payslips.id })
      .from(payslips)
      .where(and(eq(payslips.staffId, row.staffId), eq(payslips.period, row.period)))
    if (paid || slip) {
      throw new HrError(
        409,
        'payroll_run',
        `payroll for ${row.period.slice(0, 7)} has already run for them; pick a later month`,
      )
    }

    await assertBalance(tx, row.staffId, row.leaveTypeId, String(row.year), row.days)

    const [type] = await tx.select().from(leaveTypes).where(eq(leaveTypes.id, row.leaveTypeId))
    const components = await tx
      .select()
      .from(payComponents)
      .where(eq(payComponents.staffId, row.staffId))
    const basis = components
      .filter(
        (c) =>
          c.kind === 'earning' &&
          type!.encashmentComponents.includes(c.code) &&
          inForce(c, row.period),
      )
      .reduce((n, c) => n + c.amountPaise, 0)
    if (basis === 0) {
      throw new HrError(
        409,
        'no_basis',
        `none of ${type!.encashmentComponents.join(', ')} is in force for them in ${row.period.slice(0, 7)}`,
      )
    }

    const perDay = Math.round(basis / daysInMonth(new Date(`${row.period}T00:00:00Z`)))
    const [updated] = await tx
      .update(leaveEncashments)
      .set({
        status: 'approved',
        amountPaise: perDay * row.days,
        decidedBy: actor.id,
        decidedAt: new Date(),
      })
      .where(eq(leaveEncashments.id, row.id))
      .returning()
    return updated!
  })
}

export async function listEncashments(actor: Actor) {
  const tenant = requireHr(actor)
  return withTenant(tenant, (tx) =>
    tx
      .select({
        id: leaveEncashments.id,
        staffId: leaveEncashments.staffId,
        staffName: staff.name,
        employeeCode: staff.employeeCode,
        typeCode: leaveTypes.code,
        year: leaveEncashments.year,
        days: leaveEncashments.days,
        period: leaveEncashments.period,
        amountPaise: leaveEncashments.amountPaise,
        status: leaveEncashments.status,
        paid: sql<boolean>`${leaveEncashments.payslipId} is not null`,
        reason: leaveEncashments.reason,
      })
      .from(leaveEncashments)
      .innerJoin(staff, eq(staff.id, leaveEncashments.staffId))
      .innerJoin(leaveTypes, eq(leaveTypes.id, leaveEncashments.leaveTypeId))
      .orderBy(desc(leaveEncashments.createdAt))
      .limit(300),
  )
}

/** Approved, unpaid encashments for one person in one payroll month. */
export async function encashmentsDue(tx: Tx, staffId: string, period: string) {
  return tx
    .select()
    .from(leaveEncashments)
    .where(
      and(
        eq(leaveEncashments.staffId, staffId),
        eq(leaveEncashments.period, period),
        eq(leaveEncashments.status, 'approved'),
        isNull(leaveEncashments.payslipId),
      ),
    )
}
