import { formatPaise } from '@campusos/money'
import { param, type PluginPage } from '@campusos/module-framework'
import {
  borrowerStatus,
  catalogue,
  LibraryError,
  copiesOf,
  doorCode,
  encodeQr,
  getSettings,
  mySessions,
  occupancy,
  openSessions,
  sessionPage,
  loanPage,
  titlePage,
  openLoans,
  overdueReport,
  type Actor,
} from './api'

const DESK = ['institution_admin', 'super_admin', 'library_staff'] as const
const ADMIN = ['institution_admin', 'super_admin'] as const
const EVERYONE = [...DESK, 'faculty', 'student'] as const

/** A loan, flattened for a table the host renders generically. */
const loanRow = (l: {
  id: string
  title: string
  author: string
  accessionNo: string
  borrowerName: string | null
  borrowerEmail: string | null
  dueOn: string
  daysOverdue: number
  finePaise: number
  fineWaivedPaise: number
  finePaidAt: string | null
  fineSettledBy?: string | null
}) => ({
  ...l,
  who: l.borrowerName ?? l.borrowerEmail,
  owing: l.finePaise - l.fineWaivedPaise,
  late: l.daysOverdue > 0,
  settled: l.finePaidAt ? (l.fineSettledBy === 'fee_account' ? 'on fee account' : 'paid') : l.finePaise > 0 ? 'owing' : '-',
})

