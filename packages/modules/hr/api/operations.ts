import { and, asc, desc, eq, inArray, isNull, lte, or, sql } from 'drizzle-orm'
import { audit, withTenant } from '@campusos/db'
import {
  HrError,
  MODULE,
  isHr,
  requireAdmin,
  requireHr,
  spanDays,
  tenantOf,
  today,
  type Actor,
} from './guards'
import {
  leaveRequests,
  leaveTypes,
  payComponents,
  payrollRuns,
  payslips,
  salaryPayments,
  staff,
} from '../schema'
import {
  daysInMonth,
  daysInPeriod,
  payslipFor,
  type Component,
} from './payroll'
import {
  cancelLeaveSchema,
  createLeaveTypeSchema,
  createStaffSchema,
  decideLeaveSchema,
  endEmploymentSchema,
  generatePayrollSchema,
  paySalariesSchema,
  requestLeaveSchema,
  setComponentSchema,
  type LeaveRow,
  type MyEmployment,
  type PayrollRun,
  type PayslipRow,
  type StaffRow,
} from './schemas'
import { postPayslip, postSalaryPayment } from './posting'
import { balancesFor } from './balances'
import { assertBalance, encashmentsDue } from './leave'
import { shiftAllowances } from './shifts'
import { advanceDeductions, recordPayrollRecoveries } from './expenses'
import { isWithheld, payableComponents, taxDeduction } from './pay'
import { leaveEncashments } from '../schema'

// --- staff -----------------------------------------------------------------

export async function createStaff(actor: Actor, input: unknown) {
  const tenant = requireAdmin(actor)
  const d = createStaffSchema.parse(input)

  return withTenant(tenant, async (tx) => {
    const [row] = await tx
      .insert(staff)
      .values({
        institutionId: tenant,
        userId: d.userId ?? null,
        employeeCode: d.employeeCode,
        name: d.name,
        designation: d.designation,
        department: d.department ?? null,
        employment: d.employment,
        joinedOn: d.joinedOn,
        email: d.email ?? null,
        phone: d.phone ?? null,
      })
      .onConflictDoNothing()
      .returning()
    if (!row) {
      throw new HrError(409, 'exists', 'that employee code or login is already on record')
    }
    return row
  })
}

/**
 * Ending employment is audited: it stops a salary, and "when exactly did they
 * leave" is a question with money attached.
 */
export async function endEmployment(actor: Actor, input: unknown) {
  const tenant = requireAdmin(actor)
  const d = endEmploymentSchema.parse(input)

  return withTenant(tenant, async (tx) => {
    const [row] = await tx.select().from(staff).where(eq(staff.id, d.staffId))
    if (!row) throw new HrError(404, 'no_such_staff', 'no such staff record')
    if (row.leftOn) throw new HrError(409, 'already_ended', 'that employment already ended')
    if (d.leftOn < row.joinedOn) {
      throw new HrError(400, 'bad_dates', 'they cannot leave before they joined')
    }

    await audit(tx, {
      institutionId: tenant,
      actorId: actor.id,
      actorEmail: actor.email ?? null,
      moduleId: MODULE,
      action: 'hr.employment_ended',
      entity: 'hr_staff',
      entityId: row.id,
      reason: d.reason,
      detail: { employeeCode: row.employeeCode, name: row.name, leftOn: d.leftOn },
    })

    const [updated] = await tx
      .update(staff)
      .set({ leftOn: d.leftOn })
      .where(eq(staff.id, d.staffId))
      .returning()
    return updated!
  })
}

export async function listStaff(actor: Actor, includeLeft = false): Promise<StaffRow[]> {
  const tenant = requireHr(actor)
  const period = `${today().slice(0, 7)}-01`

  return withTenant(tenant, async (tx): Promise<StaffRow[]> => {
    const rows = await tx
      .select()
      .from(staff)
      .where(includeLeft ? undefined : isNull(staff.leftOn))
      .orderBy(asc(staff.employeeCode))

    if (rows.length === 0) return []

    // ponytail: one payable lookup per person, fine for a college's staff list.
    const out: StaffRow[] = []
    for (const r of rows) {
      const { components } = await payableComponents(tx, r.id, period)
      out.push({
        id: r.id,
        employeeCode: r.employeeCode,
        name: r.name,
        designation: r.designation,
        department: r.department,
        employment: r.employment,
        joinedOn: r.joinedOn,
        leftOn: r.leftOn,
        email: r.email,
        phone: r.phone,
        monthlyGrossPaise: components
          .filter((c) => c.kind === 'earning')
          .reduce((n, c) => n + c.amountPaise, 0),
      })
    }
    return out
  })
}

