import type { PluginPage } from '@campusos/module-framework'
import { withTenant } from '@campusos/db'
import { eq } from 'drizzle-orm'
import { formatPaise } from '@campusos/money'
import { FinanceError, requireRead } from '../api'
import { bankStatementLines } from '../schema'
import { ADMIN, as, OFFICE } from './kit'
import { chooseRecord, col, context, dateFields, display, field, filter, form, hidden, href, linkCol, moneyCols, object, page, read, rows, select, shortcuts, str, table, tabs, textFields } from './screen-kit'

const lineColumns = [col('txnDate', 'date'), linkCol('description', '/bank-line'), col('reference'), ...moneyCols('withdrawalPaise', 'depositPaise', 'balancePaise'), col('status', 'status')]

export const bankPages: PluginPage[] = [
  page({ path: '/bank', title: 'Bank accounts', menu: 'Money', roles: OFFICE,
    async load(actor, request) { return { ...await context(actor, request), rows: rows(await read(actor, '/bank-accounts')) } },
    sections: () => [table('Bank accounts', 'rows', [linkCol('bankName', '/bank-account'), col('branch'), col('accountNumber'), col('ifsc'), col('currency'), col('code'), col('name'), ...moneyCols('booksPaise'), col('unmatched', undefined, { alertWhen: 'unmatched' }), col('lastStatement', 'date')]), form('Add bank account', '/bank-accounts', [...textFields('bankName', 'branch', 'ifsc', 'accountNumber'), select('currency', 'currencies'), select('accountId', 'accounts', { hint: 'Leave blank to create the bank account in the chart.' })], {}, ADMIN)],
  }),
  page({ path: '/bank-account', title: 'Bank statement', roles: OFFICE,
    async load(actor, request) {
      const data = await context(actor, request); const query = object(data.query)
      if (!query.id) return { ...data, document: {} }
      const account = rows(await read(actor, '/bank-accounts')).find(row => row.id === query.id)
      if (!account) throw new FinanceError(404, 'no_such_bank_account', 'No such bank account.')
      const statements = rows(await read(actor, '/bank-statements', { bankAccountId: query.id })).map(row => display(row, data))
      return { ...data, document: account, statements, statementOptions: statements.map(row => ({ value: str(row.id), label: str(row.fileName) })), lines: rows(await read(actor, '/bank-lines', { bankAccountId: query.id, status: query.status || 'unmatched', statementId: query.statementId })), query: { status: 'unmatched', ...query } }
    },
    record: data => { const document = object(data.document); return document.id ? { title: str(document.bankName), subtitle: str(document.accountNumber), fields: [{ label: 'Book balance', value: document.booksPaise, kind: 'money' }], audit: { entity: 'finance_bank_account', entityId: str(document.id) } } : null },
    sections: data => {
      const document = object(data.document)
      if (!document.id) return [chooseRecord]
      return [form('Import statement', '/bank-statements/import', [hidden('bankAccountId', document.id), field('file', 'file', { optional: false, accept: '.csv,.xlsx,.sta,.mt940,.xml' })]),
        form('Save column mapping', '/bank-accounts/mapping', [hidden('bankAccountId', document.id), ...textFields('date', 'valueDate', 'description', 'reference', 'withdrawal', 'deposit', 'amount', 'drCr', 'balance'), select('dateOrder', ['dmy', 'mdy', 'ymd'])], object(document.csvMapping)),
        table('Statements', 'statements', [col('fileName'), col('format'), col('fromDate', 'date'), col('toDate', 'date'), ...moneyCols('openingPaise', 'closingPaise'), col('lineCount'), col('importedAt', 'when')]),
        form('Delete statement', '/bank-statements/delete', [select('statementId', 'statementOptions', { optional: false })]),
        tabs('/bank-account', { ...object(data.query), id: document.id }, 'status', ['unmatched', 'matched', 'ignored']), filter('/bank-account', data, [hidden('id', document.id), select('status', ['unmatched', 'matched', 'ignored']), select('statementId', 'statementOptions')]), table('Statement lines', 'lines', lineColumns),
        form('Auto-match', '/bank/auto-match', [hidden('bankAccountId', document.id)]), form('Apply bank rules', '/bank-rules/apply', [hidden('bankAccountId', document.id)]), shortcuts('Reports', [{ label: 'Bank reconciliation', href: href('/bank/reconciliation', { bankAccountId: document.id, on: data.on }) }]),
      ]
    },
  }),
  page({ path: '/bank-line', title: 'Match statement line', roles: OFFICE,
    async load(actor, request) {
      const data = await context(actor, request); const id = str(object(data.query).id)
      if (!id) return { ...data, document: {} }
      const [line] = await withTenant(requireRead(as(actor)), transaction => transaction.select().from(bankStatementLines).where(eq(bankStatementLines.id, id)))
      if (!line) throw new FinanceError(404, 'no_such_line', 'No such bank statement line.')
      const candidates = rows(await read(actor, '/bank-lines/candidates', { lineId: id }))
      return { ...data, document: line, line: [line], candidates, candidateOptions: candidates.map(candidate => ({ value: str(candidate.id), label: `${candidate.postingDate} · ${candidate.memo} · ${candidate.days} days apart` })) }
    },
    sections: data => {
      const document = object(data.document)
      if (!document.id) return [chooseRecord]
      return [{ kind: 'note', text: 'One statement line matches exactly one ledger line. A deposit slip covering several receipts needs a contra or a split posting.' }, table('Statement line', 'line', lineColumns), table('Matching candidates', 'candidates', [col('postingDate', 'date'), col('memo'), col('lineMemo'), col('sourceRef'), ...moneyCols('debitPaise', 'creditPaise'), col('days', 'days')]),
        ...(document.status === 'matched' ? [form('Unmatch', '/bank-lines/unmatch', [hidden('lineId', document.id)])] : [form('Match selected posting', '/bank-lines/match', [hidden('lineId', document.id), select('glLineId', 'candidateOptions', { optional: false })]), form('Post and match', '/bank-lines/post', [hidden('lineId', document.id), select('accountId', 'accounts', { optional: false }), select('costCenter', 'costCenters'), field('memo', 'textarea')]), form('Set aside', '/bank-lines/ignore', [hidden('lineId', document.id), field('note', 'textarea', { optional: false })])]),
      ]
    },
  }),
  page({ path: '/bank-rules', title: 'Bank rules', menu: 'Money', roles: OFFICE,
    async load(actor, request) { const data = await context(actor, request); const rules = rows(await read(actor, '/bank-rules')); return { ...data, rows: rules, ruleOptions: rules.map(row => ({ value: str(row.id), label: `${row.contains} · ${row.direction}` })), bankOptions: rows(await read(actor, '/bank-accounts')).map(row => ({ value: str(row.id), label: `${row.bankName} ${row.accountNumber}` })) } },
    sections: () => [table('Rules', 'rows', [col('contains'), col('direction'), col('accountCode'), col('accountName'), col('costCenter'), col('priority'), col('bankAccountId')]), form('Add bank rule', '/bank-rules', [select('bankAccountId', 'bankOptions'), field('contains', 'text', { optional: false }), select('direction', ['in', 'out', 'any'], { value: 'any' }), select('accountId', 'accounts', { optional: false }), select('costCenter', 'costCenters'), field('priority', 'number', { value: '100' })]), form('Delete bank rule', '/bank-rules/delete', [select('ruleId', 'ruleOptions', { optional: false })])],
  }),
  page({ path: '/bank/reconciliation', title: 'Bank reconciliation', roles: OFFICE,
    async load(actor, request) { const data = await context(actor, request); const query = object(data.query); return { ...data, bankOptions: rows(await read(actor, '/bank-accounts')).map(row => ({ value: str(row.id), label: `${row.bankName} ${row.accountNumber}` })), report: query.bankAccountId ? await read(actor, '/bank/reconciliation', { bankAccountId: query.bankAccountId, on: data.on }) : null } },
    sections: data => {
      const report = object(data.report)
      return [filter('/bank/reconciliation', data, [select('bankAccountId', 'bankOptions', { optional: false }), ...dateFields('on')]), ...(data.report ? [{ kind: 'figures' as const, figures: ['booksPaise', 'expectedBankPaise', 'statementPaise', 'differencePaise'].map(key => ({ label: field(key.replace('Paise', '')).label, value: report[key] === null ? 'No statement balance' : formatPaise(Number(report[key] ?? 0)), ...(key === 'differencePaise' && report[key] ? { tone: 'due' as const } : {}) })) }, ...['notPresented', 'notCredited', 'bankOnly'].map(key => table(field(key).label, key, key === 'bankOnly' ? lineColumns : [col('postingDate', 'date'), col('memo'), ...moneyCols('debitPaise', 'creditPaise')]))] : [chooseRecord])]
    },
  }),
]

const reconciliationPage = bankPages.find(candidate => candidate.path === '/bank/reconciliation')!
const loadReconciliation = reconciliationPage.load
reconciliationPage.load = async (actor, request) => { const data = await loadReconciliation(actor, request); return { ...data, ...object(data.report) } }
