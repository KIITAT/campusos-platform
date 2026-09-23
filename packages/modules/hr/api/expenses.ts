import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm'
import { withTenant } from '@campusos/db'
import {
  advanceRecoveries,
  employeeAdvances,
  expenseClaimLines,
  expenseClaims,
  staff,
} from '../schema'
import { HrError, isHr, requireAdmin, requireHr, tenantOf, today, type Actor, type Tx } from './guards'
import type { Component } from './payroll'
import {
  postAdvancePaid,
  postAdvanceRepaid,
  postClaimApproved,
  postClaimSettled,
} from './posting'
import {
  decideAdvanceSchema,
  decideClaimSchema,
  payAdvanceSchema,
  repayAdvanceSchema,
  requestAdvanceSchema,
  settleClaimSchema,
  submitClaimInput,
} from './schemas'

/**
 * Money between the institution and its staff, outside payroll.
 *
 * A claim is asked, approved (perhaps for less, line by line), and settled.
 * An advance is asked, approved, handed over, and then comes back -- set
 * against a claim, deducted from pay, or repaid -- and every way it comes back
 * is a recovery row the outstanding figure is computed from. Each step posts
 * to the books in the same transaction, so what HR says is owed and what the
 * ledger says is owed are the same number.
 */

async function personFor(tx: Tx, actor: Actor, staffId: string) {
  const [person] = await tx.select().from(staff).where(eq(staff.id, staffId))
  if (!person) throw new HrError(404, 'no_such_staff', 'no such staff record')
  if (!isHr(actor.role) && person.userId !== actor.id) {
    throw new HrError(403, 'forbidden', 'not permitted')
  }
  return person
}

// --- claims ----------------------------------------------------------------

export async function submitClaim(actor: Actor, input: unknown) {
  const tenant = tenantOf(actor)
  const d = submitClaimInput.parse(input)
  if (d.lines.some((l) => l.spentOn > today())) {
    throw new HrError(400, 'bad_dates', 'money cannot be claimed before it is spent')
  }
  return withTenant(tenant, async (tx) => {
    await personFor(tx, actor, d.staffId)
    const [claim] = await tx
      .insert(expenseClaims)
      .values({
        institutionId: tenant,
        staffId: d.staffId,
        title: d.title,
        claimedPaise: d.lines.reduce((n, l) => n + l.amount, 0),
        createdBy: actor.id,
      })
      .returning()
    await tx.insert(expenseClaimLines).values(
      d.lines.map((l) => ({
        institutionId: tenant,
        claimId: claim!.id,
        spentOn: l.spentOn,
        category: l.category,
        description: l.description,
        amountPaise: l.amount,
        receiptRef: l.receiptRef ?? null,
      })),
    )
    return claim!
  })
}

/**
 * Approving fixes what is agreed, line by line, and posts the expense. Nobody
 * approves their own claim.
 */
export async function decideClaim(actor: Actor, input: unknown) {
  const tenant = requireAdmin(actor)
  const d = decideClaimSchema.parse(input)
  return withTenant(tenant, async (tx) => {
    const [claim] = await tx.select().from(expenseClaims).where(eq(expenseClaims.id, d.claimId))
    if (!claim) throw new HrError(404, 'no_such_claim', 'no such claim')
    if (claim.status !== 'submitted') {
      throw new HrError(409, 'already_decided', `that claim is already ${claim.status}`)
    }
    const [person] = await tx.select().from(staff).where(eq(staff.id, claim.staffId))
    if (person!.userId === actor.id) {
      throw new HrError(403, 'self_approval', 'a claim is not approved by the person making it')
    }

    if (!d.approve) {
      const [updated] = await tx
        .update(expenseClaims)
        .set({ status: 'rejected', decidedBy: actor.id, decidedAt: new Date(), decisionNote: d.note ?? null })
        .where(eq(expenseClaims.id, claim.id))
        .returning()
      return updated!
    }

    const lines = await tx.select().from(expenseClaimLines).where(eq(expenseClaimLines.claimId, claim.id))
    for (const s of d.sanction) {
      const line = lines.find((l) => l.id === s.lineId)
      if (!line) throw new HrError(400, 'no_such_line', 'a sanctioned line is not on this claim')
      if (s.amount > line.amountPaise) {
        throw new HrError(400, 'over_claimed', 'nothing is sanctioned beyond what was claimed')
      }
    }
    for (const l of lines) {
      const agreed = d.sanction.find((s) => s.lineId === l.id)?.amount ?? l.amountPaise
      await tx
        .update(expenseClaimLines)
        .set({ sanctionedPaise: agreed })
        .where(eq(expenseClaimLines.id, l.id))
    }
    const sanctioned = lines.reduce(
      (n, l) => n + (d.sanction.find((s) => s.lineId === l.id)?.amount ?? l.amountPaise),
      0,
    )

    const [updated] = await tx
      .update(expenseClaims)
      .set({
        status: 'approved',
        sanctionedPaise: sanctioned,
        decidedBy: actor.id,
        decidedAt: new Date(),
        decisionNote: d.note ?? null,
      })
      .where(eq(expenseClaims.id, claim.id))
      .returning()

    await postClaimApproved(tx, tenant, actor.id, {
      id: claim.id,
      sanctionedPaise: sanctioned,
      title: claim.title,
      staffName: person!.name,
      department: person!.department,
    })
    return updated!
  })
}

