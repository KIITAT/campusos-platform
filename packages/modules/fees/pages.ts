import { formatPaise } from '@campusos/money'
import { param, type PluginPage } from '@campusos/module-framework'
import { listStructure } from '@campusos/module-academic/api'
import {
  duesReport,
  listAwards,
  listDropCredits,
  listFeeItems,
  listInvoices,
  listRefundRules,
  listScholarships,
  studentLedger,
  type Actor,
} from './api'

/**
 * The finance desk, declared rather than drawn.
 *
 * These were four bespoke pages in the host application. They are here now,
 * because a module that can be installed after the host was built cannot leave
 * its screens behind in it. What the host renders from this is the same three
 * things every module needs -- a table, a form, a figure -- so the whole product
 * still looks like one product.
 */

const OFFICE = ['institution_admin', 'super_admin', 'accounts_staff'] as const
const ADMIN = ['institution_admin', 'super_admin'] as const

/** The term being looked at: asked for, else the current one, else the last. */
async function termFor(actor: Actor, req: Request) {
  const structure = await listStructure(actor)
  const wanted = param(req, 'termId')
  return {
    structure,
    term:
      structure.terms.find((t) => t.id === wanted) ??
      structure.terms.find((t) => t.isCurrent) ??
      structure.terms.at(-1) ??
      null,
  }
}

