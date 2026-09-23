import { and, asc, desc, eq, gte, isNull, lte, sql } from 'drizzle-orm'
import { audit, withTenant } from '@campusos/db'
import { postWithin } from '@campusos/module-finance/api'
import {
  gratuityPayouts,
  gratuityRules,
  payComponents,
  payrollRuns,
  payslips,
  salaryAssignments,
  salaryStructureLines,
  salaryStructures,
  salaryWithholdings,
  staff,
  taxElections,
  taxRegimes,
  taxSlabs,
} from '../schema'
import {
  HrError,
  MODULE,
  isHr,
  requireAdmin,
  requireHr,
  shiftDays,
  tenantOf,
  type Actor,
  type Tx,
} from './guards'
import {
  annualTax,
  gratuityAmount,
  inForce,
  monthlyTax,
  monthsLeftInTaxYear,
  serviceYears,
  structureAmounts,
  taxYearOf,
  type Component,
  type StructureLine,
} from './payroll'
import {
  assignStructureSchema,
  createGratuityRuleSchema,
  createStructureSchema,
  createTaxRegimeSchema,
  electRegimeSchema,
  liftWithholdingSchema,
  payGratuitySchema,
  releasePayslipSchema,
  withholdSalarySchema,
} from './schemas'

/**
 * What feeds a payslip, beyond per-person pay components: salary structures,
 * income tax as the institution has entered it, gratuity, and salary held
 * back. The posting to the books is the same as it always was; this is only
 * about getting the figures right before they get there.
 */

const errCode = (e: unknown) =>
  (e as { cause?: { code?: string } }).cause?.code ?? (e as { code?: string }).code

// --- structures ------------------------------------------------------------

export async function createStructure(actor: Actor, input: unknown) {
  const tenant = requireAdmin(actor)
  const d = createStructureSchema.parse(input)
  try {
    structureAmounts(d.lines as StructureLine[], 1)
  } catch (e) {
    throw new HrError(400, 'bad_structure', (e as Error).message)
  }
  if (d.lines.filter((l) => l.calc === 'base').length !== 1) {
    throw new HrError(400, 'bad_structure', 'a structure has exactly one base line')
  }
  return withTenant(tenant, async (tx) => {
    const [row] = await tx
      .insert(salaryStructures)
      .values({ institutionId: tenant, code: d.code, name: d.name })
      .onConflictDoNothing()
      .returning()
    if (!row) throw new HrError(409, 'exists', 'that structure code already exists')
    await tx.insert(salaryStructureLines).values(
      d.lines.map((l, i) => ({
        institutionId: tenant,
        structureId: row.id,
        seq: i + 1,
        code: l.code,
        label: l.label,
        kind: l.kind,
        calc: l.calc,
        amountPaise: l.amountPaise ?? null,
        percentBp: l.percentBp ?? null,
        of: l.of ?? null,
        taxable: l.taxable,
      })),
    )
    return { ...row, lines: d.lines.length }
  })
}

export async function listStructures(actor: Actor) {
  const tenant = requireHr(actor)
  return withTenant(tenant, async (tx) => {
    const rows = await tx.select().from(salaryStructures).orderBy(asc(salaryStructures.code))
    const lines = await tx.select().from(salaryStructureLines).orderBy(asc(salaryStructureLines.seq))
    const people = await tx
      .select({ structureId: salaryAssignments.structureId, n: sql<number>`count(*)::int` })
      .from(salaryAssignments)
      .where(isNull(salaryAssignments.effectiveTo))
      .groupBy(salaryAssignments.structureId)
    return rows.map((s) => ({
      ...s,
      lines: lines.filter((l) => l.structureId === s.id),
      people: people.find((p) => p.structureId === s.id)?.n ?? 0,
    }))
  })
}

