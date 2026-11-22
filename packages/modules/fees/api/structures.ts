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

/** The reason on a late fee the nightly recount took back; a late fee cancelled for this reason may be raised again. */
export const LATE_FEE_RECOUNT = 'no longer owed on the nightly recount'

/**
 * Raises the late fees that have fallen due, and takes back those no longer
 * owed (ACC-21, P1-03d). Each student is judged on their own instalments only.
 * An invoiced line is due on its due date, or on the day it was invoiced if
 * that was later (a late joiner, a line added afterwards); a line with no due
 * date is due the day it is invoiced, and starts no instalment of its own. For
 * a rule and an instalment day, the cutoff is that day plus the rule's days; a
 * student is late when what was due by the instalment day, and no more than
 * the invoice asked for (net of posted waivers) as at that day, is more than
 * what they paid by the cutoff, counting a pending transfer claim dated by then
 * as paid. A line is dated by the student's first issue for the term at or
 * after it was created, voided invoices included: a void corrects the bill, it
 * does not re-date the instalment. One late fee per instalment and slab, even
 * if its rule was removed and added again. A late fee not yet on an invoice is provisional: every run recounts,
 * and one no longer owed (a payment entered later with its true date, a claim
 * pending) is cancelled with LATE_FEE_RECOUNT, so it comes back if the claim is
 * rejected. One on an invoice stays (waiver or refund), and so does one the
 * office cancelled. A rule never reaches back before the day it was made, and
 * an unpaid late fee is not itself an instalment.
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
    // The price list's row estimates are tiny (lateral lines, filtered CTEs), and
    // a nested loop over the per-student CTEs is quadratic at 30,000 students:
    // hash joins only, for this statement (reset below).
    await tx.execute(sql`set local enable_nestloop = off`)
    const all = (
      await tx.execute(sql`
        with issues as (
          select i.student_id, array_agg(v) as vs
            from fee_invoices i cross join unnest(i.versions_issued_at) v
           where i.term_id = ${termId}::uuid
           group by i.student_id),
        lines as (
          select l.student_id, l.charged - l.waived as net, l.due_on,
                 ((select min(v) from unnest(iss.vs) v where v >= coalesce(f.created_at, c.created_at))
                   at time zone ${tz})::date as invoiced_on
            from (${priceListSql(termId, null)}) l
            join fee_invoices i on i.student_id = l.student_id and i.term_id = ${termId}::uuid and i.voided_at is null
            join issues iss on iss.student_id = l.student_id
            left join fee_items f on f.id = l.fee_item_id
            left join fee_student_charges c on c.id = l.student_charge_id
           where c.id is null or not (c.source_module = 'fees' and c.source_id like 'late:%')),
        due as (
          select student_id, net, due_on is not null as dated, greatest(due_on, invoiced_on) as due_on
            from lines where invoiced_on is not null),
        posted as (${postedSql({ termId })}),
        slabs as (
          select distinct d.student_id, r.id as rule_id, r.amount_paise, d.due_on, d.due_on + r.after_days::int as cutoff
            from due d join fee_late_fees r on r.term_id = ${termId}::uuid
           where d.dated
             and d.due_on + r.after_days::int < ${today}::date
             and d.due_on + r.after_days::int >= (r.created_at at time zone ${tz})::date),
        sched as (
          select s.student_id, s.rule_id, s.amount_paise, s.due_on, s.cutoff, sum(d.net)::bigint as scheduled
            from slabs s join due d on d.student_id = s.student_id and d.due_on <= s.due_on
           group by s.student_id, s.rule_id, s.amount_paise, s.due_on, s.cutoff),
        paid as (
          select s.student_id, s.rule_id, s.due_on, sum(p.amount_paise)::bigint as paid
            from slabs s join fee_payments p on p.student_id = s.student_id and p.term_id = ${termId}::uuid and p.status = 'live'
             and (p.received_at at time zone ${tz})::date <= s.cutoff
           group by s.student_id, s.rule_id, s.due_on),
        claimed as (
          select s.student_id, s.rule_id, s.due_on, sum(t.amount_paise)::bigint as claimed
            from slabs s join fee_transfer_claims t on t.student_id = s.student_id and t.term_id = ${termId}::uuid
             and t.status = 'pending' and t.transferred_on <= s.cutoff
           group by s.student_id, s.rule_id, s.due_on),
        refunded as (
          select s.student_id, s.rule_id, s.due_on, sum(r.amount_paise)::bigint as refunded
            from slabs s join fee_payments p on p.student_id = s.student_id and p.term_id = ${termId}::uuid and p.status = 'live'
            join fee_refunds r on r.payment_id = p.id and (r.refunded_at at time zone ${tz})::date <= s.cutoff
           group by s.student_id, s.rule_id, s.due_on),
        owed as (
          select distinct on (s.student_id, s.rule_id, s.due_on) s.student_id, s.rule_id, s.due_on, e.paise as owed
            from slabs s
            join (select i.student_id, e.at, e.paise
                    from fee_invoices i cross join unnest(i.owed_at, i.owed_paise) e(at, paise)
                   where i.term_id = ${termId}::uuid) e
              on e.student_id = s.student_id and (e.at at time zone ${tz})::date <= s.due_on
           order by s.student_id, s.rule_id, s.due_on, e.at desc),
        late as (
          select x.student_id, x.amount_paise, x.due_on, x.cutoff,
                 'late:' || x.rule_id || ':' || to_char(x.due_on, 'YYYY-MM-DD') || ':' || x.student_id as source_id,
                 'Late fee: instalment due ' || to_char(x.due_on, 'DD Mon YYYY') || ', unpaid after ' || to_char(x.cutoff, 'DD Mon YYYY') as label
            from sched x
            join posted b on b.student_id = x.student_id
            join owed o on o.student_id = x.student_id and o.rule_id = x.rule_id and o.due_on = x.due_on
            left join paid pd on pd.student_id = x.student_id and pd.rule_id = x.rule_id and pd.due_on = x.due_on
            left join claimed cl on cl.student_id = x.student_id and cl.rule_id = x.rule_id and cl.due_on = x.due_on
            left join refunded rf on rf.student_id = x.student_id and rf.rule_id = x.rule_id and rf.due_on = x.due_on
           where least(b.invoiced_paise - b.waived_paise, x.scheduled, o.owed) - b.credited_paise
                 - coalesce(pd.paid, 0) - coalesce(cl.claimed, 0) + coalesce(rf.refunded, 0) > 0),
        removed as (
          update fee_student_charges c set cancelled_at = now(), cancel_reason = ${LATE_FEE_RECOUNT}
           where c.term_id = ${termId}::uuid and c.source_module = 'fees' and c.source_id like 'late:%'
             and c.cancelled_at is null and c.invoiced_at is null
             and split_part(c.source_id, ':', 2) in (select id::text from fee_late_fees where term_id = ${termId}::uuid)
             and not exists (select 1 from late l where l.source_id = c.source_id)
          returning c.student_id, c.amount_paise, c.label, c.source_id),
        raised as (
          insert into fee_student_charges (institution_id, student_id, term_id, label, amount_paise, source_module, source_id, created_by)
          select ${tenant}::uuid, l.student_id, ${termId}::uuid, l.label, l.amount_paise, 'fees', l.source_id, ${actor.id}
            from late l
           where not exists (select 1 from fee_student_charges c
                              where c.source_module = 'fees' and c.source_id = l.source_id
                                and (c.cancelled_at is null or c.cancel_reason is distinct from ${LATE_FEE_RECOUNT}))
             -- One late fee per instalment and slab, whichever rule raised it (a rule removed and added again).
             and not exists (select 1 from fee_student_charges c
                              where c.student_id = l.student_id and c.term_id = ${termId}::uuid and c.source_module = 'fees'
                                and c.source_id like 'late:%' and c.cancelled_at is null and c.label = l.label)
          returning student_id, amount_paise, label, source_id)
        select true as raised, * from raised
        union all
        select false, * from removed`)
    ).rows as { raised: boolean; student_id: string; amount_paise: string | number; label: string; source_id: string }[]
    await tx.execute(sql`set local enable_nestloop = on`)
    const gone = all.filter((r) => !r.raised)
    if (gone.length > 0) {
      await audit(tx, {
        institutionId: tenant,
        actorId: actor.id,
        actorEmail: actor.email ?? null,
        moduleId: MODULE,
        action: 'fee.late_fees_removed',
        entity: 'fee_late_fees',
        entityId: termId,
        reason: LATE_FEE_RECOUNT,
        detail: { termId, count: gone.length, totalPaise: gone.reduce((n, r) => n + Number(r.amount_paise), 0), sourceIds: gone.map((r) => r.source_id) },
      })
    }
    const rows = all.filter((r) => r.raised)
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
