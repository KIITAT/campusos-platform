import type { PluginPage, PluginSection } from '@campusos/module-framework'
import { formatPaise } from '@campusos/money'
import { listStructure } from '@campusos/module-academic/api'
import {
  claimCounts,
  claimPage,
  claimQueue,
  letterSettingsOf,
  listBankAccounts,
  listDemandLetters,
  myClaims,
  pendingClaimOptions,
  qrSection,
  statementPage,
  statementView,
  studentChoices,
  upiFor,
  type Actor,
  type UpiPay,
} from './api'

const OFFICE = ['institution_admin', 'super_admin', 'accounts_staff'] as const
const ADMIN = ['institution_admin', 'super_admin'] as const

const MODES = [
  { value: 'upi', label: 'UPI' },
  { value: 'neft', label: 'NEFT' },
  { value: 'rtgs', label: 'RTGS' },
  { value: 'imps', label: 'IMPS' },
  { value: 'cheque', label: 'Cheque deposited at the bank' },
]
const PURPOSES = [
  { value: 'education_loan', label: 'Education loan' },
  { value: 'scholarship', label: 'Scholarship' },
  { value: 'other', label: 'Something else' },
]

async function termOptions(actor: Actor) {
  const s = await listStructure(actor as never)
  const current = s.terms.find((t) => t.isCurrent)
  return {
    terms: s.terms.map((t) => ({ value: t.id, label: `${t.code} - ${t.name}${t.isCurrent ? ' (current)' : ''}` })),
    current: current?.id ?? '',
  }
}

const day = (d: Date | string | null) => (d ? new Date(d).toISOString().slice(0, 10) : '')