/** Put somebody on a structure at a base, from a date, closing what they were on. */
export async function assignStructure(actor: Actor, input: unknown) {
  const tenant = requireAdmin(actor)
  const d = assignStructureSchema.parse(input)
  return withTenant(tenant, async (tx) => {
    const [person] = await tx.select().from(staff).where(eq(staff.id, d.staffId))
    if (!person) throw new HrError(404, 'no_such_staff', 'no such staff record')
    const [structure] = await tx.select().from(salaryStructures).where(eq(salaryStructures.id, d.structureId))
    if (!structure) throw new HrError(404, 'no_such_structure', 'no such salary structure')
    const closeOn = shiftDays(d.effectiveFrom, -1)
    await tx
      .update(salaryAssignments)
      .set({ effectiveTo: closeOn })
      .where(
        and(
          eq(salaryAssignments.staffId, d.staffId),
          isNull(salaryAssignments.effectiveTo),
          lte(salaryAssignments.effectiveFrom, closeOn),
        ),
      )
    try {
      const [row] = await tx
        .insert(salaryAssignments)
        .values({
          institutionId: tenant,
          staffId: d.staffId,
          structureId: d.structureId,
          basePaise: d.base,
          effectiveFrom: d.effectiveFrom,
        })
        .returning()
      return row!
    } catch (e) {
      if (errCode(e) === '23P01') {
        throw new HrError(409, 'overlaps', 'that would put them on two structures at once')
      }
      throw e
    }
  })
}

/**
 * What somebody is paid in a month, before leave and extras: their structure's
 * lines at their base, with any per-person pay component of the same code
 * taking its place and any other one added. A per-person component is the
 * exception the institution made for them, so it wins.
 */
export async function payableComponents(
  tx: Tx,
  staffId: string,
  period: string,
): Promise<{ components: Component[]; taxablePaise: number }> {
  const assignments = await tx
    .select()
    .from(salaryAssignments)
    .where(eq(salaryAssignments.staffId, staffId))
  const current = assignments.find((a) => inForce(a, period))

  let fromStructure: (Component & { taxable: boolean })[] = []
  if (current) {
    const lines = await tx
      .select()
      .from(salaryStructureLines)
      .where(eq(salaryStructureLines.structureId, current.structureId))
      .orderBy(asc(salaryStructureLines.seq))
    fromStructure = structureAmounts(lines as StructureLine[], current.basePaise)
  }

  const personal = (await tx.select().from(payComponents).where(eq(payComponents.staffId, staffId)))
    .filter((c) => inForce(c, period))
    .map((c) => ({ code: c.code, label: c.label, kind: c.kind, amountPaise: c.amountPaise, taxable: true }))

  const byCode = new Map<string, Component & { taxable: boolean }>()
  for (const c of fromStructure) byCode.set(c.code, c)
  for (const c of personal) byCode.set(c.code, c)
  const all = [...byCode.values()]

  return {
    components: all.map((c) => ({ code: c.code, label: c.label, kind: c.kind, amountPaise: c.amountPaise })),
    taxablePaise: all.filter((c) => c.kind === 'earning' && c.taxable).reduce((n, c) => n + c.amountPaise, 0),
  }
}

// --- income tax ------------------------------------------------------------

export async function createTaxRegime(actor: Actor, input: unknown) {
  const tenant = requireAdmin(actor)
  const d = createTaxRegimeSchema.parse(input)
  return withTenant(tenant, async (tx) => {
    const [row] = await tx
      .insert(taxRegimes)
      .values({
        institutionId: tenant,
        code: d.code,
        name: d.name,
        yearStartsMonth: d.yearStartsMonth,
        standardDeductionPaise: d.standardDeduction,
        cessBp: d.cessBp,
        rebateUpToPaise: d.rebateUpTo ?? null,
      })
      .onConflictDoNothing()
      .returning()
    if (!row) throw new HrError(409, 'exists', 'that regime code already exists')
    try {
      await tx.insert(taxSlabs).values(
        d.slabs.map((s) => ({
          institutionId: tenant,
          regimeId: row.id,
          fromPaise: s.from,
          toPaise: s.to ?? null,
          rateBp: s.rateBp,
        })),
      )
    } catch (e) {
      if (errCode(e) === '23P01' || errCode(e) === '23505') {
        throw new HrError(400, 'bad_slabs', 'two slabs cover the same income')
      }
      throw e
    }
    return { ...row, slabs: d.slabs.length }
  })
}

export async function listTaxRegimes(actor: Actor) {
  const tenant = tenantOf(actor)
  return withTenant(tenant, async (tx) => {
    const rows = await tx.select().from(taxRegimes).orderBy(asc(taxRegimes.code))
    const slabs = await tx.select().from(taxSlabs).orderBy(asc(taxSlabs.fromPaise))
    return rows.map((r) => ({ ...r, slabs: slabs.filter((s) => s.regimeId === r.id) }))
  })
}