// --- leave -----------------------------------------------------------------

export async function createLeaveType(actor: Actor, input: unknown) {
  const tenant = requireAdmin(actor)
  const d = createLeaveTypeSchema.parse(input)

  return withTenant(tenant, async (tx) => {
    const [row] = await tx
      .insert(leaveTypes)
      .values({
        institutionId: tenant,
        code: d.code,
        name: d.name,
        annualDays: d.annualDays,
        paid: d.paid,
        allowNegative: d.allowNegative,
        encashable: d.encashable,
        encashmentComponents: d.encashmentComponents,
        maxCarryForward: d.maxCarryForward,
        compensatory: d.compensatory,
        compOffValidityDays: d.compOffValidityDays ?? null,
      })
      .onConflictDoNothing()
      .returning()
    if (!row) throw new HrError(409, 'exists', 'that leave code already exists')
    return row
  })
}

export async function listLeaveTypes(actor: Actor) {
  const tenant = requireHr(actor)
  return withTenant(tenant, (tx) =>
    tx.select().from(leaveTypes).orderBy(asc(leaveTypes.code)),
  )
}

/**
 * A request, not a grant. The spec asks for an approval workflow, and a
 * request that approves itself is a calendar entry.
 */
export async function requestLeave(actor: Actor, input: unknown) {
  const tenant = tenantOf(actor)
  const d = requestLeaveSchema.parse(input)
  if (d.toOn < d.fromOn) {
    throw new HrError(400, 'bad_dates', 'leave cannot end before it starts')
  }

  return withTenant(tenant, async (tx) => {
    const [person] = await tx.select().from(staff).where(eq(staff.id, d.staffId))
    if (!person) throw new HrError(404, 'no_such_staff', 'no such staff record')

    // Anyone may file for themselves; only HR may file on somebody's behalf.
    if (!isHr(actor.role) && person.userId !== actor.id) {
      throw new HrError(403, 'forbidden', 'not permitted')
    }

    const [row] = await tx
      .insert(leaveRequests)
      .values({
        institutionId: tenant,
        staffId: d.staffId,
        leaveTypeId: d.leaveTypeId,
        fromOn: d.fromOn,
        toOn: d.toOn,
        reason: d.reason,
      })
      .returning()
    return row!
  })
}

export async function decideLeave(actor: Actor, input: unknown) {
  const tenant = requireHr(actor)
  const d = decideLeaveSchema.parse(input)

  return withTenant(tenant, async (tx) => {
    const [row] = await tx
      .select()
      .from(leaveRequests)
      .where(eq(leaveRequests.id, d.requestId))
    if (!row) throw new HrError(404, 'no_such_request', 'no such request')
    if (row.status !== 'pending') {
      throw new HrError(409, 'already_decided', `that request is already ${row.status}`)
    }

    // Nobody approves their own leave, whatever their role.
    const [person] = await tx.select().from(staff).where(eq(staff.id, row.staffId))
    if (person?.userId && person.userId === actor.id) {
      throw new HrError(403, 'self_approval', 'leave is not approved by the person taking it')
    }

    // Leave nobody has is not granted by approving it. Checked at the decision,
    // not the request: a balance can change between the two, and the approval
    // is the act that spends it.
    if (d.approve) {
      await assertBalance(
        tx,
        row.staffId,
        row.leaveTypeId,
        row.fromOn.slice(0, 4),
        spanDays(row.fromOn, row.toOn),
      )
    }

    const [updated] = await tx
      .update(leaveRequests)
      .set({
        status: d.approve ? 'approved' : 'rejected',
        decidedBy: actor.id,
        decidedAt: new Date(),
        decisionNote: d.note ?? null,
      })
      .where(eq(leaveRequests.id, d.requestId))
      .returning()
    return updated!
  })
}

