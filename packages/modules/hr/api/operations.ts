import { and, asc, desc, eq, inArray, isNull, lte, or, sql } from 'drizzle-orm'
import { audit, withTenant } from '@campusos/db'
import type { Role } from '@campusos/module-framework'
import {
  leaveRequests,
  leaveTypes,
  payComponents,
  payslips,
  salaryPayments,
  staff,
} from '../schema'
import {
  daysInMonth,
  daysInPeriod,
  inForce,
  leaveRemaining,
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
  type LeaveBalance,
  type LeaveRow,
  type MyEmployment,
  type PayrollRun,
  type PayslipRow,
  type StaffRow,
} from './schemas'
import { postPayslip, postSalaryPayment } from './posting'

const MODULE = 'hr'

export interface Actor {
  id: string
  email?: string | null
  role: Role
  institutionId: string | null
}

export class HrError extends Error {
  constructor(
    readonly status: 400 | 403 | 404 | 409,
    readonly code: string,
    message: string,
  ) {
    super(message)
  }
}

type Tx = Parameters<Parameters<typeof withTenant>[1]>[0]

const tenantOf = (actor: Actor): string => {
  if (!actor.institutionId) {
    throw new HrError(400, 'no_institution', 'no institution for this session')
  }
  return actor.institutionId
}

/** The HR desk: administration and the finance office that pays people. */
const isHr = (r: Role) =>
  r === 'accounts_staff' || r === 'institution_admin' || r === 'super_admin'

/** Hiring, ending employment and setting pay are administrative decisions. */
const isAdmin = (r: Role) => r === 'institution_admin' || r === 'super_admin'

const requireHr = (actor: Actor) => {
  const tenant = tenantOf(actor)
  if (!isHr(actor.role)) throw new HrError(403, 'forbidden', 'not permitted')
  return tenant
}

const requireAdmin = (actor: Actor) => {
  const tenant = tenantOf(actor)
  if (!isAdmin(actor.role)) throw new HrError(403, 'forbidden', 'not permitted')
  return tenant
}

const today = () => new Date().toISOString().slice(0, 10)

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

    const components = await tx
      .select()
      .from(payComponents)
      .where(inArray(payComponents.staffId, rows.map((r) => r.id)))

    return rows.map((r) => {
      const mine = components.filter(
        (c) => c.staffId === r.id && c.kind === 'earning' && inForce(c, period),
      )
      return {
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
        monthlyGrossPaise: mine.reduce((n, c) => n + c.amountPaise, 0),
      }
    })
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

const spanDays = (from: string, to: string) =>
  Math.round(
    (new Date(`${to}T00:00:00Z`).getTime() - new Date(`${from}T00:00:00Z`).getTime()) /
      86_400_000,
  ) + 1

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

async function balancesFor(tx: Tx, staffId: string, year: string): Promise<LeaveBalance[]> {
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
        sql`extract(year from ${leaveRequests.fromOn}) = ${Number(year)}`,
      ),
    )

  return types.map((t) => {
    const days = taken
      .filter((l) => l.leaveTypeId === t.id)
      .reduce((n, l) => n + spanDays(l.fromOn, l.toOn), 0)
    return {
      typeCode: t.code,
      typeName: t.name,
      annualDays: t.annualDays,
      takenDays: days,
      remainingDays: leaveRemaining(t.annualDays, days),
    }
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
      const components = await tx
        .select()
        .from(payComponents)
        .where(eq(payComponents.staffId, person.id))

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

      const inForceComponents: Component[] = components
        .filter((c) => inForce(c, period))
        .map((c) => ({
          code: c.code,
          label: c.label,
          kind: c.kind,
          amountPaise: c.amountPaise,
        }))

      const slip = payslipFor(inForceComponents, { workingDays, unpaidLeaveDays })

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
          generatedBy: actor.id,
        })
        .returning()

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
      .where(eq(payslips.period, d.period))
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

    const components = await tx
      .select()
      .from(payComponents)
      .where(eq(payComponents.staffId, person.id))
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
        monthlyGrossPaise: components
          .filter((c) => c.kind === 'earning' && inForce(c, period))
          .reduce((n, c) => n + c.amountPaise, 0),
      },
      balances: await balancesFor(tx, person.id, String(new Date().getFullYear())),
      leave: mine.map(toLeaveRow),
      payslips: slips.map(toPayslipRow),
    }
  })
}