/** Choosing a regime for a tax year: HR for anybody, or the person for themselves. */
export async function electRegime(actor: Actor, input: unknown) {
  const tenant = tenantOf(actor)
  const d = electRegimeSchema.parse(input)
  return withTenant(tenant, async (tx) => {
    const [person] = await tx.select().from(staff).where(eq(staff.id, d.staffId))
    if (!person) throw new HrError(404, 'no_such_staff', 'no such staff record')
    if (!isHr(actor.role) && person.userId !== actor.id) {
      throw new HrError(403, 'forbidden', 'not permitted')
    }
    const [row] = await tx
      .insert(taxElections)
      .values({ institutionId: tenant, staffId: d.staffId, regimeId: d.regimeId, taxYear: d.taxYear })
      .onConflictDoUpdate({
        target: [taxElections.staffId, taxElections.taxYear],
        set: { regimeId: d.regimeId },
      })
      .returning()
    return row!
  })
}

/**
 * This month's income-tax deduction, or nothing if they have chosen no regime
 * for the year. Projects the year at this month's taxable pay, subtracts what
 * earlier payslips in the year already deducted, and spreads the rest over the
 * months left.
 */
export async function taxDeduction(
  tx: Tx,
  staffId: string,
  period: string,
  taxableMonthlyPaise: number,
): Promise<Component | null> {
  const elections = await tx
    .select({ regime: taxRegimes, taxYear: taxElections.taxYear })
    .from(taxElections)
    .innerJoin(taxRegimes, eq(taxRegimes.id, taxElections.regimeId))
    .where(eq(taxElections.staffId, staffId))
  const election = elections.find(
    (e) => e.taxYear === taxYearOf(period, e.regime.yearStartsMonth),
  )
  if (!election) return null
  const r = election.regime
  const slabs = await tx.select().from(taxSlabs).where(eq(taxSlabs.regimeId, r.id))

  const annual = annualTax(taxableMonthlyPaise * 12, {
    standardDeductionPaise: r.standardDeductionPaise,
    cessBp: r.cessBp,
    rebateUpToPaise: r.rebateUpToPaise,
    slabs: slabs.map((s) => ({ fromPaise: s.fromPaise, toPaise: s.toPaise, rateBp: s.rateBp })),
  })

  const start = `${election.taxYear}-${String(r.yearStartsMonth).padStart(2, '0')}-01`
  const earlier = await tx
    .select({ lines: payslips.lines })
    .from(payslips)
    .where(and(eq(payslips.staffId, staffId), gte(payslips.period, start), sql`${payslips.period} < ${period}`))
  const already = earlier
    .flatMap((p) => p.lines as { code: string; appliedPaise: number }[])
    .filter((l) => l.code === 'income_tax')
    .reduce((n, l) => n + l.appliedPaise, 0)

  const amount = monthlyTax(annual, already, monthsLeftInTaxYear(period, r.yearStartsMonth))
  return amount > 0
    ? { code: 'income_tax', label: `Income tax (${r.code})`, kind: 'deduction', amountPaise: amount }
    : null
}

// --- gratuity --------------------------------------------------------------

export async function createGratuityRule(actor: Actor, input: unknown) {
  const tenant = requireAdmin(actor)
  const d = createGratuityRuleSchema.parse(input)
  return withTenant(tenant, async (tx) => {
    const [row] = await tx
      .insert(gratuityRules)
      .values({
        institutionId: tenant,
        code: d.code,
        name: d.name,
        minServiceYears: d.minServiceYears,
        daysPerYear: d.daysPerYear,
        divisorDays: d.divisorDays,
        wageCodes: d.wageCodes,
        roundUpMonths: d.roundUpMonths ?? null,
        maxPaise: d.max ?? null,
      })
      .onConflictDoNothing()
      .returning()
    if (!row) throw new HrError(409, 'exists', 'that rule code already exists')
    return row
  })
}

export async function listGratuityRules(actor: Actor) {
  const tenant = requireHr(actor)
  return withTenant(tenant, (tx) => tx.select().from(gratuityRules).orderBy(asc(gratuityRules.code)))
}