/** Withdrawing approved leave. Audited, because payroll may already have run. */
export async function cancelLeave(actor: Actor, input: unknown) {
  const tenant = requireHr(actor)
  const d = cancelLeaveSchema.parse(input)

  return withTenant(tenant, async (tx) => {
    const [row] = await tx
      .select()
      .from(leaveRequests)
      .where(eq(leaveRequests.id, d.requestId))
    if (!row) throw new HrError(404, 'no_such_request', 'no such request')
    if (row.status === 'cancelled') {
      throw new HrError(409, 'already_cancelled', 'that request is already cancelled')
    }

    await audit(tx, {
      institutionId: tenant,
      actorId: actor.id,
      actorEmail: actor.email ?? null,
      moduleId: MODULE,
      action: 'hr.leave_cancelled',
      entity: 'hr_leave_requests',
      entityId: row.id,
      reason: d.reason,
      detail: { staffId: row.staffId, from: row.fromOn, to: row.toOn, was: row.status },
    })

    const [updated] = await tx
      .update(leaveRequests)
      .set({
        status: 'cancelled',
        decidedBy: actor.id,
        decidedAt: row.decidedAt ?? new Date(),
        decisionNote: d.reason,
      })
      .where(eq(leaveRequests.id, d.requestId))
      .returning()
    return updated!
  })
}

const leaveColumns = {
  id: leaveRequests.id,
  staffId: leaveRequests.staffId,
  staffName: staff.name,
  typeCode: leaveTypes.code,
  typeName: leaveTypes.name,
  paid: leaveTypes.paid,
  fromOn: leaveRequests.fromOn,
  toOn: leaveRequests.toOn,
  reason: leaveRequests.reason,
  status: leaveRequests.status,
  decisionNote: leaveRequests.decisionNote,
}

const toLeaveRow = (r: Omit<LeaveRow, 'days'>): LeaveRow => ({
  ...r,
  days: spanDays(r.fromOn, r.toOn),
})

export async function listLeave(actor: Actor, pendingOnly = false): Promise<LeaveRow[]> {
  const tenant = requireHr(actor)
  return withTenant(tenant, async (tx) => {
    const rows = await tx
      .select(leaveColumns)
      .from(leaveRequests)
      .innerJoin(staff, eq(staff.id, leaveRequests.staffId))
      .innerJoin(leaveTypes, eq(leaveTypes.id, leaveRequests.leaveTypeId))
      .where(pendingOnly ? eq(leaveRequests.status, 'pending') : undefined)
      .orderBy(desc(leaveRequests.fromOn))
      .limit(300)
    return rows.map(toLeaveRow)
  })
}

export async function leaveBalances(actor: Actor, staffId: string, year?: string) {
  const tenant = requireHr(actor)
  return withTenant(tenant, (tx) =>
    balancesFor(tx, staffId, year ?? String(new Date().getFullYear())),
  )
}

// --- pay -------------------------------------------------------------------

/**
 * Set a pay line from a date. Supersedes rather than overwrites: the previous
 * row is closed the day before, so last month's payslip still explains itself.
 */
export async function setComponent(actor: Actor, input: unknown) {
  const tenant = requireAdmin(actor)
  const d = setComponentSchema.parse(input)

  return withTenant(tenant, async (tx) => {
    const [person] = await tx.select().from(staff).where(eq(staff.id, d.staffId))
    if (!person) throw new HrError(404, 'no_such_staff', 'no such staff record')

    const dayBefore = new Date(`${d.effectiveFrom}T00:00:00Z`)
    dayBefore.setUTCDate(dayBefore.getUTCDate() - 1)
    const closeOn = dayBefore.toISOString().slice(0, 10)

    await tx
      .update(payComponents)
      .set({ effectiveTo: closeOn })
      .where(
        and(
          eq(payComponents.staffId, d.staffId),
          eq(payComponents.code, d.code),
          isNull(payComponents.effectiveTo),
          lte(payComponents.effectiveFrom, closeOn),
        ),
      )

    const [row] = await tx
      .insert(payComponents)
      .values({
        institutionId: tenant,
        staffId: d.staffId,
        code: d.code,
        label: d.label,
        kind: d.kind,
        amountPaise: d.amount,
        effectiveFrom: d.effectiveFrom,
      })
      .returning()
    return row!
  })
}

export async function componentsFor(actor: Actor, staffId: string) {
  const tenant = requireHr(actor)
  return withTenant(tenant, (tx) =>
    tx
      .select()
      .from(payComponents)
      .where(eq(payComponents.staffId, staffId))
      .orderBy(asc(payComponents.code), desc(payComponents.effectiveFrom)),
  )
}