export const transferPages: PluginPage[] = [
  {
    path: '/transfer',
    title: 'Pay fees',
    menu: 'Pay fees',
    roles: ['student'],
    async load(actor) {
      const a = actor as Actor
      const [accounts, claims, t] = await Promise.all([listBankAccounts(a), myClaims(a), termOptions(a)])
      const live = accounts.filter((x) => x.state === 'active')
      return {
        upi: t.current ? await upiFor(a, a.id, t.current) : null,
        accounts: live,
        accountOptions: live.map((x) => ({ value: x.id, label: `${x.label}: ${x.bankName} ${x.accountNumber}` })),
        claims: claims.map((c) => ({ ...c, submitted: day(c.submittedAt), decided: day(c.decidedAt) })),
        ...t,
      }
    },
    sections: (data) => [
      {
        kind: 'note',
        text:
          'Paid by UPI, RTGS, NEFT or IMPS, or deposited a cheque at the bank? Tell the accounts office here, exactly as your bank shows it. ' +
          'They find it on the bank statement and turn it into a receipt; until then it shows as pending. A reference can be reported once.',
      },
      ...(data.upi ? [qrSection(data.upi as UpiPay)] : []),
      {
        kind: 'table',
        title: 'Pay into',
        rows: 'accounts',
        empty: 'The institution has not listed an account for fees yet.',
        columns: [
          { key: 'label', label: 'For' },
          { key: 'accountName', label: 'Account name' },
          { key: 'bankName', label: 'Bank' },
          { key: 'branch', label: 'Branch' },
          { key: 'accountNumber', label: 'Account number', kind: 'code' },
          { key: 'ifsc', label: 'IFSC', kind: 'code' },
        ],
      },
      {
        kind: 'form',
        title: 'Report a payment',
        submit: 'Submit',
        path: '/transfers',
        fields: [
          { name: 'termId', label: 'For the term', kind: 'select', options: 'terms', value: String(data.current ?? '') },
          { name: 'accountId', label: 'Paid into', kind: 'select', options: 'accountOptions' },
          { name: 'mode', label: 'How', kind: 'radio', options: MODES, value: 'neft' },
          { name: 'transferredOn', label: 'Date of the transfer', kind: 'date' },
          { name: 'amount', label: 'Amount', kind: 'money', hint: 'Rupees, exactly as transferred.' },
          {
            name: 'utr',
            label: 'UTR, UPI reference or cheque number',
            hint: 'UPI: the 12-digit reference your UPI app shows. Cheque: the 6-digit number. Transfers: the UTR on your bank’s confirmation.',
          },
          { name: 'remitterBank', label: 'Your bank' },
          { name: 'remitterBranch', label: 'Your branch', optional: true },
          { name: 'remitterIfsc', label: 'Your bank’s IFSC', optional: true, hint: 'Cheques: the IFSC printed on the cheque' },
          { name: 'drawerAccount', label: 'Cheque’s account number', optional: true, hint: 'Cheques only: printed at the bottom of the cheque' },
          { name: 'accountHolder', label: 'Paid from the account of', hint: 'Whose account it came from: you, a parent.' },
          { name: 'contactPhone', label: 'Phone, if the office needs to ask' },
          { name: 'bankReference', label: 'Bank reference, if given', optional: true },
        ],
      },
      {
        kind: 'table',
        title: 'Reported',
        rows: 'claims',
        empty: 'Nothing reported yet.',
        columns: [
          { key: 'submitted', label: 'Reported' },
          { key: 'term', label: 'Term', kind: 'code' },
          { key: 'modeText', label: 'How' },
          { key: 'transferredOn', label: 'Transferred' },
          { key: 'amount', label: 'Amount' },
          { key: 'utr', label: 'UTR', kind: 'code' },
          { key: 'status', label: 'State', kind: 'status' },
          { key: 'receiptNo', label: 'Receipt', kind: 'code' },
          { key: 'decisionNote', label: 'Note' },
        ],
      },
    ],
  },

  {
    path: '/letter',
    title: 'Demand letter',
    menu: 'Demand letter',
    roles: ['student'],
    async load(actor) {
      const a = actor as Actor
      const [letters, t] = await Promise.all([listDemandLetters(a), termOptions(a)])
      return { letters: letters.map((l) => ({ ...l, issued: day(l.issuedAt), pdf: 'Download' })), ...t }
    },
    sections: () => [
      {
        kind: 'note',
        text:
          'A letter for a bank or a scholarship body, stating the fees for a term, what was taken off, and what is due, with the account to pay into. ' +
          'Each letter is numbered and kept; the bank can confirm it with the accounts office by its number.',
      },
      {
        kind: 'form',
        title: 'Ask for a letter',
        submit: 'Issue the letter',
        path: '/letters',
        fields: [
          { name: 'termId', label: 'Term', kind: 'select', options: 'terms' },
          { name: 'addressee', label: 'Addressed to', hint: 'e.g. The Branch Manager, State Bank of India, Patia, Bhubaneswar' },
          { name: 'purpose', label: 'For', kind: 'radio', options: PURPOSES, value: 'education_loan' },
        ],
      },
      {
        kind: 'table',
        title: 'Your letters',
        rows: 'letters',
        empty: 'None yet.',
        columns: [
          { key: 'number', label: 'Number', kind: 'code' },
          { key: 'term', label: 'Term', kind: 'code' },
          { key: 'addressee', label: 'To' },
          { key: 'balance', label: 'Due' },
          { key: 'issued', label: 'Issued' },
          { key: 'pdf', label: '', href: '/api/v1/modules/fees/demand-letter.pdf?letterId={id}' },
        ],
      },
    ],
  },

  {
    path: '/transfers',
    title: 'Reported payments',
    menu: 'Reported payments',
    roles: [...OFFICE],
    async load(actor, req) {
      const a = actor as Actor
      const [claims, pendingOptions, counts] = await Promise.all([
        claimQueue(a, null, claimPage(req, 'claims')),
        pendingClaimOptions(a),
        claimCounts(a),
      ])
      return {
        claims: claims.rows.map((c) => ({ ...c, submitted: day(c.submittedAt) })),
        claimsPage: { total: claims.total, next: claims.next },
        pendingOptions,
        counts: { pending: counts.pending, pendingAmount: counts.pendingPaise, verified: counts.verified },
      }
    },
    sections: (data) => {
      const n = data.counts as { pending: number; pendingAmount: number; verified: number }
      const out: PluginSection[] = [
        {
          kind: 'figures',
          figures: [
            { label: 'Waiting to be checked', value: String(n.pending), tone: n.pending ? 'due' : 'clear' },
            { label: 'Claimed, waiting', value: formatPaise(n.pendingAmount) },
            { label: 'Verified', value: String(n.verified) },
          ],
        },
        {
          kind: 'note',
          text:
            'Find each payment on the bank statement by its reference, date and amount, or let Match the statement on the Bank statement page do it. Verifying records the payment, gives the student a receipt and marks it reconciled, in one act; ' +
            'a transfer not on the statement is rejected with a reason the student reads.',
        },
        {
          kind: 'table',
          title: 'Reported payments',
          rows: 'claims',
          empty: 'Nothing reported.',
          paging: { data: 'claimsPage', sorts: ['queue'] },
          columns: [
            { key: 'student', label: 'Student' },
            { key: 'term', label: 'Term', kind: 'code' },
            { key: 'modeText', label: 'How' },
            { key: 'transferredOn', label: 'Transferred' },
            { key: 'amount', label: 'Amount' },
            { key: 'utr', label: 'UTR', kind: 'code' },
            { key: 'remitterBank', label: 'From bank' },
            { key: 'accountHolder', label: 'Account of' },
            { key: 'account', label: 'Into' },
            { key: 'status', label: 'State', kind: 'status' },
            { key: 'receiptNo', label: 'Receipt', kind: 'code' },
          ],
        },
      ]
      if (n.pending) {
        out.push(
          {
            kind: 'form',
            title: 'Verify a transfer',
            note: 'Found on the statement, for the amount claimed.',
            submit: 'Verify and receipt',
            path: '/transfers/verify',
            fields: [
              { name: 'claimId', label: 'Transfer', kind: 'select', options: 'pendingOptions' },
              { name: 'note', label: 'Note', optional: true, hint: 'e.g. statement of 3 Oct, line 42' },
            ],
          },
          {
            kind: 'form',
            title: 'Reject a transfer',
            submit: 'Reject',
            path: '/transfers/reject',
            fields: [
              { name: 'claimId', label: 'Transfer', kind: 'select', options: 'pendingOptions' },
              { name: 'reason', label: 'Why', kind: 'textarea', rows: 2, hint: 'The student reads this.' },
            ],
          },
        )
      }
      return out
    },
  },

  {
    path: '/accounts',
    title: 'Accounts and letters',
    menu: 'Accounts and letters',
    roles: [...OFFICE],
    async load(actor) {
      const a = actor as Actor
      const [accounts, letters, settings, students, t] = await Promise.all([
        listBankAccounts(a),
        listDemandLetters(a),
        letterSettingsOf(a),
        studentChoices(a),
        termOptions(a),
      ])
      return {
        accounts,
        liveOptions: accounts.filter((x) => x.state === 'active').map((x) => ({ value: x.id, label: `${x.label}: ${x.accountNumber}` })),
        letters: letters.map((l) => ({ ...l, issued: day(l.issuedAt), pdf: 'PDF' })),
        settings,
        students,
        ...t,
      }
    },
    sections: (data) => {
      const s = data.settings as { signatoryName: string; signatoryTitle: string; opening: string; closing: string }
      return [
        {
          kind: 'table',
          title: 'Accounts fees are paid into',
          rows: 'accounts',
          empty: 'None yet: add the account students should pay into.',
          columns: [
            { key: 'label', label: 'For' },
            { key: 'accountName', label: 'Account name' },
            { key: 'bankName', label: 'Bank' },
            { key: 'branch', label: 'Branch' },
            { key: 'accountNumber', label: 'Number', kind: 'code' },
            { key: 'ifsc', label: 'IFSC', kind: 'code' },
            { key: 'upiVpa', label: 'UPI ID', kind: 'code' },
            { key: 'state', label: 'State', kind: 'status' },
          ],
        },
        {
          kind: 'form',
          title: 'Add an account',
          submit: 'Add',
          path: '/bank-accounts',
          roles: [...ADMIN],
          fields: [
            { name: 'label', label: 'For', hint: 'As students know it, e.g. School of Computer Engineering' },
            { name: 'accountName', label: 'Account name' },
            { name: 'bankName', label: 'Bank' },
            { name: 'branch', label: 'Branch' },
            { name: 'accountNumber', label: 'Account number' },
            { name: 'ifsc', label: 'IFSC' },
          ],
        },
        {
          kind: 'form',
          title: 'UPI for an account',
          submit: 'Save',
          path: '/bank-accounts/upi',
          roles: [...ADMIN],
          fields: [
            { name: 'accountId', label: 'Account', kind: 'select', options: 'liveOptions' },
            { name: 'vpa', label: 'UPI ID', optional: true, hint: 'For example fees.kiit@sbi. Leave empty to remove.' },
            { name: 'merchant', label: 'This is a merchant UPI ID (the QR then carries the amount due)', kind: 'checkbox', optional: true },
          ],
        },
        {
          kind: 'form',
          title: 'Retire an account',
          submit: 'Retire',
          path: '/bank-accounts/retire',
          roles: [...ADMIN],
          fields: [{ name: 'accountId', label: 'Account', kind: 'select', options: 'liveOptions' }],
        },
        {
          kind: 'table',
          title: 'Demand letters issued',
          note: 'A bank asking whether a letter is ours: filter by its number.',
          rows: 'letters',
          empty: 'None yet.',
          pageSize: 50,
          columns: [
            { key: 'number', label: 'Number', kind: 'code' },
            { key: 'student', label: 'Student' },
            { key: 'term', label: 'Term', kind: 'code' },
            { key: 'addressee', label: 'To' },
            { key: 'purpose', label: 'For' },
            { key: 'payable', label: 'Payable' },
            { key: 'balance', label: 'Due' },
            { key: 'issued', label: 'Issued' },
            { key: 'pdf', label: '', href: '/api/v1/modules/fees/demand-letter.pdf?letterId={id}' },
          ],
        },
        {
          kind: 'form',
          title: 'Issue a letter for a student',
          submit: 'Issue',
          path: '/letters',
          fields: [
            { name: 'studentId', label: 'Student', kind: 'select', options: 'students' },
            { name: 'termId', label: 'Term', kind: 'select', options: 'terms', value: String(data.current ?? '') },
            { name: 'addressee', label: 'Addressed to' },
            { name: 'purpose', label: 'For', kind: 'radio', options: PURPOSES, value: 'education_loan' },
          ],
        },
        {
          kind: 'form',
          title: 'What a letter says',
          note: 'The figures, the student and the account are filled in; this is the wording around them, and who signs.',
          submit: 'Save',
          path: '/letters/settings',
          roles: [...ADMIN],
          fields: [
            { name: 'signatoryName', label: 'Signed by', value: s.signatoryName },
            { name: 'signatoryTitle', label: 'Title', value: s.signatoryTitle },
            { name: 'opening', label: 'Opening', kind: 'textarea', rows: 3, value: s.opening },
            { name: 'closing', label: 'Closing', kind: 'textarea', rows: 3, value: s.closing },
          ],
        },
      ]
    },
  },
  {
    path: '/statement',
    title: 'Bank statement',
    menu: 'Bank statement',
    roles: ['institution_admin', 'accounts_staff'],
    async load(actor, req) {
      const a = actor as Actor
      const [view, students, t] = await Promise.all([statementView(a, statementPage(req, 'rows')), studentChoices(a), termOptions(a)])
      return {
        ...view,
        rows: 'rows' in view ? view.rows : [],
        rowsPage: 'rows' in view ? { total: view.total, next: view.next } : { total: 0, next: null },
        students,
        ...t,
      }
    },
    sections: (data) => {
      if (!data.account) return [{ kind: 'note', tone: 'warn', text: String(data.message ?? '') }]
      const totals = data.totals as { count: number; amountPaise: number }
      return [
        {
          kind: 'figures',
          figures: [
            { label: 'Credits not yet matched', value: String(totals.count), tone: totals.count ? 'due' : 'clear' },
            { label: 'Amount', value: formatPaise(totals.amountPaise) },
          ],
        },
        {
          kind: 'note',
          text:
            'Import the statement under Finance, Bank accounts. Matching receipts the payments that name a reported UPI or transfer reference, or the reference on our UPI QR, and marks them reconciled; ' +
            'everything else waits here for you. A line that is not a fee: set it aside on the finance bank page.',
        },
        { kind: 'form', title: 'Match the statement', submit: 'Match', path: '/statement/match', fields: [] },
        {
          kind: 'table',
          title: 'Credits not yet matched',
          rows: 'rows',
          empty: 'Every credit on the statement is matched.',
          paging: { data: 'rowsPage', sorts: ['date'] },
          columns: [
            { key: 'txnDate', label: 'Date', kind: 'date' },
            { key: 'description', label: 'Narration' },
            { key: 'reference', label: 'Reference', kind: 'code' },
            { key: 'depositPaise', label: 'Amount', kind: 'money' },
            { key: 'suggested', label: 'Suggested' },
          ],
        },
        {
          kind: 'form',
          title: 'Receipt a statement line',
          submit: 'Receipt',
          path: '/statement/receipt',
          fields: [
            { name: 'lineId', label: 'Statement line', kind: 'select', options: 'lineOptions' },
            { name: 'studentId', label: 'Student', kind: 'select', options: 'students' },
            { name: 'termId', label: 'Term', kind: 'select', options: 'terms', value: String(data.current ?? '') },
            {
              name: 'method',
              label: 'How it was paid',
              kind: 'radio',
              options: [
                { value: 'upi', label: 'UPI' },
                { value: 'bank_transfer', label: 'Bank transfer' },
                { value: 'cheque', label: 'Cheque' },
              ],
              value: 'upi',
            },
            { name: 'reference', label: 'Reference as on the statement' },
            { name: 'drawerIfsc', label: 'Cheque: drawer’s IFSC', optional: true },
            { name: 'drawerAccount', label: 'Cheque: drawer’s account number', optional: true },
          ],
        },
      ]
    },
  },

]
