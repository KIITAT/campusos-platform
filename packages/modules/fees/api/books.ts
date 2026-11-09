import { sql, type SQL } from 'drizzle-orm'

/**
 * What the books were told, per student and term (ACC-20, decision 526). One
 * row per student and term that has any posted fee document. The arithmetic
 * mirrors posting.ts line for line: an invoice debits the receivable by its
 * charged amount less the waivers that rode in it, and every waiver's
 * posted_paise is exactly what the books have been told it forgives, so
 * charged - waived - credited - paid + refunded is the receivable.
 */
export function postedSql(filter: { termId?: string | null; studentId?: string | null } = {}): SQL {
  const t = (col: SQL) => (filter.termId ? sql` and ${col} = ${filter.termId}::uuid` : sql``)
  const s = (col: SQL) => (filter.studentId ? sql` and ${col} = ${filter.studentId}` : sql``)
  return sql`
    select student_id, term_id,
           sum(invoiced)::bigint as invoiced_paise,
           sum(waived)::bigint as waived_paise,
           sum(credited)::bigint as credited_paise,
           sum(paid)::bigint as paid_paise,
           sum(refunded)::bigint as refunded_paise,
           sum(unreconciled)::bigint as unreconciled_paise,
           sum(invoiced - waived - credited - paid + refunded)::bigint as balance_paise
      from (
        select i.student_id, i.term_id, i.charged_paise::bigint as invoiced, 0::bigint as waived, 0::bigint as credited,
               0::bigint as paid, 0::bigint as refunded, 0::bigint as unreconciled
          from fee_invoices i where true${t(sql`i.term_id`)}${s(sql`i.student_id`)}
        union all
        select w.student_id, f.term_id, 0, w.posted_paise, 0, 0, 0, 0
          from fee_waivers w join fee_items f on f.id = w.fee_item_id
         where w.posted_paise <> 0${t(sql`f.term_id`)}${s(sql`w.student_id`)}
        union all
        select a.student_id, a.term_id, 0, 0, a.amount_paise, 0, 0, 0
          from fee_scholarship_awards a where a.status = 'awarded'${t(sql`a.term_id`)}${s(sql`a.student_id`)}
        union all
        select d.student_id, d.term_id, 0, 0, d.amount_paise, 0, 0, 0
          from fee_drop_credits d where true${t(sql`d.term_id`)}${s(sql`d.student_id`)}
        union all
        select p.student_id, p.term_id, 0, 0, 0, p.amount_paise, 0,
               case when p.reconciled_at is null then p.amount_paise else 0 end
          from fee_payments p where true${t(sql`p.term_id`)}${s(sql`p.student_id`)}
        union all
        select p.student_id, p.term_id, 0, 0, 0, 0, r.amount_paise, 0
          from fee_refunds r join fee_payments p on p.id = r.payment_id
         where true${t(sql`p.term_id`)}${s(sql`p.student_id`)}
      ) d
     group by student_id, term_id`
}

export interface Posted {
  invoicedPaise: number
  waivedPaise: number
  creditedPaise: number
  paidPaise: number
  refundedPaise: number
  unreconciledPaise: number
  balancePaise: number
}

export const NOTHING_POSTED: Posted = {
  invoicedPaise: 0, waivedPaise: 0, creditedPaise: 0, paidPaise: 0, refundedPaise: 0, unreconciledPaise: 0, balancePaise: 0,
}

/** A postedSql row, as numbers. */
export const postedOf = (r: Record<string, unknown> | undefined): Posted =>
  r
    ? {
        invoicedPaise: Number(r.invoiced_paise), waivedPaise: Number(r.waived_paise), creditedPaise: Number(r.credited_paise),
        paidPaise: Number(r.paid_paise), refundedPaise: Number(r.refunded_paise), unreconciledPaise: Number(r.unreconciled_paise),
        balancePaise: Number(r.balance_paise),
      }
    : NOTHING_POSTED