/**
 * Generate payslips for a month.
 *
 * Idempotent by omission rather than by overwrite: anybody already paid for the
 * period is skipped and counted, because a payslip is a document of record and
 * regenerating it silently is exactly what the guard in 0013 exists to prevent.
 */
export async function generatePayroll(actor: Actor, input: unknown): Promise<PayrollRun> {
  const tenant = requireHr(actor)
  const d = generatePayrollSchema.parse(input)
  const period = d.period
  const monthEnd = new Date(
    Date.UTC(Number(period.slice(0, 4)), Number(period.slice(5, 7)), 0),
  )
    .toISOString()
    .slice(0, 10)

  return withTenant(tenant, async (tx): Promise<PayrollRun> => {
    const people = await tx
      .select()
      .from(staff)
      .where(
        and(
          d.staffId ? eq(staff.id, d.staffId) : undefined,
          lte(staff.joinedOn, monthEnd),
          // Somebody who left before this month started is not on this payroll.
          or(isNull(staff.leftOn), sql`${staff.leftOn} >= ${period}`),
        ),
      )
      .orderBy(asc(staff.employeeCode))

    const [paid] = await tx
      .select({ id: salaryPayments.id })
      .from(salaryPayments)
      .where(eq(salaryPayments.period, period))
    if (paid) {
      throw new HrError(
        409,
        'period_paid',
        `salaries for ${period.slice(0, 7)} have already been paid`,
      )
    }

    const existing = await tx
      .select({ staffId: payslips.staffId })
      .from(payslips)
      .where(eq(payslips.period, period))
    const already = new Set(existing.map((e) => e.staffId))

    const [run] = await tx
      .insert(payrollRuns)
      .values({
        institutionId: tenant,
        period,
        generated: 0,
        skipped: 0,
        grossPaise: 0,
        netPaise: 0,
        runBy: actor.id,
      })
      .returning({ id: payrollRuns.id })

    const workingDays = daysInMonth(new Date(`${period}T00:00:00Z`))
    const made: PayslipRow[] = []
    let skipped = 0

    for (const person of people) {
      if (already.has(person.id)) {
        skipped++
        continue
      }

      // ponytail: a query pair per person. Fine for a college's staff list; if
      // this ever runs for thousands, fold into two grouped queries.
      // What they are paid: their structure at their base, with per-person
      // components taking precedence, and tax on the taxable part if they have
      // chosen a regime for the year.
      const payable = await payableComponents(tx, person.id, period)
      const tax = await taxDeduction(tx, person.id, period, payable.taxablePaise)

      const unpaid = await tx
        .select({ fromOn: leaveRequests.fromOn, toOn: leaveRequests.toOn })
        .from(leaveRequests)
        .innerJoin(leaveTypes, eq(leaveTypes.id, leaveRequests.leaveTypeId))
        .where(
          and(
            eq(leaveRequests.staffId, person.id),
            eq(leaveRequests.status, 'approved'),
            eq(leaveTypes.paid, false),
          ),
        )

      const unpaidLeaveDays = unpaid.reduce((n, l) => n + daysInPeriod(l, period), 0)

      const inForceComponents: Component[] = tax ? [...payable.components, tax] : payable.components

      const encashments = await encashmentsDue(tx, person.id, period)
      const extras: Component[] = encashments.map((e) => ({
        code: `leave_encashment:${e.id.slice(0, 8)}`,
        label: `Leave encashment, ${e.days} days`,
        kind: 'earning',
        amountPaise: e.amountPaise,
      }))
      // Shift allowances ride alongside, for the days actually worked on a shift.
      extras.push(...(await shiftAllowances(tx, person, period)))

      // Advances come back out of what is left after everything else: the room
      // is worked out first so a recovery never pushes the payslip below zero.
      const before = payslipFor(inForceComponents, { workingDays, unpaidLeaveDays, extras })
      const recoveries = await advanceDeductions(
        tx,
        person.id,
        before.grossPaise - before.deductionsPaise,
      )
      const slip = recoveries.length
        ? payslipFor([...inForceComponents, ...recoveries], { workingDays, unpaidLeaveDays, extras })
        : before

      const [row] = await tx
        .insert(payslips)
        .values({
          institutionId: tenant,
          staffId: person.id,
          period,
          grossPaise: slip.grossPaise,
          deductionsPaise: slip.deductionsPaise,
          netPaise: slip.netPaise,
          unpaidLeaveDays: slip.unpaidLeaveDays,
          lossOfPayPaise: slip.lossOfPayPaise,
          lines: slip.lines,
          runId: run!.id,
          withheld: await isWithheld(tx, person.id, period),
          generatedBy: actor.id,
        })
        .returning()

      await recordPayrollRecoveries(tx, tenant, row!.id, period, recoveries)

      if (encashments.length > 0) {
        await tx
          .update(leaveEncashments)
          .set({ payslipId: row!.id })
          .where(inArray(leaveEncashments.id, encashments.map((e) => e.id)))
      }

      // Same transaction: a payslip the books never heard about is a salary
      // that does not appear in the month it was earned.
      await postPayslip(tx, tenant, actor.id, {
        id: row!.id,
        period,
        staffName: person.name,
        employeeCode: person.employeeCode,
        department: person.department,
        grossPaise: slip.grossPaise,
        deductionsPaise: slip.deductionsPaise,
        netPaise: slip.netPaise,
        advanceRecoveryPaise: recoveries.reduce((n, r) => n + r.amountPaise, 0),
      })

      made.push({
        id: row!.id,
        staffId: person.id,
        staffName: person.name,
        employeeCode: person.employeeCode,
        designation: person.designation,
        period,
        grossPaise: slip.grossPaise,
        deductionsPaise: slip.deductionsPaise,
        netPaise: slip.netPaise,
        unpaidLeaveDays: slip.unpaidLeaveDays,
        lossOfPayPaise: slip.lossOfPayPaise,
        lines: slip.lines,
        generatedAt: row!.generatedAt.toISOString(),
      })
    }

    await tx
      .update(payrollRuns)
      .set({
        generated: made.length,
        skipped,
        grossPaise: made.reduce((n, p) => n + p.grossPaise, 0),
        netPaise: made.reduce((n, p) => n + p.netPaise, 0),
      })
      .where(eq(payrollRuns.id, run!.id))

    return {
      period,
      generated: made.length,
      skipped,
      totalNetPaise: made.reduce((n, p) => n + p.netPaise, 0),
      payslips: made,
    }
  })
}

