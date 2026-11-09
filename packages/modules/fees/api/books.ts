import { sql, type SQL } from 'drizzle-orm'
import type { withTenant } from '@campusos/db'

type Tx = Parameters<Parameters<typeof withTenant>[1]>[0]

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

/** The fee document a fees journal entry came from, by its source reference, and so its student. */
const BOOKS_BY_STUDENT = sql`
  select coalesce(i.student_id, p.student_id, rp.student_id, w.student_id, aw.student_id, dc.student_id) as student_id,
         sum(l.debit_paise - l.credit_paise)::bigint as books_paise
    from finance_journal_lines l
    join finance_accounts a on a.id = l.account_id and a.purpose = 'fees_receivable'
    join finance_journal_entries e on e.id = l.entry_id
    left join fee_invoices i on e.source_module = 'fees' and split_part(e.source_ref, ':', 1) = 'invoice' and i.id::text = split_part(e.source_ref, ':', 2)
    left join fee_payments p on e.source_module = 'fees' and split_part(e.source_ref, ':', 1) = 'payment' and p.id::text = split_part(e.source_ref, ':', 2)
    left join fee_refunds r on e.source_module = 'fees' and split_part(e.source_ref, ':', 1) = 'refund' and r.id::text = split_part(e.source_ref, ':', 2)
    left join fee_payments rp on rp.id = r.payment_id
    left join fee_waivers w on e.source_module = 'fees' and split_part(e.source_ref, ':', 1) = 'waiver' and w.id::text = split_part(e.source_ref, ':', 2)
    left join fee_scholarship_awards aw on e.source_module = 'fees' and split_part(e.source_ref, ':', 1) in ('award', 'award-revoked') and aw.id::text = split_part(e.source_ref, ':', 2)
    left join fee_drop_credits dc on e.source_module = 'fees' and split_part(e.source_ref, ':', 1) = 'drop' and dc.id::text = split_part(e.source_ref, ':', 2)
   group by 1`

export interface ReceivableReport {
  booksPaise: number
  ledgerPaise: number
  differencePaise: number
  unattributedPaise: number
  mismatchCount: number
  students: { studentId: string; studentName: string | null; studentEmail: string | null; booksPaise: number; ledgerPaise: number; differencePaise: number }[]
}

/**
 * Σ student ledgers against the fees receivable account (ACC-20, decision 530).
 * A new source reference that posts to the receivable must be added to
 * BOOKS_BY_STUDENT, or its postings read as unattributed.
 */
export async function receivableReport(tx: Tx): Promise<ReceivableReport> {
  const both = sql`
    with books as (${BOOKS_BY_STUDENT}),
    ledger as (select student_id, sum(balance_paise)::bigint as ledger_paise from (${postedSql()}) x group by student_id),
    j as (select coalesce(b.student_id, g.student_id) as student_id, coalesce(b.books_paise, 0) as books_paise, coalesce(g.ledger_paise, 0) as ledger_paise
            from books b full join ledger g on g.student_id = b.student_id)`
  const [t] = (await tx.execute(sql`${both}
    select coalesce(sum(books_paise), 0)::bigint as books, coalesce(sum(ledger_paise), 0)::bigint as ledger,
           coalesce(sum(books_paise) filter (where student_id is null), 0)::bigint as unattributed,
           count(*) filter (where student_id is not null and books_paise <> ledger_paise)::int as mismatches
      from j`)).rows as Record<string, unknown>[]
  const rows = (await tx.execute(sql`${both}
    select j.student_id, u.name, u.email, j.books_paise, j.ledger_paise
      from j left join users u on u.id = j.student_id
     where j.student_id is not null and j.books_paise <> j.ledger_paise
     order by abs(j.books_paise - j.ledger_paise) desc, j.student_id
     limit 100`)).rows as Record<string, unknown>[]
  const books = Number(t!.books), ledger = Number(t!.ledger)
  return {
    booksPaise: books, ledgerPaise: ledger, differencePaise: books - ledger,
    unattributedPaise: Number(t!.unattributed), mismatchCount: Number(t!.mismatches),
    students: rows.map((r) => ({
      studentId: String(r.student_id), studentName: (r.name as string | null) ?? null, studentEmail: (r.email as string | null) ?? null,
      booksPaise: Number(r.books_paise), ledgerPaise: Number(r.ledger_paise), differencePaise: Number(r.books_paise) - Number(r.ledger_paise),
    })),
  }
}
