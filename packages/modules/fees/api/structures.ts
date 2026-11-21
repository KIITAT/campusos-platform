import { asc, eq, sql } from 'drizzle-orm'
import { audit, withTenant } from '@campusos/db'
import { localToday, settingsWithin } from '@campusos/module-finance/api'
import { notify } from '@campusos/module-notices/api'
import { terms } from '@campusos/module-academic/schema'
import { formatPaise } from '@campusos/money'
import { lateFees } from '../schema'
import { postedSql } from './books'
import { priceListSql } from './enrolment'
import { FeeError, requireAdmin, requireFinance, tenantOf, type Actor } from './operations'
import { createLateFeeSchema, removeLateFeeSchema } from './schemas'

type Tx = Parameters<Parameters<typeof withTenant>[1]>[0]

const MODULE = 'fees'

export async function listLateFees(actor: Actor, termId?: string) {
  const tenant = requireFinance(actor)
  return withTenant(tenant, (tx) =>
    tx
      .select({
        id: lateFees.id,
        termId: lateFees.termId,
        termCode: terms.code,
        afterDays: lateFees.afterDays,
        amountPaise: lateFees.amountPaise,
      })
      .from(lateFees)
      .innerJoin(terms, eq(terms.id, lateFees.termId))
      .where(termId ? eq(lateFees.termId, termId) : undefined)
      .orderBy(asc(terms.code), asc(lateFees.afterDays)),
  )
}

export async function createLateFee(actor: Actor, input: unknown) {
  const tenant = requireAdmin(actor)
  const data = createLateFeeSchema.parse(input)
  return withTenant(tenant, async (tx) => {
    const [term] = await tx.select({ id: terms.id }).from(terms).where(eq(terms.id, data.termId))
    if (!term) throw new FeeError(404, 'no_such_term', 'no such term')
    const [row] = await tx
      .insert(lateFees)
      .values({ institutionId: tenant, termId: data.termId, afterDays: data.afterDays, amountPaise: data.amount, createdBy: actor.id })
      .onConflictDoNothing()
      .returning()
    if (!row) throw new FeeError(409, 'exists', `a late fee ${data.afterDays} days after the due date already exists for that term`)
    await audit(tx, {
      institutionId: tenant,
      actorId: actor.id,
      actorEmail: actor.email ?? null,
      moduleId: MODULE,
      action: 'fee.late_fee_created',
      entity: 'fee_late_fees',
      entityId: row.id,
      reason: 'late fee rule added',
      detail: { termId: data.termId, afterDays: data.afterDays, amountPaise: data.amount },
    })
    return row
  })
}

export async function removeLateFee(actor: Actor, input: unknown) {
  const tenant = requireAdmin(actor)
  const data = removeLateFeeSchema.parse(input)
  return withTenant(tenant, async (tx) => {
    const [row] = await tx.select().from(lateFees).where(eq(lateFees.id, data.lateFeeId))
    if (!row) throw new FeeError(404, 'no_such_late_fee', 'no such late fee')
    await audit(tx, {
      institutionId: tenant,
      actorId: actor.id,
      actorEmail: actor.email ?? null,
      moduleId: MODULE,
      action: 'fee.late_fee_removed',
      entity: 'fee_late_fees',
      entityId: row.id,
      reason: data.reason,
      detail: { termId: row.termId, afterDays: row.afterDays, amountPaise: row.amountPaise },
    })
    await tx.delete(lateFees).where(eq(lateFees.id, row.id))
    return {
      id: row.id,
      notice: 'Late fee removed. Late fees already raised stay; cancel any not yet invoiced from Student charges.',
    }
  })
}

/**
 * Raises the late fees that have fallen due, once each (ACC-21, P1-03d). For a
 * rule and an instalment date, the cutoff is the date plus the rule's days; a
 * student is late when, counting only payments and refunds dated on or before
 * the cutoff, they still owed some of what was scheduled through that date.
 * A rule never reaches back before the day it was made, an unpaid late fee is
 * not itself an instalment, and a late fee cancelled by the office is never
 * raised again (its source id stays taken).
 *
 * ponytail: flat per instalment and slab; per-day accrual would need a charge
 * that changes nightly (owner question 2).
 */