/**
 * Pay a month's salaries: the liability the payslips accrued, discharged.
 *
 * The amount comes from the payslips rather than from the caller, so the entry
 * that clears salaries payable is exactly the entry that created it. Once a
 * month is paid it is closed -- a payslip generated afterwards would accrue a
 * salary that this payment was never going to cover.
 */
export async function paySalaries(actor: Actor, input: unknown) {
  const tenant = requireAdmin(actor)
  const d = paySalariesSchema.parse(input)

  return withTenant(tenant, async (tx) => {
    const [owed] = await tx
      .select({ total: sql<number>`coalesce(sum(${payslips.netPaise}), 0)::bigint` })
      .from(payslips)
      // Held-back payslips are released one at a time, not in the run.
      .where(and(eq(payslips.period, d.period), eq(payslips.withheld, false)))
    const amountPaise = Number(owed?.total ?? 0)

    if (amountPaise === 0) {
      throw new HrError(
        404,
        'no_payroll',
        `no payroll has been generated for ${d.period.slice(0, 7)}`,
      )
    }

    const [already] = await tx
      .select({ id: salaryPayments.id })
      .from(salaryPayments)
      .where(eq(salaryPayments.period, d.period))
    if (already) {
      throw new HrError(
        409,
        'already_paid',
        `salaries for ${d.period.slice(0, 7)} have already been paid`,
      )
    }

    const [row] = await tx
      .insert(salaryPayments)
      .values({
        institutionId: tenant,
        period: d.period,
        paidOn: d.paidOn,
        amountPaise,
        paidFrom: d.paidFrom,
        reference: d.reference ?? null,
        paidBy: actor.id,
      })
      .returning()

    await audit(tx, {
      institutionId: tenant,
      actorId: actor.id,
      actorEmail: actor.email ?? null,
      moduleId: MODULE,
      action: 'payroll.paid',
      entity: 'hr_salary_payments',
      entityId: row!.id,
      reason: `${d.period.slice(0, 7)} salaries paid from ${d.paidFrom}`,
      detail: { period: d.period, paidOn: d.paidOn, amountPaise, reference: d.reference ?? null },
    })

    await postSalaryPayment(tx, tenant, actor.id, {
      id: row!.id,
      period: row!.period,
      paidOn: row!.paidOn,
      amountPaise: row!.amountPaise,
      paidFrom: row!.paidFrom,
    })

    return row!
  })
}

