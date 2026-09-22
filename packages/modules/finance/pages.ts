import { formatPaise } from '@campusos/money'
import { param, type PluginPage } from '@campusos/module-framework'
import {
  budgetReport,
  entryLines,
  listAccounts,
  listEntries,
  listPeriods,
  trialBalance,
  type Actor,
} from './api'

/**
 * Three screens, which is all a college's books need on day one: what accounts
 * exist, what has been posted, and whether the two sides agree.
 *
 * There is no "post a journal entry" form for a human. Almost everything here
 * arrives from fees or payroll, and a free-hand entry form is the fastest way to
 * end up with books nobody can reconcile. The route exists for when an
 * accountant genuinely needs it; the screen deliberately does not.
 */

const OFFICE = ['institution_admin', 'super_admin', 'accounts_staff'] as const
const ADMIN = ['institution_admin', 'super_admin'] as const

export const pages: PluginPage[] = [
  {
    path: '/',
    title: 'Trial balance',
    menu: 'Trial balance',
    roles: [...OFFICE],
    async load(actor) {
      const tb = await trialBalance(actor as Actor, {})
      return {
        rows: tb.rows.map((r) => ({
          ...r,
          debit: r.debitPaise ? formatPaise(r.debitPaise) : '',
          credit: r.creditPaise ? formatPaise(r.creditPaise) : '',
          balance: formatPaise(r.balancePaise),
        })),
        totalDebit: formatPaise(tb.debitPaise),
        totalCredit: formatPaise(tb.creditPaise),
        difference: formatPaise(tb.differencePaise),
        outOfBalance: tb.differencePaise !== 0,
      }
    },
    sections: (data) => [
      {
        kind: 'figures',
        figures: [
          { label: 'Total debits', value: data.totalDebit as string },
          { label: 'Total credits', value: data.totalCredit as string },
          {
            label: 'Difference',
            value: data.difference as string,
            tone: data.outOfBalance ? 'due' : 'clear',
          },
        ],
      },
      ...(data.outOfBalance
        ? [
            {
              kind: 'note' as const,
              tone: 'danger' as const,
              text:
                'The two sides do not agree. Every entry is checked for balance at ' +
                'the moment it is written, so this is a defect in CampusOS rather ' +
                'than in your bookkeeping -- please report it.',
            },
          ]
        : []),
      {
        kind: 'table',
        title: 'Accounts',
        rows: 'rows',
        empty: 'Nothing posted yet.',
        columns: [
          { key: 'code', label: 'Code', kind: 'code' },
          { key: 'name', label: 'Account' },
          { key: 'type', label: 'Type' },
          { key: 'debit', label: 'Debits' },
          { key: 'credit', label: 'Credits' },
          { key: 'balance', label: 'Balance' },
        ],
      },
    ],
  },

  {
    path: '/journal',
    title: 'Journal',
    menu: 'Journal',
    roles: [...OFFICE],
    async load(actor, req) {
      const a = actor as Actor
      const wanted = param(req, 'entryId')
      const [posted, detail] = await Promise.all([
        listEntries(a),
        wanted ? entryLines(a, wanted) : Promise.resolve([]),
      ])
      return {
        entries: posted.map((e) => ({
          ...e,
          occurredAt: e.occurredAt.toISOString(),
          amount: formatPaise(Number(e.totalPaise)),
          reversal: !!e.reversalOf,
        })),
        detail: detail.map((l) => ({
          ...l,
          debit: l.debitPaise ? formatPaise(l.debitPaise) : '',
          credit: l.creditPaise ? formatPaise(l.creditPaise) : '',
        })),
        entryId: wanted ?? '',
      }
    },
    sections: (data) => [
      {
        kind: 'note',
        text:
          'Entries are never edited. A mistake is corrected by posting its ' +
          'reverse, so both the error and the correction stay on the record.',
      },
      {
        kind: 'table',
        title: 'Posted',
        rows: 'entries',
        empty: 'Nothing posted yet.',
        columns: [
          { key: 'occurredAt', label: 'When', kind: 'when' },
          { key: 'memo', label: 'Entry', href: '/m/finance/journal?entryId={id}' },
          { key: 'sourceModule', label: 'From', kind: 'code' },
          { key: 'amount', label: 'Amount' },
          { key: 'reversal', label: 'Reversal', alertWhen: 'reversal' },
        ],
      },
      ...(data.entryId
        ? [
            {
              kind: 'table' as const,
              title: 'Lines',
              rows: 'detail',
              empty: 'No lines.',
              columns: [
                { key: 'code', label: 'Code', kind: 'code' as const },
                { key: 'name', label: 'Account' },
                { key: 'costCenter', label: 'Cost centre' },
                { key: 'debit', label: 'Debit' },
                { key: 'credit', label: 'Credit' },
              ],
            },
          ]
        : []),
    ],
  },

  {
    path: '/accounts',
    title: 'Chart of accounts',
    menu: 'Accounts',
    roles: [...OFFICE],
    async load(actor) {
      const rows = await listAccounts(actor as Actor)
      return {
        accounts: rows.map((a) => ({
          ...a,
          archived: !!a.archivedAt,
          purpose: a.purpose ?? '',
        })),
      }
    },
    sections: () => [
      {
        kind: 'note',
        text:
          'A purpose is what fees and payroll ask for when they post -- they do ' +
          'not know your account numbers. Renumber and rename freely; move a ' +
          'purpose and the postings follow it.',
      },
      {
        kind: 'table',
        title: 'Accounts',
        rows: 'accounts',
        empty: 'No accounts yet.',
        columns: [
          { key: 'code', label: 'Code', kind: 'code' },
          { key: 'name', label: 'Account' },
          { key: 'type', label: 'Type' },
          { key: 'purpose', label: 'Used for', kind: 'code' },
          { key: 'archived', label: 'Closed', alertWhen: 'archived' },
        ],
      },
      {
        kind: 'form',
        title: 'Add an account',
        submit: 'Add',
        path: '/accounts',
        roles: [...ADMIN],
        fields: [
          { name: 'code', label: 'Code' },
          { name: 'name', label: 'Name' },
          {
            name: 'type',
            label: 'Type',
            kind: 'select',
            options: [
              { value: 'asset', label: 'Asset' },
              { value: 'liability', label: 'Liability' },
              { value: 'equity', label: 'Equity' },
              { value: 'income', label: 'Income' },
              { value: 'expense', label: 'Expense' },
            ],
          },
        ],
      },
    ],
  },

  {
    path: '/periods',
    title: 'Periods',
    menu: 'Periods',
    roles: [...ADMIN],
    async load(actor) {
      const rows = await listPeriods(actor as Actor, {})
      const now = new Date()
      return {
        periods: rows.map((p) => ({
          ...p,
          month: `${p.year}-${String(p.month).padStart(2, '0')}`,
          reopened: p.reopenedReason ?? '',
        })),
        thisMonth: `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`,
        closedCount: String(rows.filter((p) => p.status === 'closed').length),
      }
    },
    sections: (data) => [
      {
        kind: 'note',
        text: `A month with no row here is open, so nothing has to be created in advance. Closing one is what stops anything landing in it afterwards -- checked against the date an entry says it happened on, not the date it was typed, because backdating into a closed month is exactly what closing prevents. It is ${String(data.thisMonth)} now.`,
      },
      {
        kind: 'figures',
        figures: [{ label: 'Months closed', value: String(data.closedCount) }],
      },
      {
        kind: 'table',
        rows: 'periods',
        empty: 'Nothing closed yet, so every month is open.',
        columns: [
          { key: 'month', label: 'Month', kind: 'code' },
          { key: 'status', label: 'Status' },
          { key: 'closedAt', label: 'Closed', kind: 'when' },
          { key: 'reopened', label: 'Reopened because', alertWhen: 'reopened' },
        ],
      },
      {
        kind: 'form',
        title: 'Close a month',
        note: 'Refused before the month is over: a period closed while entries for it are still arriving is a period that gets reopened on Monday.',
        submit: 'Close',
        path: '/periods/close',
        fields: [
          { name: 'year', label: 'Year', kind: 'number' },
          { name: 'month', label: 'Month', kind: 'number', hint: '1-12' },
          { name: 'reason', label: 'Note', optional: true },
        ],
      },
      {
        kind: 'form',
        title: 'Open one again',
        note: 'A decision, not an undo. The reason stays on the row, because the close is what everybody downstream relied on.',
        submit: 'Reopen',
        path: '/periods/reopen',
        fields: [
          { name: 'year', label: 'Year', kind: 'number' },
          { name: 'month', label: 'Month', kind: 'number' },
          { name: 'reason', label: 'Reason', hint: 'At least five characters' },
        ],
      },
    ],
  },

  {
    path: '/budgets',
    title: 'Budgets',
    menu: 'Budgets',
    roles: [...ADMIN],
    async load(actor, req) {
      const year = Number(param(req, 'year') ?? new Date().getUTCFullYear())
      const report = await budgetReport(actor as Actor, { year })
      const accounts = await listAccounts(actor as Actor)
      return {
        year: String(year),
        rows: report.rows,
        budgeted: formatPaise(report.budgetedPaise),
        spent: formatPaise(report.spentPaise),
        overspent: String(report.overspentCount),
        accountOptions: accounts
          .filter((a) => !a.archivedAt)
          .map((a) => ({ value: a.code, label: `${a.code} - ${a.name}` })),
      }
    },
    sections: (data) => [
      {
        kind: 'note',
        text: 'Spend is summed from the journal on the cost centre a line carries, so there is no second set of figures to keep in step. Departments reach it through payroll; anything else reaches it by putting a cost centre on the entry.',
      },
      {
        kind: 'figures',
        figures: [
          { label: `Budgeted ${String(data.year)}`, value: String(data.budgeted) },
          { label: 'Spent', value: String(data.spent) },
          {
            label: 'Over budget',
            value: String(data.overspent),
            tone: Number(data.overspent) > 0 ? 'due' : 'clear',
          },
        ],
      },
      {
        kind: 'table',
        rows: 'rows',
        empty: 'Nothing budgeted for this year.',
        columns: [
          { key: 'costCenter', label: 'Cost centre' },
          { key: 'accountCode', label: 'Account', kind: 'code' },
          { key: 'accountName', label: 'Name' },
          { key: 'budgetPaise', label: 'Budget', kind: 'money' },
          { key: 'actualPaise', label: 'Spent', kind: 'money' },
          { key: 'remainingPaise', label: 'Left', kind: 'money', alertWhen: 'overspent' },
          { key: 'hardLimit', label: 'Enforced', kind: 'bool' },
        ],
      },
      {
        kind: 'form',
        title: 'Set a budget',
        note: 'Enforced budgets refuse the entry that would pass them. Left off, an overspend is recorded and reported -- which is usually right, because books that refuse to record what happened are worse than an overspend somebody has to explain.',
        submit: 'Set',
        path: '/budgets',
        fields: [
          { name: 'year', label: 'Year', kind: 'number' },
          { name: 'costCenter', label: 'Cost centre', hint: 'As it appears on the journal line' },
          {
            name: 'accountCode',
            label: 'Account',
            kind: 'select',
            options: 'accountOptions',
          },
          { name: 'amountPaise', label: 'Budget', kind: 'money' },
          { name: 'hardLimit', label: 'Refuse entries past it', kind: 'checkbox', optional: true },
          { name: 'note', label: 'Note', optional: true },
        ],
      },
    ],
  },
]