export const pages: PluginPage[] = [
  {
    path: '/',
    title: 'Fees',
    menu: 'Charges',
    roles: [...OFFICE],
    async load(actor) {
      const a = actor as Actor
      const [items, structure] = await Promise.all([listFeeItems(a), listStructure(a)])
      return {
        items: items.map((i) => ({
          ...i,
          dueOn: i.dueOn ? i.dueOn.toISOString() : null,
        })),
        programs: structure.programs.map((p) => ({
          value: p.id,
          label: `${p.code} - ${p.name}`,
        })),
        terms: structure.terms.map((t) => ({
          value: t.id,
          label: `${t.code} - ${t.name}${t.isCurrent ? ' (current)' : ''}`,
        })),
      }
    },
    sections: () => [
      {
        kind: 'note',
        text:
          'A charge belongs to a programme and a term, so every student enrolled ' +
          'in that programme is charged it. Waivers and payments are per student, ' +
          'from the dues list.',
      },
      {
        kind: 'table',
        title: 'Charges',
        rows: 'items',
        empty: 'Nothing charged yet.',
        columns: [
          { key: 'programCode', label: 'Programme', kind: 'code' },
          { key: 'termCode', label: 'Term', kind: 'code' },
          { key: 'label', label: 'Item' },
          { key: 'amountPaise', label: 'Amount', kind: 'money' },
          { key: 'dueOn', label: 'Due', kind: 'date' },
        ],
      },
      {
        kind: 'form',
        title: 'Add a charge',
        submit: 'Add charge',
        path: '/items',
        roles: [...ADMIN],
        fields: [
          { name: 'programId', label: 'Programme', kind: 'select', options: 'programs' },
          { name: 'termId', label: 'Term', kind: 'select', options: 'terms' },
          { name: 'label', label: 'Item', hint: 'e.g. Tuition, Hostel, Exam fee' },
          {
            name: 'amount',
            label: 'Amount',
            kind: 'money',
            hint: 'Rupees. 45000 or 1,234.56 both work; it is stored in paise.',
          },
          { name: 'dueOn', label: 'Due on', kind: 'date', optional: true },
        ],
      },
    ],
  },

  {
    path: '/dues',
    title: 'Dues',
    menu: 'Dues',
    roles: [...OFFICE, 'hod'],
    async load(actor, req) {
      const a = actor as Actor
      const { structure, term } = await termFor(a, req)
      if (!term) return { rows: [], terms: [], termCode: null, total: 0, defaulters: 0 }

      const [report, invoices] = await Promise.all([
        duesReport(a, term.id),
        listInvoices(a, term.id),
      ])
      return {
        termCode: report.termCode,
        termId: term.id,
        issuedCount: invoices.length,
        total: report.totalOutstandingPaise,
        defaulters: report.defaulterCount,
        rows: report.rows.map((r) => ({
          ...r,
          who: r.studentName ?? r.studentEmail,
          overdue: r.outstandingPaise > 0,
        })),
        terms: structure.terms.map((t) => ({
          label: t.code,
          href: `/m/fees/dues?termId=${t.id}`,
          active: t.id === term.id,
        })),
      }
    },
    sections: (data) => [
      { kind: 'links', title: 'Term', links: data.terms as never },
      {
        kind: 'figures',
        figures: [
          { label: 'Issued', value: String(data.issuedCount ?? 0) },
          { label: 'Owing', value: String(data.defaulters) },
          {
            label: 'Outstanding',
            value: formatPaise(Number(data.total)),
            tone: Number(data.total) > 0 ? 'due' : 'clear',
          },
        ],
      },
      {
        kind: 'note',
        text:
          'Amounts still clearing count as paid here and are flagged pending, so ' +
          'a student whose cheque is in transit is not chased. Open a student to ' +
          'record a payment, waive a charge, or confirm one against the bank.',
      },
      {
        kind: 'table',
        rows: 'rows',
        empty: 'No charges have been raised for this term.',
        columns: [
          {
            key: 'who',
            label: 'Student',
            href: '/m/fees/student?studentId={studentId}',
          },
          { key: 'programCode', label: 'Programme', kind: 'code' },
          { key: 'payablePaise', label: 'Payable', kind: 'money' },
          { key: 'paidPaise', label: 'Paid', kind: 'money' },
          {
            key: 'outstandingPaise',
            label: 'Outstanding',
            kind: 'money',
            alertWhen: 'overdue',
          },
        ],
      },
      {
        kind: 'form',
        title: "Issue this term's charges",
        note:
          'Turns the price list into money owed, for every student in the term ' +
          'at once, and posts it to the books. Safe to run again: a student ' +
          'already issued is skipped, and a charge added since goes out on its ' +
          'own supplementary entry.',
        submit: 'Issue',
        path: '/invoices',
        roles: [...ADMIN],
        fields: [{ name: 'termId', kind: 'hidden', label: '', value: String(data.termId ?? '') }],
      },
    ],
  },

  {
    path: '/student',
    title: 'Student ledger',
    roles: [...OFFICE, 'hod'],
    async load(actor, req) {
      const a = actor as Actor
      const studentId = param(req, 'studentId') ?? a.id
      const { term } = await termFor(a, req)
      if (!term) return { lines: [], payments: [], pending: [], charges: [] }

      const l = await studentLedger(a, studentId, term.id)
      return {
        who: l.studentName ?? l.studentEmail,
        termCode: l.termCode,
        studentId,
        payable: l.payablePaise,
        credited: l.creditedPaise,
        paid: l.paidPaise,
        outstanding: l.outstandingPaise,
        overpaid: l.overpaidPaise,
        unreconciled: l.unreconciledPaise,
        refunded: l.refundedPaise,
        invoiced: !!l.invoicedAt,
        termId: term.id,
        lines: l.lines.map((line) => ({
          ...line,
          payablePaise: line.chargedPaise - line.waivedPaise,
        })),
        charges: l.lines.map((line) => ({
          value: line.feeItemId,
          label: `${line.label} - ${formatPaise(line.chargedPaise)}`,
        })),
        payments: l.payments.map((p) => ({
          ...p,
          receiptHref: `/api/v1/modules/fees/receipt.pdf?paymentId=${p.id}`,
          status: p.reconciledAt ? 'confirmed' : 'pending',
          pending: !p.reconciledAt,
        })),
        pending: l.payments
          .filter((p) => !p.reconciledAt)
          .map((p) => ({
            value: p.id,
            label: `${p.receiptNo} - ${formatPaise(p.amountPaise)}`,
          })),
        receipts: l.payments.map((p) => ({
          value: p.id,
          label: `${p.receiptNo} - ${formatPaise(p.amountPaise)}`,
        })),
      }
    },
    sections: (data) => [
      {
        kind: 'figures',
        title: `${data.who ?? 'Student'} - ${data.termCode ?? ''}`,
        figures: [
          { label: 'Payable', value: formatPaise(Number(data.payable ?? 0)) },
          ...(Number(data.credited ?? 0) > 0
            ? [
                {
                  label: 'Aid and credits',
                  value: formatPaise(Number(data.credited)),
                  tone: 'clear' as const,
                },
              ]
            : []),
          { label: 'Paid', value: formatPaise(Number(data.paid ?? 0)) },
          {
            label: 'Outstanding',
            value: formatPaise(Number(data.outstanding ?? 0)),
            tone: Number(data.outstanding ?? 0) > 0 ? 'due' : 'clear',
          },
          ...(Number(data.overpaid ?? 0) > 0
            ? [
                {
                  label: 'In credit',
                  value: formatPaise(Number(data.overpaid)),
                  tone: 'clear' as const,
                },
              ]
            : []),
          ...(Number(data.refunded ?? 0) > 0
            ? [{ label: 'Refunded', value: formatPaise(Number(data.refunded)) }]
            : []),
        ],
      },
      ...(data.invoiced
        ? []
        : [
            {
              kind: 'note' as const,
              text:
                'These charges have not been issued for this term yet, so nothing ' +
                'here is in the books. Issue them from the dues list.',
            },
          ]),
      ...(Number(data.unreconciled ?? 0) > 0
        ? [
            {
              kind: 'note' as const,
              tone: 'warn' as const,
              text: `${formatPaise(
                Number(data.unreconciled),
              )} is recorded but not yet confirmed against the bank. It counts against what is owed, and the receipt says pending until it clears.`,
            },
          ]
        : []),
      {
        kind: 'table',
        title: 'Charges',
        rows: 'lines',
        empty: 'No charges for this term.',
        columns: [
          { key: 'label', label: 'Item' },
          { key: 'chargedPaise', label: 'Charged', kind: 'money' },
          { key: 'waivedPaise', label: 'Waived', kind: 'money' },
          { key: 'payablePaise', label: 'Payable', kind: 'money' },
          { key: 'waiverReason', label: 'Reason' },
        ],
      },
      {
        kind: 'table',
        title: 'Payments',
        rows: 'payments',
        empty: 'Nothing received yet.',
        columns: [
          { key: 'receiptNo', label: 'Receipt', kind: 'code', href: '{receiptHref}' },
          { key: 'receivedAt', label: 'Date', kind: 'date' },
          { key: 'method', label: 'Method' },
          { key: 'amountPaise', label: 'Amount', kind: 'money' },
          { key: 'status', label: 'Status', alertWhen: 'pending' },
        ],
      },
      {
        kind: 'form',
        title: 'Record a payment',
        note:
          'A receipt number is issued on saving and cannot afterwards be changed. ' +
          'Confirm it against the bank separately, below.',
        submit: 'Record payment',
        path: '/payments',
        fields: [
          { name: 'studentId', kind: 'hidden', label: '', value: String(data.studentId ?? '') },
          { name: 'termId', kind: 'hidden', label: '', value: String(data.termId ?? '') },
          { name: 'amount', label: 'Amount', kind: 'money', hint: 'Rupees' },
          {
            name: 'method',
            label: 'Method',
            kind: 'select',
            options: [
              { value: 'cash', label: 'cash' },
              { value: 'cheque', label: 'cheque' },
              { value: 'bank_transfer', label: 'bank transfer' },
              { value: 'upi', label: 'upi' },
              { value: 'card', label: 'card' },
              { value: 'other', label: 'other' },
            ],
          },
          {
            name: 'reference',
            label: 'Reference',
            optional: true,
            hint: 'Cheque number, UPI reference, whatever identifies it on the statement',
          },
          { name: 'notes', label: 'Notes', optional: true },
        ],
      },
      {
        kind: 'form',
        title: 'Confirm against the bank',
        note: 'Which statement line this matches. Recorded on the audit trail.',
        submit: 'Confirm',
        path: '/payments/reconcile',
        fields: [
          { name: 'paymentId', label: 'Payment', kind: 'select', options: 'pending' },
          { name: 'reason', label: 'Reason' },
        ],
      },
      {
        kind: 'form',
        title: 'Refund a payment',
        note:
          'Money going back out, against the receipt it came in on. The payment ' +
          'itself stays on the record, and never more can go back than came in.',
        submit: 'Refund',
        path: '/refunds',
        roles: [...ADMIN],
        fields: [
          { name: 'paymentId', label: 'Receipt', kind: 'select', options: 'receipts' },
          { name: 'amount', label: 'Amount', kind: 'money', hint: 'Rupees' },
          {
            name: 'method',
            label: 'Returned by',
            kind: 'select',
            optional: true,
            options: [
              { value: 'cash', label: 'cash' },
              { value: 'cheque', label: 'cheque' },
              { value: 'bank_transfer', label: 'bank transfer' },
              { value: 'upi', label: 'upi' },
              { value: 'card', label: 'card' },
              { value: 'other', label: 'other' },
            ],
          },
          { name: 'reference', label: 'Reference', optional: true },
          { name: 'reason', label: 'Reason', hint: 'At least five characters' },
        ],
      },
      {
        kind: 'form',
        title: 'Waive a charge',
        note:
          'A waiver cannot exceed the charge it applies to. Granting one against ' +
          'a charge already waived revises it, and both amounts go on the trail.',
        submit: 'Grant waiver',
        path: '/waivers',
        roles: [...ADMIN],
        fields: [
          { name: 'studentId', kind: 'hidden', label: '', value: String(data.studentId ?? '') },
          { name: 'feeItemId', label: 'Charge', kind: 'select', options: 'charges' },
          { name: 'amount', label: 'Amount to waive', kind: 'money', hint: 'Rupees' },
          { name: 'reason', label: 'Reason', hint: 'At least five characters' },
        ],
      },
    ],
  },

  {
    path: '/me',
    title: 'My fees',
    menu: 'My fees',
    roles: ['student'],
    async load(actor, req) {
      const a = actor as Actor
      const { structure, term } = await termFor(a, req)
      if (!term) return { lines: [], payments: [], terms: [] }

      const l = await studentLedger(a, a.id, term.id)
      return {
        termCode: l.termCode,
        payable: l.payablePaise,
        credited: l.creditedPaise,
        paid: l.paidPaise,
        outstanding: l.outstandingPaise,
        unreconciled: l.unreconciledPaise,
        lines: l.lines.map((line) => ({
          ...line,
          payablePaise: line.chargedPaise - line.waivedPaise,
        })),
        payments: l.payments.map((p) => ({
          ...p,
          receiptHref: `/api/v1/modules/fees/receipt.pdf?paymentId=${p.id}`,
          status: p.reconciledAt ? 'confirmed' : 'pending',
          pending: !p.reconciledAt,
        })),
        terms: structure.terms.map((t) => ({
          label: t.code,
          href: `/m/fees/me?termId=${t.id}`,
          active: t.id === term.id,
        })),
      }
    },
    sections: (data) => [
      { kind: 'links', title: 'Term', links: data.terms as never },
      {
        kind: 'figures',
        figures: [
          { label: 'Payable', value: formatPaise(Number(data.payable ?? 0)) },
          ...(Number(data.credited ?? 0) > 0
            ? [
                {
                  label: 'Aid and credits',
                  value: formatPaise(Number(data.credited)),
                  tone: 'clear' as const,
                },
              ]
            : []),
          { label: 'Paid', value: formatPaise(Number(data.paid ?? 0)) },
          {
            label: 'Outstanding',
            value: formatPaise(Number(data.outstanding ?? 0)),
            tone: Number(data.outstanding ?? 0) > 0 ? 'due' : 'clear',
          },
        ],
      },
      ...(Number(data.unreconciled ?? 0) > 0
        ? [
            {
              kind: 'note' as const,
              tone: 'warn' as const,
              text: `${formatPaise(
                Number(data.unreconciled),
              )} is recorded but not yet confirmed against the bank. It counts against what you owe, and the receipt will be marked pending until it clears.`,
            },
          ]
        : []),
      {
        kind: 'table',
        title: 'Charges',
        rows: 'lines',
        empty: 'Nothing charged yet.',
        columns: [
          { key: 'label', label: 'Item' },
          { key: 'chargedPaise', label: 'Charged', kind: 'money' },
          { key: 'waivedPaise', label: 'Waived', kind: 'money' },
          { key: 'payablePaise', label: 'Payable', kind: 'money' },
        ],
      },
      {
        kind: 'table',
        title: 'Payments',
        rows: 'payments',
        empty: 'Nothing received yet.',
        columns: [
          { key: 'receiptNo', label: 'Receipt', kind: 'code', href: '{receiptHref}' },
          { key: 'receivedAt', label: 'Date', kind: 'date' },
          { key: 'amountPaise', label: 'Amount', kind: 'money' },
          { key: 'status', label: 'Status', alertWhen: 'pending' },
        ],
      },
    ],
  },

  {
    path: '/aid',
    title: 'Aid and refunds',
    menu: 'Aid',
    roles: [...ADMIN],
    async load(actor, req) {
      const a = actor as Actor
      const structure = await listStructure(a as never)
      const current = structure.terms.find((t) => t.isCurrent) ?? structure.terms[0] ?? null
      const termId = param(req, 'termId') ?? current?.id ?? null

      const [rules, awards, brackets, credits] = await Promise.all([
        listScholarships(a),
        termId ? listAwards(a, { termId }) : Promise.resolve([]),
        termId ? listRefundRules(a, termId) : Promise.resolve([]),
        termId ? listDropCredits(a, termId) : Promise.resolve([]),
      ])

      return {
        termId,
        termName: current ? `${current.code} - ${current.name}` : null,
        scholarships: rules.map((r) => ({
          ...r,
          worth:
            r.basis === 'fixed'
              ? formatPaise(r.amountPaise ?? 0)
              : `${(r.percentBps ?? 0) / 100}% of charges`,
          asks: [
            r.minCredits > 0 ? `${r.minCredits} credits` : null,
            r.minCgpa === null ? null : `${r.minCgpa} average`,
          ]
            .filter(Boolean)
            .join(', ') || 'nothing',
        })),
        awards: awards.map((w) => ({
          ...w,
          amount: formatPaise(w.amountPaise),
          held: w.status === 'awarded',
        })),
        awardedPaise: formatPaise(
          awards.filter((w) => w.status === 'awarded').reduce((n, w) => n + w.amountPaise, 0),
        ),
        brackets: brackets.map((b) => ({
          ...b,
          share: `${b.refundBps / 100}%`,
        })),
        credits: credits.map((d) => ({
          ...d,
          amount: formatPaise(d.amountPaise),
          share: `${d.refundBps / 100}%`,
        })),
        creditedPaise: formatPaise(credits.reduce((n, d) => n + d.amountPaise, 0)),
        scholarshipOptions: rules
          .filter((r) => r.isActive)
          .map((r) => ({ value: r.id, label: `${r.code} - ${r.name}` })),
        termOptions: structure.terms.map((t) => ({
          value: t.id,
          label: `${t.code} - ${t.name}`,
        })),
      }
    },
    sections: (data) => [
      {
        kind: 'note',
        text: data.termName
          ? `${String(data.termName)}. Scholarships the institution funds itself; a government or state scheme is recorded here as an award with the scheme named on it, because its eligibility lives where its rules do.`
          : 'No term yet. Aid and refunds are both worked out per term.',
      },
      {
        kind: 'figures',
        figures: [
          { label: 'Awarded this term', value: String(data.awardedPaise), tone: 'clear' },
          { label: 'Credited for drops', value: String(data.creditedPaise), tone: 'clear' },
        ],
      },
      {
        kind: 'table',
        title: 'Scholarships',
        rows: 'scholarships',
        empty: 'None defined.',
        columns: [
          { key: 'code', label: 'Code', kind: 'code' },
          { key: 'name', label: 'Name' },
          { key: 'kind', label: 'Kind' },
          { key: 'worth', label: 'Worth' },
          { key: 'asks', label: 'Asks for' },
          { key: 'isActive', label: 'Live', kind: 'bool' },
        ],
      },
      {
        kind: 'table',
        title: 'Awards this term',
        note: 'Revoking posts the reversal and keeps the row: a student who lost a scholarship and a student who never had one are different facts.',
        rows: 'awards',
        empty: 'Nothing awarded.',
        columns: [
          { key: 'studentName', label: 'Student' },
          { key: 'code', label: 'Scholarship', kind: 'code' },
          { key: 'amount', label: 'Amount' },
          { key: 'status', label: 'Status' },
          { key: 'creditsAtAward', label: 'Credits then' },
          { key: 'cgpaAtAward', label: 'Average then' },
        ],
      },
      {
        kind: 'form',
        title: 'Define a scholarship',
        note: 'A fixed sum, or a share of what the student was charged. The minimums are checked against registered credits and the academic record, never entered by hand.',
        submit: 'Define',
        path: '/scholarships',
        fields: [
          { name: 'code', label: 'Code' },
          { name: 'name', label: 'Name' },
          {
            name: 'kind',
            label: 'Kind',
            kind: 'select',
            options: [
              { value: 'merit', label: 'merit' },
              { value: 'need', label: 'need' },
              { value: 'staff', label: 'staff' },
              { value: 'sport', label: 'sport' },
              { value: 'other', label: 'other' },
            ],
          },
          {
            name: 'basis',
            label: 'Basis',
            kind: 'select',
            options: [
              { value: 'fixed', label: 'fixed - a sum per term' },
              { value: 'proportional', label: 'proportional - a share of charges' },
            ],
          },
          { name: 'amountPaise', label: 'Amount', kind: 'money', optional: true },
          {
            name: 'percentBps',
            label: 'Share',
            kind: 'number',
            optional: true,
            hint: 'Basis points: 2500 is a quarter of the term charges.',
          },
          { name: 'minCredits', label: 'Minimum credits', kind: 'number', optional: true },
          { name: 'minCgpa', label: 'Minimum average', kind: 'number', optional: true },
        ],
      },
      {
        kind: 'form',
        title: 'Award one',
        note: 'Refused unless the student actually qualifies, and the amount is settled and frozen when it is granted.',
        submit: 'Award',
        path: '/aid/award',
        fields: [
          {
            name: 'scholarshipId',
            label: 'Scholarship',
            kind: 'select',
            options: 'scholarshipOptions',
          },
          { name: 'studentId', label: 'Student id' },
          { name: 'termId', label: 'Term', kind: 'select', options: 'termOptions' },
          { name: 'reason', label: 'Note', optional: true },
        ],
      },
      {
        kind: 'form',
        title: 'Withdraw an award',
        submit: 'Withdraw',
        path: '/aid/revoke',
        fields: [
          { name: 'awardId', label: 'Award id' },
          { name: 'reason', label: 'Reason', hint: 'At least five characters' },
        ],
      },
      {
        kind: 'table',
        title: 'Refund brackets',
        note: 'The first bracket a drop date falls within decides it. Past every bracket, the charge is kept in full.',
        rows: 'brackets',
        empty: 'None set, so a drop returns nothing.',
        columns: [
          { key: 'throughOn', label: 'Through', kind: 'date' },
          { key: 'share', label: 'Returned' },
        ],
      },
      {
        kind: 'table',
        title: 'Credited for dropped courses',
        rows: 'credits',
        empty: 'Nothing credited.',
        columns: [
          { key: 'studentName', label: 'Student' },
          { key: 'creditsDropped', label: 'Credits' },
          { key: 'effectiveOn', label: 'Dropped', kind: 'date' },
          { key: 'share', label: 'Bracket' },
          { key: 'amount', label: 'Credited' },
        ],
      },
      {
        kind: 'form',
        title: 'Work the drops into credits',
        note: 'Once per dropped course, however many times this is run. Only tuition-style lines move: a registration fee is not returned because somebody dropped a paper.',
        submit: 'Prorate',
        path: '/drops/prorate',
        fields: [
          { name: 'termId', label: 'Term', kind: 'select', options: 'termOptions' },
          { name: 'studentId', label: 'One student only', optional: true },
        ],
      },
    ],
  },
]