export async function chargeLateFees(actor: Actor, tx: Tx) {
  const tenant = tenantOf(actor)
  const today = await localToday(tx, tenant)
  const { timeZone: tz } = await settingsWithin(tx, tenant)
  const termIds = (await tx.selectDistinct({ termId: lateFees.termId }).from(lateFees)).map((r) => r.termId)
  let charged = 0
  let totalPaise = 0
  for (const termId of termIds) {
    const [term] = await tx.select({ code: terms.code }).from(terms).where(eq(terms.id, termId))
    const rows = (
      await tx.execute(sql`
        with lines as (
          select l.* from (${priceListSql(termId, null)}) l
           where l.student_charge_id is null
              or not exists (select 1 from fee_student_charges c
                              where c.id = l.student_charge_id and c.source_module = 'fees' and c.source_id like 'late:%')),
        posted as (${postedSql({ termId })}),
        dates as (select distinct due_on from lines where due_on is not null),
        slabs as (
          select r.id as rule_id, r.amount_paise, d.due_on, d.due_on + r.after_days::int as cutoff
            from fee_late_fees r cross join dates d
           where r.term_id = ${termId}::uuid
             and d.due_on + r.after_days::int < ${today}::date
             and d.due_on + r.after_days::int >= (r.created_at at time zone ${tz})::date),
        sched as (
          select s.rule_id, s.amount_paise, s.due_on, s.cutoff, l.student_id, sum(l.charged - l.waived)::bigint as scheduled
            from slabs s join lines l on l.due_on is null or l.due_on <= s.due_on
           group by s.rule_id, s.amount_paise, s.due_on, s.cutoff, l.student_id),
        paid as (
          select s.rule_id, s.due_on, p.student_id, sum(p.amount_paise)::bigint as paid
            from slabs s join fee_payments p on p.term_id = ${termId}::uuid and p.status = 'live'
             and (p.received_at at time zone ${tz})::date <= s.cutoff
           group by s.rule_id, s.due_on, p.student_id),
        refunded as (
          select s.rule_id, s.due_on, p.student_id, sum(r.amount_paise)::bigint as refunded
            from slabs s join fee_refunds r on (r.refunded_at at time zone ${tz})::date <= s.cutoff
            join fee_payments p on p.id = r.payment_id and p.term_id = ${termId}::uuid and p.status = 'live'
           group by s.rule_id, s.due_on, p.student_id),
        late as (
          select x.student_id, x.rule_id, x.amount_paise, x.due_on, x.cutoff
            from sched x
            join posted b on b.student_id = x.student_id
            left join paid pd on pd.rule_id = x.rule_id and pd.due_on = x.due_on and pd.student_id = x.student_id
            left join refunded rf on rf.rule_id = x.rule_id and rf.due_on = x.due_on and rf.student_id = x.student_id
           where least(b.invoiced_paise - b.waived_paise, x.scheduled) - b.credited_paise
                 - coalesce(pd.paid, 0) + coalesce(rf.refunded, 0) > 0)
        insert into fee_student_charges (institution_id, student_id, term_id, label, amount_paise, source_module, source_id, created_by)
        select ${tenant}::uuid, l.student_id, ${termId}::uuid,
               'Late fee: instalment due ' || to_char(l.due_on, 'DD Mon YYYY') || ', unpaid after ' || to_char(l.cutoff, 'DD Mon YYYY'),
               l.amount_paise, 'fees', 'late:' || l.rule_id || ':' || to_char(l.due_on, 'YYYY-MM-DD') || ':' || l.student_id, ${actor.id}
          from late l
         where not exists (select 1 from fee_student_charges c
                            where c.source_module = 'fees'
                              and c.source_id = 'late:' || l.rule_id || ':' || to_char(l.due_on, 'YYYY-MM-DD') || ':' || l.student_id)
        returning student_id, amount_paise, label`)
    ).rows as { student_id: string; amount_paise: string | number; label: string }[]
    if (rows.length === 0) continue
    const sum = rows.reduce((n, r) => n + Number(r.amount_paise), 0)
    charged += rows.length
    totalPaise += sum
    await audit(tx, {
      institutionId: tenant,
      actorId: actor.id,
      actorEmail: actor.email ?? null,
      moduleId: MODULE,
      action: 'fee.late_fees_charged',
      entity: 'fee_late_fees',
      entityId: termId,
      reason: 'late fees raised by the nightly run',
      detail: { termId, count: rows.length, totalPaise: sum },
    })
    const groups = new Map<string, { label: string; amount: number; ids: string[] }>()
    for (const r of rows) {
      const k = `${r.label}|${r.amount_paise}`
      const g = groups.get(k) ?? { label: r.label, amount: Number(r.amount_paise), ids: [] }
      g.ids.push(r.student_id)
      groups.set(k, g)
    }
    for (const g of groups.values()) {
      for (let i = 0; i < g.ids.length; i += 1000) {
        await notify(tx, tenant, {
          userIds: g.ids.slice(i, i + 1000),
          moduleId: MODULE,
          title: 'Late fee added',
          body: `${g.label}: ${formatPaise(g.amount)} has been added to your ${term!.code} fees. It is billed with the term's next invoice.`,
          link: '/m/fees/me',
          alsoGuardians: { link: '/m/parents' },
        })
      }
    }
  }
  return { charged, totalPaise }
}