/**
 * Settling pays what was agreed: first against an open advance the claimant
 * holds, if one is named, then in money for the rest.
 */
export async function settleClaim(actor: Actor, input: unknown) {
  const tenant = requireAdmin(actor)
  const d = settleClaimSchema.parse(input)
  return withTenant(tenant, async (tx) => {
    const [claim] = await tx.select().from(expenseClaims).where(eq(expenseClaims.id, d.claimId))
    if (!claim) throw new HrError(404, 'no_such_claim', 'no such claim')
    if (claim.status !== 'approved') {
      throw new HrError(409, 'not_approved', `that claim is ${claim.status}`)
    }
    const due = claim.sanctionedPaise ?? 0
    const [person] = await tx.select().from(staff).where(eq(staff.id, claim.staffId))

    let applied = 0
    if (d.advanceId) {
      const adv = await advanceWithBalance(tx, d.advanceId)
      if (adv.staffId !== claim.staffId) {
        throw new HrError(400, 'not_theirs', 'that advance belongs to somebody else')
      }
      if (adv.status !== 'paid') {
        throw new HrError(409, 'advance_not_open', `that advance is ${adv.status}`)
      }
      applied = Math.min(adv.outstandingPaise, due)
      if (applied > 0) {
        await tx.insert(advanceRecoveries).values({
          institutionId: tenant,
          advanceId: adv.id,
          source: 'claim',
          claimId: claim.id,
          amountPaise: applied,
          recoveredOn: d.paidOn,
        })
      }
    }
    const paid = due - applied

    const [updated] = await tx
      .update(expenseClaims)
      .set({
        status: 'paid',
        advanceAppliedPaise: applied,
        paidPaise: paid,
        paidOn: d.paidOn,
        paidFrom: paid > 0 ? d.paidFrom : null,
      })
      .where(eq(expenseClaims.id, claim.id))
      .returning()

    await postClaimSettled(tx, tenant, actor.id, {
      id: claim.id,
      advancePaise: applied,
      paidPaise: paid,
      paidOn: d.paidOn,
      paidFrom: d.paidFrom,
      staffName: person!.name,
    })
    return updated!
  })
}

export async function listClaims(actor: Actor, staffId?: string) {
  const tenant = tenantOf(actor)
  return withTenant(tenant, async (tx) => {
    let target = staffId
    if (!isHr(actor.role)) {
      const [me] = await tx.select({ id: staff.id }).from(staff).where(eq(staff.userId, actor.id))
      if (!me) return []
      target = me.id
    }
    return tx
      .select({
        id: expenseClaims.id,
        staffId: expenseClaims.staffId,
        staffName: staff.name,
        employeeCode: staff.employeeCode,
        title: expenseClaims.title,
        status: expenseClaims.status,
        claimedPaise: expenseClaims.claimedPaise,
        sanctionedPaise: expenseClaims.sanctionedPaise,
        advanceAppliedPaise: expenseClaims.advanceAppliedPaise,
        paidPaise: expenseClaims.paidPaise,
        createdAt: expenseClaims.createdAt,
      })
      .from(expenseClaims)
      .innerJoin(staff, eq(staff.id, expenseClaims.staffId))
      .where(target ? eq(expenseClaims.staffId, target) : undefined)
      .orderBy(desc(expenseClaims.createdAt))
      .limit(300)
  })
}