async function quote(tx: Tx, staffId: string, ruleId: string) {
  const [person] = await tx.select().from(staff).where(eq(staff.id, staffId))
  if (!person) throw new HrError(404, 'no_such_staff', 'no such staff record')
  const [rule] = await tx.select().from(gratuityRules).where(eq(gratuityRules.id, ruleId))
  if (!rule) throw new HrError(404, 'no_such_rule', 'no such gratuity rule')
  const to = person.leftOn ?? new Date().toISOString().slice(0, 10)
  const lastMonth = `${to.slice(0, 7)}-01`
  const { components } = await payableComponents(tx, person.id, lastMonth)
  const wage = components
    .filter((c) => c.kind === 'earning' && rule.wageCodes.includes(c.code))
    .reduce((n, c) => n + c.amountPaise, 0)
  const years = serviceYears(person.joinedOn, to, rule.roundUpMonths)
  return {
    person,
    rule,
    serviceYears: years,
    monthlyWagePaise: wage,
    amountPaise: gratuityAmount(wage, years, rule),
    eligible: years >= rule.minServiceYears,
  }
}

/** What a gratuity would come to, today or on the leaving date, with the working. */
export async function gratuityQuote(actor: Actor, staffId: string, ruleId: string) {
  const tenant = requireHr(actor)
  return withTenant(tenant, async (tx) => {
    const q = await quote(tx, staffId, ruleId)
    return {
      staffId,
      rule: q.rule.code,
      serviceYears: q.serviceYears,
      monthlyWagePaise: q.monthlyWagePaise,
      amountPaise: q.amountPaise,
      eligible: q.eligible,
    }
  })
}

/**
 * Pay a gratuity on leaving: once per employment, computed rather than typed,
 * posted as a cost of employing people.
 *
 *   debit  employer contributions
 *   credit bank or cash
 */
export async function payGratuity(actor: Actor, input: unknown) {
  const tenant = requireAdmin(actor)
  const d = payGratuitySchema.parse(input)
  return withTenant(tenant, async (tx) => {
    const q = await quote(tx, d.staffId, d.ruleId)
    if (!q.person.leftOn) throw new HrError(409, 'still_employed', 'gratuity is paid when an employment ends')
    if (!q.eligible) {
      throw new HrError(
        409,
        'not_eligible',
        `${q.serviceYears} years of service; the rule asks for ${q.rule.minServiceYears}`,
      )
    }
    if (q.amountPaise === 0) throw new HrError(409, 'no_wage', 'none of the rule’s wage components were in force')
    const [row] = await tx
      .insert(gratuityPayouts)
      .values({
        institutionId: tenant,
        staffId: d.staffId,
        ruleId: d.ruleId,
        serviceYears: q.serviceYears,
        monthlyWagePaise: q.monthlyWagePaise,
        amountPaise: q.amountPaise,
        paidOn: d.paidOn,
        paidFrom: d.paidFrom,
        paidBy: actor.id,
      })
      .onConflictDoNothing()
      .returning()
    if (!row) throw new HrError(409, 'already_paid', 'gratuity for that employment has already been paid')
    await postWithin(tx, tenant, actor.id, {
      occurredAt: new Date(`${d.paidOn}T00:00:00Z`),
      memo: `Gratuity, ${q.person.name} (${q.person.employeeCode})`,
      sourceModule: 'hr',
      sourceRef: `gratuity:${row.id}`,
      lines: [
        { purpose: 'employer_cost', debitPaise: q.amountPaise, costCenter: q.person.department },
        { purpose: d.paidFrom === 'cash' ? 'cash' : 'bank', creditPaise: q.amountPaise },
      ],
    })
    return row
  })
}

// --- withholding -----------------------------------------------------------

export async function withholdSalary(actor: Actor, input: unknown) {
  const tenant = requireAdmin(actor)
  const d = withholdSalarySchema.parse(input)
  return withTenant(tenant, async (tx) => {
    const [person] = await tx.select().from(staff).where(eq(staff.id, d.staffId))
    if (!person) throw new HrError(404, 'no_such_staff', 'no such staff record')
    await audit(tx, {
      institutionId: tenant,
      actorId: actor.id,
      actorEmail: actor.email ?? null,
      moduleId: MODULE,
      action: 'hr.salary_withheld',
      entity: 'hr_staff',
      entityId: person.id,
      reason: d.reason,
      detail: { from: d.fromPeriod },
    })
    const [row] = await tx
      .insert(salaryWithholdings)
      .values({
        institutionId: tenant,
        staffId: d.staffId,
        fromPeriod: d.fromPeriod,
        reason: d.reason,
        createdBy: actor.id,
      })
      .onConflictDoNothing()
      .returning()
    if (!row) throw new HrError(409, 'already_withheld', 'their salary is already being held back')
    return row
  })
}

