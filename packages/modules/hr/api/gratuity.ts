import { asc, desc, eq, inArray, lte } from 'drizzle-orm'
import { audit, withTenant } from '@campusos/db'
import { postWithin, purposeBalance } from '@campusos/module-finance/api'
import { gratuityPayouts, gratuityRules, gratuityValuationLines, gratuityValuations, staff } from '../schema'
import { HrError, MODULE, requireAdmin, requireHr, type Actor, type Tx } from './guards'
import { gratuityWage, lockGratuity } from './pay'
import { gratuityAmount, serviceYears } from './payroll'
import { valueGratuitySchema } from './schemas'

interface Line { staffId: string; leftOn: string | null; serviceYears: number; monthlyWagePaise: number; amountPaise: number }

/**
 * Everybody the accrued method counts as at `asOf` (D3): the employed, vested
 * or not, as if they left that day; leavers of the last year who qualified and
 * have not been paid, as at their leaving day. Nobody already paid.
 */
// ponytail: a wage query per person; fine for an institution's staff list, fold into one query if it ever runs for thousands.
export async function accruedLines(tx: Tx, rule: typeof gratuityRules.$inferSelect, asOf: string): Promise<Line[]> {
  const yearBefore = `${Number(asOf.slice(0, 4)) - 1}${asOf.slice(4)}`
  const paid = new Set((await tx.select({ id: gratuityPayouts.staffId }).from(gratuityPayouts)).map((r) => r.id))
  const people = await tx.select().from(staff).where(lte(staff.joinedOn, asOf)).orderBy(asc(staff.employeeCode))
  const out: Line[] = []
  for (const p of people) {
    if (paid.has(p.id)) continue
    const left = p.leftOn !== null && p.leftOn <= asOf ? p.leftOn : null
    if (left !== null && left <= yearBefore) continue
    const to = left ?? asOf
    const years = serviceYears(p.joinedOn, to, rule.roundUpMonths)
    if (left !== null && years < rule.minServiceYears) continue
    const wage = await gratuityWage(tx, p.id, rule.wageCodes, to)
    out.push({
      staffId: p.id,
      leftOn: left,
      serviceYears: years,
      monthlyWagePaise: wage,
      amountPaise: gratuityAmount(wage, years, { ...rule, minServiceYears: 0 }),
    })
  }
  return out
}

/** Value the gratuity provision as at a month end and post the difference (P1-06d, ACC-29). */
export async function valueGratuity(actor: Actor, input: unknown) {
  const tenant = requireAdmin(actor)
  const d = valueGratuitySchema.parse(input)
  return withTenant(tenant, async (tx) => {
    await lockGratuity(tx, tenant)
    const [latest] = await tx.select({ asOf: gratuityValuations.asOf }).from(gratuityValuations).orderBy(desc(gratuityValuations.asOf)).limit(1)
    if (latest && d.asOf < latest.asOf) {
      throw new HrError(409, 'valuation_order', `the provision was last valued as at ${latest.asOf}; value it as at that date or later`)
    }
    let lines: Line[] = []
    let obligation: number
    let ruleId: string | null = null
    if (d.method === 'accrued') {
      if (!d.ruleId) throw new HrError(400, 'rule_required', 'the accrued method needs a gratuity rule')
      const [rule] = await tx.select().from(gratuityRules).where(eq(gratuityRules.id, d.ruleId))
      if (!rule) throw new HrError(404, 'no_such_rule', 'no such gratuity rule')
      ruleId = rule.id
      lines = await accruedLines(tx, rule, d.asOf)
      obligation = lines.reduce((n, l) => n + l.amountPaise, 0)
    } else {
      if (d.obligation === null || d.reference === null) {
        throw new HrError(400, 'actuarial_figure', 'enter the actuary’s obligation and the report reference')
      }
      obligation = d.obligation
    }
    const before = await purposeBalance(tx, 'gratuity_provision', d.asOf)
    const adjustment = obligation - before
    const [row] = await tx
      .insert(gratuityValuations)
      .values({
        institutionId: tenant,
        asOf: d.asOf,
        method: d.method,
        ruleId,
        obligationPaise: obligation,
        provisionBeforePaise: before,
        adjustmentPaise: adjustment,
        reference: d.method === 'actuarial' ? d.reference : null,
        valuedBy: actor.id,
      })
      .returning()
    if (lines.length > 0) {
      await tx.insert(gratuityValuationLines).values(lines.map((l) => ({ ...l, institutionId: tenant, valuationId: row!.id })))
    }
    if (adjustment !== 0) {
      const up = adjustment > 0
      await postWithin(tx, tenant, actor.id, {
        postingDate: d.asOf,
        memo: `Gratuity provision as at ${d.asOf}`,
        sourceModule: 'hr',
        sourceRef: `gratuity-valuation:${row!.id}`,
        lines: [
          { purpose: up ? 'employer_cost' : 'gratuity_provision', debitPaise: Math.abs(adjustment) },
          { purpose: up ? 'gratuity_provision' : 'employer_cost', creditPaise: Math.abs(adjustment) },
        ],
      })
    }
    await audit(tx, {
      institutionId: tenant,
      actorId: actor.id,
      actorEmail: actor.email ?? null,
      moduleId: MODULE,
      action: 'hr.gratuity_valued',
      entity: 'hr_gratuity_valuations',
      entityId: row!.id,
      reason: `gratuity provision as at ${d.asOf}`,
      detail: { method: d.method, obligationPaise: obligation, adjustmentPaise: adjustment, people: lines.length },
    })
    return { ...row!, lines }
  })
}

/** Every valuation, newest first, with the working per person. */
export async function listGratuityValuations(actor: Actor) {
  const tenant = requireHr(actor)
  return withTenant(tenant, async (tx) => {
    const rows = await tx.select().from(gratuityValuations).orderBy(desc(gratuityValuations.asOf), desc(gratuityValuations.createdAt))
    if (rows.length === 0) return []
    const lines = await tx
      .select({ line: gratuityValuationLines, employeeCode: staff.employeeCode, name: staff.name })
      .from(gratuityValuationLines)
      .innerJoin(staff, eq(staff.id, gratuityValuationLines.staffId))
      .where(inArray(gratuityValuationLines.valuationId, rows.map((r) => r.id)))
      .orderBy(asc(staff.employeeCode))
    return rows.map((r) => ({
      ...r,
      lines: lines.filter((l) => l.line.valuationId === r.id).map((l) => ({ ...l.line, employeeCode: l.employeeCode, name: l.name })),
    }))
  })
}