export async function claimLines(actor: Actor, claimId: string) {
  const tenant = tenantOf(actor)
  return withTenant(tenant, async (tx) => {
    const [claim] = await tx.select().from(expenseClaims).where(eq(expenseClaims.id, claimId))
    if (!claim) throw new HrError(404, 'no_such_claim', 'no such claim')
    await personFor(tx, actor, claim.staffId)
    return tx
      .select()
      .from(expenseClaimLines)
      .where(eq(expenseClaimLines.claimId, claimId))
      .orderBy(asc(expenseClaimLines.spentOn))
  })
}

// --- advances --------------------------------------------------------------

async function advanceWithBalance(tx: Tx, advanceId: string) {
  const [adv] = await tx.select().from(employeeAdvances).where(eq(employeeAdvances.id, advanceId))
  if (!adv) throw new HrError(404, 'no_such_advance', 'no such advance')
  const [back] = await tx
    .select({ n: sql<number>`coalesce(sum(${advanceRecoveries.amountPaise}), 0)::bigint` })
    .from(advanceRecoveries)
    .where(eq(advanceRecoveries.advanceId, adv.id))
  const recovered = Number(back?.n ?? 0)
  return { ...adv, recoveredPaise: recovered, outstandingPaise: adv.amountPaise - recovered }
}

export async function requestAdvance(actor: Actor, input: unknown) {
  const tenant = tenantOf(actor)
  const d = requestAdvanceSchema.parse(input)
  return withTenant(tenant, async (tx) => {
    await personFor(tx, actor, d.staffId)
    const [row] = await tx
      .insert(employeeAdvances)
      .values({
        institutionId: tenant,
        staffId: d.staffId,
        purpose: d.purpose,
        amountPaise: d.amount,
        createdBy: actor.id,
      })
      .returning()
    return row!
  })
}

export async function decideAdvance(actor: Actor, input: unknown) {
  const tenant = requireAdmin(actor)
  const d = decideAdvanceSchema.parse(input)
  return withTenant(tenant, async (tx) => {
    const [adv] = await tx.select().from(employeeAdvances).where(eq(employeeAdvances.id, d.advanceId))
    if (!adv) throw new HrError(404, 'no_such_advance', 'no such advance')
    if (adv.status !== 'requested') {
      throw new HrError(409, 'already_decided', `that advance is already ${adv.status}`)
    }
    const [person] = await tx.select().from(staff).where(eq(staff.id, adv.staffId))
    if (person!.userId === actor.id) {
      throw new HrError(403, 'self_approval', 'an advance is not approved by the person taking it')
    }
    if (d.monthlyRecovery && d.monthlyRecovery > adv.amountPaise) {
      throw new HrError(400, 'bad_recovery', 'a monthly recovery cannot exceed the advance')
    }
    const [updated] = await tx
      .update(employeeAdvances)
      .set({
        status: d.approve ? 'approved' : 'rejected',
        monthlyRecoveryPaise: d.approve ? (d.monthlyRecovery ?? null) : null,
        decidedBy: actor.id,
        decidedAt: new Date(),
      })
      .where(eq(employeeAdvances.id, adv.id))
      .returning()
    return updated!
  })
}

export async function payAdvance(actor: Actor, input: unknown) {
  const tenant = requireAdmin(actor)
  const d = payAdvanceSchema.parse(input)
  return withTenant(tenant, async (tx) => {
    const [adv] = await tx.select().from(employeeAdvances).where(eq(employeeAdvances.id, d.advanceId))
    if (!adv) throw new HrError(404, 'no_such_advance', 'no such advance')
    if (adv.status !== 'approved') {
      throw new HrError(409, 'not_approved', `that advance is ${adv.status}`)
    }
    const [person] = await tx.select().from(staff).where(eq(staff.id, adv.staffId))
    const [updated] = await tx
      .update(employeeAdvances)
      .set({ status: 'paid', paidOn: d.paidOn, paidFrom: d.paidFrom })
      .where(eq(employeeAdvances.id, adv.id))
      .returning()
    await postAdvancePaid(tx, tenant, actor.id, {
      id: adv.id,
      amountPaise: adv.amountPaise,
      paidOn: d.paidOn,
      paidFrom: d.paidFrom,
      staffName: person!.name,
    })
    return updated!
  })
}