export const pages: PluginPage[] = [
  {
    path: '/',
    title: 'Library desk',
    menu: 'Desk',
    roles: [...DESK],
    async load(actor, req) {
      const a = actor as Actor
      const [loans, rules] = await Promise.all([openLoans(a, loanPage(req, 'loans')), getSettings(a)])
      return {
        loans: loans.rows.map(loanRow),
        loansPage: { total: loans.total, next: loans.next },
        loanDays: rules.loanDays,
        finePerDay: formatPaise(rules.finePerDayPaise),
        out: loans.total,
        late: loans.late,
      }
    },
    sections: (data) => [
      {
        kind: 'note',
        text:
          `${data.out} out, ${data.late} overdue. Loans run ${data.loanDays} days ` +
          `at ${data.finePerDay} a day after that. A fine never exceeds what the ` +
          `copy is worth, whatever the rate — uncapped, losing a book becomes the ` +
          `cheaper option.`,
      },
      {
        kind: 'form',
        title: 'Issue',
        note: 'The accession number is the one stamped inside the cover.',
        submit: 'Issue',
        path: '/loans/issue',
        fields: [
          { name: 'accessionNo', label: 'Accession number' },
          { name: 'borrowerId', label: 'Borrower' },
        ],
      },
      {
        kind: 'form',
        title: 'Return',
        note:
          'The fine is worked out on return. Tick the box only if the book did ' +
          'not come back, or came back unusable: its replacement cost is then added to the fine.',
        submit: 'Return',
        path: '/loans/return',
        fields: [
          { name: 'accessionNo', label: 'Accession number' },
          {
            name: 'markLost',
            label: 'Lost or damaged beyond use',
            kind: 'checkbox',
            optional: true,
          },
        ],
      },
      {
        kind: 'table',
        title: 'Out now',
        rows: 'loans',
        paging: { data: 'loansPage', sorts: ['due'] },
        empty: 'Nothing out.',
        columns: [
          { key: 'title', label: 'Book' },
          { key: 'who', label: 'Borrower' },
          { key: 'accessionNo', label: 'Accession', kind: 'code' },
          { key: 'dueOn', label: 'Due', kind: 'date' },
          { key: 'daysOverdue', label: 'Late', kind: 'days', alertWhen: 'late' },
        ],
      },
    ],
  },

  {
    path: '/catalogue',
    title: 'Catalogue',
    menu: 'Catalogue',
    roles: [...EVERYONE],
    async load(actor, req) {
      const a = actor as Actor
      const q = param(req, 'q')
      const page = await catalogue(a, q, titlePage(req, 'rows'))
      const titleId = param(req, 'titleId')
      return {
        q: q ?? '',
        rows: page.rows.map((r) => ({ ...r, none: r.available === 0 })),
        rowsPage: { total: page.total, next: page.next },
        copies: titleId ? await copiesOf(a, titleId) : [],
      }
    },
    sections: (data) => [
      {
        kind: 'form',
        title: 'Search',
        submit: 'Search',
        path: '/catalogue',
        method: 'GET',
        fields: [
          {
            name: 'q',
            label: 'Title, author or ISBN',
            optional: true,
            value: String(data.q ?? ''),
          },
        ],
      },
      {
        kind: 'table',
        rows: 'rows',
        paging: { data: 'rowsPage', sorts: ['title'] },
        empty: 'Nothing matches.',
        columns: [
          {
            key: 'title',
            label: 'Title',
            href: '/m/library/catalogue?titleId={titleId}',
          },
          { key: 'author', label: 'Author' },
          { key: 'isbn', label: 'ISBN', kind: 'code' },
          { key: 'copies', label: 'Copies' },
          { key: 'available', label: 'On shelf', alertWhen: 'none' },
        ],
      },
      {
        kind: 'table',
        title: 'Copies',
        rows: 'copies',
        empty: 'Pick a title above to see its copies.',
        columns: [
          { key: 'accessionNo', label: 'Accession', kind: 'code' },
          { key: 'status', label: 'Status', kind: 'status' },
          { key: 'shelf', label: 'Shelf' },
          { key: 'borrowerName', label: 'Held by' },
          { key: 'dueOn', label: 'Due', kind: 'date' },
        ],
      },
      {
        kind: 'form',
        title: 'Catalogue a title',
        note:
          'Copies are added afterwards. ISBN is optional: plenty on these ' +
          'shelves predates it.',
        submit: 'Add title',
        path: '/titles',
        roles: [...DESK],
        fields: [
          { name: 'title', label: 'Title' },
          { name: 'author', label: 'Author' },
          { name: 'isbn', label: 'ISBN', optional: true, hint: '10 or 13 digits' },
          { name: 'publisher', label: 'Publisher', optional: true },
          { name: 'year', label: 'Year', kind: 'number', optional: true },
          { name: 'category', label: 'Category', optional: true },
        ],
      },
      {
        kind: 'form',
        title: 'Add copies',
        note:
          'One accession number per line or comma separated — paste from the ' +
          'delivery note. All of them land or none do.',
        submit: 'Add copies',
        path: '/copies',
        roles: [...DESK],
        fields: [
          { name: 'titleId', label: 'Title id' },
          { name: 'accessionNos', label: 'Accession numbers', kind: 'textarea', rows: 5 },
          { name: 'shelf', label: 'Shelf', optional: true },
          {
            name: 'replacement',
            label: 'Replacement cost',
            kind: 'money',
            optional: true,
            hint: 'Rupees. Caps the fine, so a lost book is never the cheaper option.',
          },
        ],
      },
    ],
  },

  {
    path: '/overdue',
    title: 'Overdue',
    menu: 'Overdue',
    roles: [...DESK],
    async load(actor, req) {
      const a = actor as Actor
      const report = await overdueReport(a, loanPage(req, 'rows'))
      return {
        rows: report.rows.map(loanRow),
        rowsPage: { total: report.total, next: report.next },
        total: formatPaise(report.totalAccruedPaise),
        count: report.total,
      }
    },
    sections: (data) => [
      {
        kind: 'note',
        text:
          `${data.count} books out past their date, ${data.total} accrued so far. ` +
          `These figures move every day until the book comes back.`,
      },
      {
        kind: 'table',
        rows: 'rows',
        paging: { data: 'rowsPage', sorts: ['due'] },
        empty: 'Nothing overdue.',
        columns: [
          { key: 'title', label: 'Book' },
          { key: 'who', label: 'Borrower' },
          { key: 'dueOn', label: 'Due', kind: 'date' },
          { key: 'daysOverdue', label: 'Late', kind: 'days', alertWhen: 'late' },
          { key: 'owing', label: 'Fine', kind: 'money' },
        ],
      },
      {
        kind: 'form',
        title: 'Settle a fine at the desk',
        note:
          'Only after the book is back: a fine is fixed on return, so settling an ' +
          'open loan would bank a figure that is still rising.',
        submit: 'Mark paid',
        path: '/fines/settle',
        fields: [
          { name: 'loanId', label: 'Loan id' },
          {
            name: 'method',
            label: 'How it was paid',
            kind: 'select',
            options: [
              { value: 'cash', label: 'Cash' },
              { value: 'upi', label: 'UPI' },
              { value: 'bank_transfer', label: 'Bank transfer' },
              { value: 'fee_account', label: 'To the fee account (students; billed with the term)' },
            ],
          },
        ],
      },
      {
        kind: 'form',
        title: 'Waive a fine',
        note: 'Reason mandatory and on the audit trail. A waiver cannot exceed the fine.',
        submit: 'Waive',
        path: '/fines/waive',
        roles: [...ADMIN],
        fields: [
          { name: 'loanId', label: 'Loan id' },
          { name: 'amount', label: 'Amount to waive', kind: 'money' },
          { name: 'reason', label: 'Reason' },
        ],
      },
    ],
  },

  {
    path: '/door',
    title: 'Door code',
    menu: 'Door code',
    roles: [...DESK],
    async load(actor) {
      try {
        const qr = await doorCode(actor as Actor)
        return { available: true, code: encodeQr(qr), seconds: Math.max(1, Math.ceil(qr.expiresInMs / 1000)) }
      } catch (e) {
        if (e instanceof LibraryError && e.code === 'door_scan_unavailable') return { available: false, code: '', seconds: 0 }
        throw e
      }
    },
    sections: (data) => [
      data.available
        ? {
            kind: 'qr' as const,
            title: 'Library door',
            value: String(data.code),
            caption: 'Students scan this with the library page on their phone, choosing in or out. It changes every 20 seconds: reload this page for a fresh code.',
          }
        : {
            kind: 'note' as const,
            text: 'Door scan needs the Attendance module, which is not enabled here. Record entries and exits at the desk on the Inside now page.',
          },
    ],
  },

  {
    path: '/inside',
    title: 'Inside now',
    menu: 'Inside now',
    roles: [...DESK],
    async load(actor, req) {
      const a = actor as Actor
      const [now, head] = await Promise.all([openSessions(a, sessionPage(req, 'inside')), occupancy(a)])
      return {
        inside: now.rows.map((r) => ({ ...r, enteredAt: r.enteredAt.toISOString(), who: r.name, how: r.entryMethod === 'door_qr' ? 'door code' : 'desk' })),
        insidePage: { total: now.total, next: now.next },
        count: head.inside,
      }
    },
    sections: (data) => [
      { kind: 'figures', figures: [{ label: 'Inside now', value: String(data.count) }] },
      {
        kind: 'table',
        title: 'Inside',
        rows: 'inside',
        paging: { data: 'insidePage', sorts: ['entered'] },
        empty: 'Nobody is recorded as inside.',
        columns: [
          { key: 'who', label: 'Student' },
          { key: 'enteredAt', label: 'In', kind: 'when' },
          { key: 'how', label: 'How' },
        ],
      },
      {
        kind: 'form',
        title: 'Record an entry',
        note: 'For a student without a phone, or when the door code is not used. Allowed at any hour.',
        submit: 'Enter',
        path: '/sessions/enter',
        fields: [{ name: 'studentId', label: 'Student', hint: 'Their id' }],
      },
      {
        kind: 'form',
        title: 'Record an exit',
        submit: 'Exit',
        path: '/sessions/exit',
        fields: [{ name: 'studentId', label: 'Student', hint: 'Their id' }],
      },
    ],
  },

  {
    path: '/me',
    title: 'My library',
    menu: 'My library',
    roles: ['student', 'faculty'],
    async load(actor) {
      const a = actor as Actor
      const s = await borrowerStatus(a, a.id)
      const visit = a.role === 'student' ? await mySessions(a) : null
      return {
        isStudent: a.role === 'student',
        inside: visit?.inside ?? false,
        visits: (visit?.rows ?? []).map((r) => ({ ...r, enteredAt: r.enteredAt.toISOString(), how: r.entryMethod === 'door_qr' ? 'door code' : 'desk', out: r.exitedAt ? r.exitedAt.toISOString() : null })),
        open: s.open.map(loanRow),
        history: s.history.map(loanRow),
        historyCut: s.historyTotal > s.history.length ? `Showing the 100 most recent of ${s.historyTotal}.` : null,
        openCount: s.openCount,
        max: s.maxConcurrentLoans,
        fines: formatPaise(s.outstandingFinePaise),
        blocked: s.blockedBy,
        renewable: s.open
          .filter((l) => l.daysOverdue === 0)
          .map((l) => ({ value: l.id, label: `${l.title} - due ${l.dueOn.slice(0, 10)}` })),
      }
    },
    sections: (data) => [
      ...(data.isStudent
        ? [
            { kind: 'note' as const, text: data.inside ? 'You are recorded as inside the library. Check out at the door or the desk before it closes.' : 'You are not recorded as inside the library.' },
            {
              kind: 'form' as const,
              title: 'Check in or out',
              note: 'Scan the code on the library door, or type it, and choose in or out.',
              submit: 'Send',
              path: '/door/scan',
              fields: [
                { name: 'code', label: 'Door code' },
                { name: 'direction', label: 'In or out', kind: 'select' as const, options: [{ value: 'in', label: 'in' }, { value: 'out', label: 'out' }] },
              ],
            },
            {
              kind: 'table' as const,
              title: 'Recent visits',
              rows: 'visits',
              empty: 'No visits recorded.',
              columns: [
                { key: 'enteredAt', label: 'In', kind: 'when' as const },
                { key: 'out', label: 'Out', kind: 'when' as const },
                { key: 'how', label: 'How' },
              ],
            },
          ]
        : []),
      {
        kind: 'figures',
        figures: [
          { label: 'Out now', value: `${data.openCount} of ${data.max}` },
          {
            label: 'Fines owed',
            value: String(data.fines),
            tone: data.blocked ? 'due' : 'clear',
          },
        ],
      },
      ...(data.blocked
        ? [
            {
              kind: 'note' as const,
              tone: 'danger' as const,
              text:
                data.blocked === 'loan_limit_reached'
                  ? `You are holding the maximum of ${data.max} books.`
                  : 'You have unpaid fines above the borrowing limit.',
            },
          ]
        : []),
      {
        kind: 'table',
        title: 'Out now',
        rows: 'open',
        empty: 'Nothing out.',
        columns: [
          { key: 'title', label: 'Book' },
          { key: 'dueOn', label: 'Due', kind: 'date' },
          { key: 'daysOverdue', label: 'Late', kind: 'days', alertWhen: 'late' },
          { key: 'owing', label: 'Fine', kind: 'money' },
        ],
      },
      {
        kind: 'form',
        title: 'Renew',
        note:
          'An overdue book cannot be renewed — bring it back and the fine stops ' +
          'there.',
        submit: 'Renew',
        path: '/loans/renew',
        fields: [{ name: 'loanId', label: 'Book', kind: 'select', options: 'renewable' }],
      },
      ...(data.historyCut ? [{ kind: 'note' as const, text: String(data.historyCut) }] : []),
      {
        kind: 'table',
        title: 'Returned',
        rows: 'history',
        empty: 'Nothing returned yet.',
        columns: [
          { key: 'title', label: 'Book' },
          { key: 'dueOn', label: 'Was due', kind: 'date' },
          { key: 'owing', label: 'Fine', kind: 'money' },
          { key: 'settled', label: 'Status' },
        ],
      },
    ],
  },
]