/** Stop holding back future salary. Months already held are released one by one. */
export async function liftWithholding(actor: Actor, input: unknown) {
  const tenant = requireAdmin(actor)
  const { staffId } = liftWithholdingSchema.parse(input)
  return withTenant(tenant, async (tx) => {
    const [row] = await tx
      .update(salaryWithholdings)
      .set({ liftedAt: new Date(), liftedBy: actor.id })
      .where(and(eq(salaryWithholdings.staffId, staffId), isNull(salaryWithholdings.liftedAt)))
      .returning()
    if (!row) throw new HrError(409, 'not_withheld', 'their salary is not being held back')
    return row
  })
}

/** Whether a month's payslip for this person is held back. */
export async function isWithheld(tx: Tx, staffId: string, period: string) {
  const [row] = await tx
    .select({ id: salaryWithholdings.id })
    .from(salaryWithholdings)
    .where(
      and(
        eq(salaryWithholdings.staffId, staffId),
        isNull(salaryWithholdings.liftedAt),
        lte(salaryWithholdings.fromPeriod, period),
      ),
    )
  return !!row
}

/**
 * Pay one held-back payslip: audited, because it is money going to somebody
 * the institution had decided not to pay, and posted as the liability the
 * payslip accrued being discharged.
 */
export async function releasePayslip(actor: Actor, input: unknown) {
  const tenant = requireAdmin(actor)
  const d = releasePayslipSchema.parse(input)
  return withTenant(tenant, async (tx) => {
    const [slip] = await tx.select().from(payslips).where(eq(payslips.id, d.payslipId))
    if (!slip) throw new HrError(404, 'no_such_payslip', 'no such payslip')
    if (!slip.withheld) throw new HrError(409, 'not_withheld', 'that payslip was not held back')
    if (slip.releasedAt) throw new HrError(409, 'already_released', 'that payslip has already been released')
    const [person] = await tx.select().from(staff).where(eq(staff.id, slip.staffId))
    await audit(tx, {
      institutionId: tenant,
      actorId: actor.id,
      actorEmail: actor.email ?? null,
      moduleId: MODULE,
      action: 'hr.payslip_released',
      entity: 'hr_payslips',
      entityId: slip.id,
      reason: d.reason,
      detail: { period: slip.period, netPaise: slip.netPaise },
    })
    const [updated] = await tx
      .update(payslips)
      .set({ releasedAt: new Date() })
      .where(eq(payslips.id, slip.id))
      .returning()
    if (slip.netPaise > 0) {
      await postWithin(tx, tenant, actor.id, {
        occurredAt: new Date(`${d.paidOn}T00:00:00Z`),
        memo: `${slip.period.slice(0, 7)} salary released, ${person!.name}`,
        sourceModule: 'hr',
        sourceRef: `salary-release:${slip.id}`,
        lines: [
          { purpose: 'salaries_payable', debitPaise: slip.netPaise },
          { purpose: d.paidFrom === 'cash' ? 'cash' : 'bank', creditPaise: slip.netPaise },
        ],
      })
    }
    return updated!
  })
}

export async function listWithheld(actor: Actor) {
  const tenant = requireHr(actor)
  return withTenant(tenant, (tx) =>
    tx
      .select({
        id: payslips.id,
        staffId: payslips.staffId,
        staffName: staff.name,
        employeeCode: staff.employeeCode,
        period: payslips.period,
        netPaise: payslips.netPaise,
        releasedAt: payslips.releasedAt,
      })
      .from(payslips)
      .innerJoin(staff, eq(staff.id, payslips.staffId))
      .where(eq(payslips.withheld, true))
      .orderBy(desc(payslips.period)),
  )
}

// --- runs ------------------------------------------------------------------

export async function listRuns(actor: Actor) {
  const tenant = requireHr(actor)
  return withTenant(tenant, (tx) =>
    tx.select().from(payrollRuns).orderBy(desc(payrollRuns.createdAt)).limit(120),
  )
}