export async function repayAdvance(actor: Actor, input: unknown) {
  const tenant = requireHr(actor)
  const d = repayAdvanceSchema.parse(input)
  return withTenant(tenant, async (tx) => {
    const adv = await advanceWithBalance(tx, d.advanceId)
    if (adv.status !== 'paid') throw new HrError(409, 'advance_not_open', `that advance is ${adv.status}`)
    if (d.amount > adv.outstandingPaise) {
      throw new HrError(409, 'over_recovery', `only ${adv.outstandingPaise} paise is outstanding`)
    }
    const [person] = await tx.select().from(staff).where(eq(staff.id, adv.staffId))
    const [row] = await tx
      .insert(advanceRecoveries)
      .values({
        institutionId: tenant,
        advanceId: adv.id,
        source: 'cash',
        amountPaise: d.amount,
        recoveredOn: d.on,
      })
      .returning()
    await postAdvanceRepaid(tx, tenant, actor.id, {
      id: row!.id,
      amountPaise: d.amount,
      on: d.on,
      into: d.into,
      staffName: person!.name,
    })
    return row!
  })
}

export async function listAdvances(actor: Actor, staffId?: string) {
  const tenant = tenantOf(actor)
  return withTenant(tenant, async (tx) => {
    let target = staffId
    if (!isHr(actor.role)) {
      const [me] = await tx.select({ id: staff.id }).from(staff).where(eq(staff.userId, actor.id))
      if (!me) return []
      target = me.id
    }
    const rows = await tx
      .select({
        id: employeeAdvances.id,
        staffId: employeeAdvances.staffId,
        staffName: staff.name,
        employeeCode: staff.employeeCode,
        purpose: employeeAdvances.purpose,
        amountPaise: employeeAdvances.amountPaise,
        status: employeeAdvances.status,
        monthlyRecoveryPaise: employeeAdvances.monthlyRecoveryPaise,
        paidOn: employeeAdvances.paidOn,
      })
      .from(employeeAdvances)
      .innerJoin(staff, eq(staff.id, employeeAdvances.staffId))
      .where(target ? eq(employeeAdvances.staffId, target) : undefined)
      .orderBy(desc(employeeAdvances.createdAt))
      .limit(300)
    if (rows.length === 0) return []
    const back = await tx
      .select({
        advanceId: advanceRecoveries.advanceId,
        n: sql<number>`sum(${advanceRecoveries.amountPaise})::bigint`,
      })
      .from(advanceRecoveries)
      .where(inArray(advanceRecoveries.advanceId, rows.map((r) => r.id)))
      .groupBy(advanceRecoveries.advanceId)
    return rows.map((r) => {
      const recovered = Number(back.find((b) => b.advanceId === r.id)?.n ?? 0)
      return {
        ...r,
        recoveredPaise: recovered,
        outstandingPaise: r.status === 'paid' || r.status === 'settled' ? r.amountPaise - recovered : 0,
      }
    })
  })
}

/**
 * What payroll deducts this month toward open advances: the monthly figure or
 * what is left, whichever is smaller, never more than the room left in the
 * payslip after its other deductions.
 */
export async function advanceDeductions(
  tx: Tx,
  staffId: string,
  room: number,
): Promise<(Component & { advanceId: string })[]> {
  const open = await tx
    .select()
    .from(employeeAdvances)
    .where(
      and(
        eq(employeeAdvances.staffId, staffId),
        eq(employeeAdvances.status, 'paid'),
        sql`${employeeAdvances.monthlyRecoveryPaise} is not null`,
      ),
    )
    .orderBy(asc(employeeAdvances.paidOn))
  const out: (Component & { advanceId: string })[] = []
  let left = room
  for (const a of open) {
    if (left <= 0) break
    const adv = await advanceWithBalance(tx, a.id)
    const take = Math.min(a.monthlyRecoveryPaise!, adv.outstandingPaise, left)
    if (take <= 0) continue
    out.push({
      advanceId: a.id,
      code: `advance_recovery:${a.id.slice(0, 8)}`,
      label: `Advance recovery: ${a.purpose}`,
      kind: 'deduction',
      amountPaise: take,
    })
    left -= take
  }
  return out
}

/** Record the payroll recoveries once the payslip exists to point at. */
export async function recordPayrollRecoveries(
  tx: Tx,
  tenant: string,
  payslipId: string,
  period: string,
  taken: { advanceId: string; amountPaise: number }[],
) {
  if (taken.length === 0) return
  const next = new Date(`${period}T00:00:00Z`)
  next.setUTCMonth(next.getUTCMonth() + 1)
  next.setUTCDate(0)
  await tx.insert(advanceRecoveries).values(
    taken.map((t) => ({
      institutionId: tenant,
      advanceId: t.advanceId,
      source: 'payroll' as const,
      payslipId,
      amountPaise: t.amountPaise,
      recoveredOn: next.toISOString().slice(0, 10),
    })),
  )
}