export async function listSalaryPayments(actor: Actor) {
  const tenant = requireHr(actor)
  return withTenant(tenant, (tx) =>
    tx.select().from(salaryPayments).orderBy(desc(salaryPayments.period)),
  )
}

const payslipColumns = {
  id: payslips.id,
  staffId: payslips.staffId,
  staffName: staff.name,
  employeeCode: staff.employeeCode,
  designation: staff.designation,
  period: payslips.period,
  grossPaise: payslips.grossPaise,
  deductionsPaise: payslips.deductionsPaise,
  netPaise: payslips.netPaise,
  unpaidLeaveDays: payslips.unpaidLeaveDays,
  lossOfPayPaise: payslips.lossOfPayPaise,
  lines: payslips.lines,
  generatedAt: payslips.generatedAt,
}

const toPayslipRow = (r: {
  [K in keyof typeof payslipColumns]: unknown
}): PayslipRow => ({
  id: r.id as string,
  staffId: r.staffId as string,
  staffName: r.staffName as string,
  employeeCode: r.employeeCode as string,
  designation: r.designation as string,
  period: r.period as string,
  grossPaise: r.grossPaise as number,
  deductionsPaise: r.deductionsPaise as number,
  netPaise: r.netPaise as number,
  unpaidLeaveDays: r.unpaidLeaveDays as number,
  lossOfPayPaise: r.lossOfPayPaise as number,
  lines: r.lines as PayslipRow['lines'],
  generatedAt: (r.generatedAt as Date).toISOString(),
})

export async function listPayslips(actor: Actor, period?: string): Promise<PayslipRow[]> {
  const tenant = requireHr(actor)
  return withTenant(tenant, async (tx) => {
    const rows = await tx
      .select(payslipColumns)
      .from(payslips)
      .innerJoin(staff, eq(staff.id, payslips.staffId))
      .where(period ? eq(payslips.period, `${period.slice(0, 7)}-01`) : undefined)
      .orderBy(desc(payslips.period), asc(staff.employeeCode))
      .limit(500)
    return rows.map(toPayslipRow)
  })
}

// --- the staff member's own view -------------------------------------------

export async function myEmployment(actor: Actor): Promise<MyEmployment> {
  const tenant = tenantOf(actor)

  return withTenant(tenant, async (tx): Promise<MyEmployment> => {
    const [person] = await tx.select().from(staff).where(eq(staff.userId, actor.id))
    if (!person) {
      return { onRecord: false, staff: null, balances: [], leave: [], payslips: [] }
    }

    const period = `${today().slice(0, 7)}-01`

    const mine = await tx
      .select(leaveColumns)
      .from(leaveRequests)
      .innerJoin(staff, eq(staff.id, leaveRequests.staffId))
      .innerJoin(leaveTypes, eq(leaveTypes.id, leaveRequests.leaveTypeId))
      .where(eq(leaveRequests.staffId, person.id))
      .orderBy(desc(leaveRequests.fromOn))
      .limit(50)

    const slips = await tx
      .select(payslipColumns)
      .from(payslips)
      .innerJoin(staff, eq(staff.id, payslips.staffId))
      .where(eq(payslips.staffId, person.id))
      .orderBy(desc(payslips.period))
      .limit(24)

    return {
      onRecord: true,
      staff: {
        id: person.id,
        employeeCode: person.employeeCode,
        name: person.name,
        designation: person.designation,
        department: person.department,
        employment: person.employment,
        joinedOn: person.joinedOn,
        leftOn: person.leftOn,
        email: person.email,
        phone: person.phone,
        monthlyGrossPaise: (await payableComponents(tx, person.id, period)).components
          .filter((c) => c.kind === 'earning')
          .reduce((n, c) => n + c.amountPaise, 0),
      },
      balances: await balancesFor(tx, person.id, String(new Date().getFullYear())),
      leave: mine.map(toLeaveRow),
      payslips: slips.map(toPayslipRow),
    }
  })
}
