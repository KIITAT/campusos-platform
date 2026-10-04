import { resolve } from 'node:path'
import { authDb, corePool, institutionModules, institutions, users } from '../packages/db/src/index'
import { balanceSheet, createItem, createParty, incomeAndExpenditure, invoiceDetail, listAccounts, listEntries, saveInvoice, saveJournal, savePayment, trialBalance, updateSettings, type Actor } from '../packages/modules/finance/api/index'

export const CONFIRMATION = 'CREATE_SYNTHETIC_FINANCE_DEMO'
export const DEMO_SLUG = 'campusos-finance-demo-v1'
export const POSTING_DATE = '2026-10-05'

class DemoSafetyError extends Error {}

export function validateDemoEnvironment(environment: Record<string, string | undefined>): string {
  if (environment.NODE_ENV === 'production') throw new DemoSafetyError('Never run the finance demo in production mode.')
  if (environment.CONFIRM_FINANCE_DEMO !== CONFIRMATION) throw new DemoSafetyError(`Set CONFIRM_FINANCE_DEMO=${CONFIRMATION} explicitly.`)
  if (environment.AUTH_DATABASE_URL) throw new DemoSafetyError('Unset AUTH_DATABASE_URL; demo provisioning uses the explicit migration connection.')
  let application: URL
  let migration: URL
  try {
    application = new URL(environment.DATABASE_URL ?? '')
    migration = new URL(environment.MIGRATION_DATABASE_URL ?? '')
  } catch {
    throw new DemoSafetyError('Both application and migration PostgreSQL URLs are required.')
  }
  if (![application, migration].every(url => ['postgres:', 'postgresql:'].includes(url.protocol))) throw new DemoSafetyError('Only PostgreSQL connection URLs are accepted.')
  if (![application, migration].every(url => url.hostname && url.username && !url.hash && [...url.searchParams.keys()].every(key => key === 'sslmode'))) throw new DemoSafetyError('Name explicit database hosts and roles; only the sslmode URL option is supported.')
  let database: string
  let migrationDatabase: string
  try {
    database = decodeURIComponent(application.pathname.slice(1))
    migrationDatabase = decodeURIComponent(migration.pathname.slice(1))
  } catch {
    throw new DemoSafetyError('Invalid database name.')
  }
  if (!/^[a-z][a-z0-9_]*(?:_demo|_test)$/.test(database)) throw new DemoSafetyError('The database must be explicitly disposable and end in _demo or _test.')
  if (database !== migrationDatabase || application.hostname !== migration.hostname || (application.port || '5432') !== (migration.port || '5432')) throw new DemoSafetyError('Application and migration connections must target the same disposable database.')
  return database
}

export interface DemoTenant {
  institutionId: string
  admin: Actor
  accounts: Actor
}

export async function createDemoTenant(): Promise<DemoTenant> {
  return authDb.transaction(async transaction => {
    const [institution] = await transaction.insert(institutions).values({ slug: DEMO_SLUG, name: 'CampusOS Finance Demo — Synthetic', allowedEmailDomains: [] }).onConflictDoNothing().returning()
    if (!institution) throw new DemoSafetyError('The demo institution already exists; no existing records were changed.')
    const identities = await transaction.insert(users).values([
      { institutionId: institution.id, email: `administrator@${DEMO_SLUG}.invalid`, name: 'Synthetic Demo Administrator', role: 'institution_admin' as const },
      { institutionId: institution.id, email: `accounts@${DEMO_SLUG}.invalid`, name: 'Synthetic Demo Accountant', role: 'accounts_staff' as const },
    ]).onConflictDoNothing().returning()
    if (identities.length !== 2) throw new DemoSafetyError('A synthetic user collision was found; demo provisioning was rolled back.')
    await transaction.insert(institutionModules).values({ institutionId: institution.id, moduleId: 'finance', enabled: true, enabledAt: new Date() })
    const actor = (role: 'institution_admin' | 'accounts_staff'): Actor => {
      const user = identities.find(identity => identity.role === role)!
      return { id: user.id, email: user.email, institutionId: institution.id, role }
    }
    return { institutionId: institution.id, admin: actor('institution_admin'), accounts: actor('accounts_staff') }
  })
}

export async function populateDemoBooks(tenant: DemoTenant) {
  if ((await listEntries(tenant.accounts)).length) throw new DemoSafetyError('Demo books already contain postings; refusing duplicate financial effects.')
  await updateSettings(tenant.admin, { legalName: 'CampusOS Finance Demo — Synthetic', baseCurrency: 'INR', fiscalYearStartMonth: 4, timeZone: 'Asia/Kolkata', roundInvoices: true })
  const chart = await listAccounts(tenant.admin)
  const bank = chart.find(account => account.purpose === 'bank')!
  const expense = chart.find(account => account.purpose === 'purchase_expense')!
  const customer = await createParty(tenant.accounts, { code: 'DEMO-CUSTOMER', name: 'Synthetic Workshop Customer', isCustomer: true })
  const service = await createItem(tenant.accounts, { code: 'DEMO-WORKSHOP', name: 'Synthetic workshop service', nature: 'service' })
  const invoice = await saveInvoice(tenant.accounts, {
    kind: 'sales', partyId: customer.id, postingDate: POSTING_DATE,
    lines: [{ itemId: service.id, qty: '2', rate: '10000' }], submit: true,
  }) as { id: string }
  const payment = await savePayment(tenant.accounts, {
    kind: 'receive', partyId: customer.id, postingDate: POSTING_DATE, accountId: bank.id,
    amount: '20000', allocations: [{ invoiceId: invoice.id, amount: '20000' }], submit: true,
  }) as { id: string }
  const journal = await saveJournal(tenant.accounts, {
    kind: 'journal', postingDate: POSTING_DATE, memo: 'Synthetic workshop supplies paid from bank', reference: 'FINANCE-DEMO-V1',
    lines: [{ accountId: expense.id, debit: '5000' }, { accountId: bank.id, credit: '5000' }], submit: true,
  }) as { id: string }
  const [detail, trial, income, balance] = await Promise.all([
    invoiceDetail(tenant.accounts, invoice.id), trialBalance(tenant.accounts, { from: POSTING_DATE, to: POSTING_DATE }),
    incomeAndExpenditure(tenant.accounts, { from: POSTING_DATE, to: POSTING_DATE }), balanceSheet(tenant.accounts, { on: POSTING_DATE }),
  ])
  return {
    institutionId: tenant.institutionId, slug: DEMO_SLUG, postingDate: POSTING_DATE,
    invoiceId: invoice.id, paymentId: payment.id, journalId: journal.id,
    invoiceStatus: detail.status, invoicePaise: detail.invoice.totalFc, outstandingPaise: detail.outstanding.fc,
    bankPaise: trial.rows.find(account => account.code === bank.code)!.balancePaise,
    surplusPaise: income.surplusPaise, trialBalanceDifferencePaise: trial.differencePaise, balanceSheetDifferencePaise: balance.differencePaise,
    pages: ['/m/finance', `/m/finance/invoice?id=${invoice.id}`, `/m/finance/payment?id=${payment.id}`, `/m/finance/reports/trial-balance?from=${POSTING_DATE}&to=${POSTING_DATE}`, `/m/finance/reports/balance-sheet?on=${POSTING_DATE}`],
  }
}

async function main() {
  try {
    const database = validateDemoEnvironment(process.env)
    const result = await populateDemoBooks(await createDemoTenant())
    process.stdout.write(`${JSON.stringify({ database, ...result }, null, 2)}\n`)
  } catch (error) {
    process.stderr.write(`${error instanceof DemoSafetyError ? error.message : 'Finance demo failed. A partial new demo tenant may remain; inspect the disposable database. Reruns never overwrite an existing tenant.'}\n`)
    process.exitCode = 1
  } finally {
    await Promise.all([corePool.end(), authDb.$client.end()])
  }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve('scripts/demo-finance.ts')) void main()
