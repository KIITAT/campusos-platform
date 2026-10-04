import { and, eq } from 'drizzle-orm'
import { DocStatusError, withTenant } from '@campusos/db'
import type { Role, ViewerScope } from '@campusos/module-framework'
import { UploadError } from '@campusos/module-framework'
import { staff } from '../schema'

/**
 * What every part of the books shares: who is asking, what they may do, and
 * how a refusal from the database becomes a sentence.
 */

export interface Actor extends ViewerScope {
  id: string
  email?: string | null
  role: Role
  institutionId: string | null
}

export class FinanceError extends Error {
  constructor(
    readonly status: 400 | 403 | 404 | 409,
    readonly code: string,
    message: string,
    readonly detail?: Record<string, unknown>,
  ) {
    super(message)
  }
}

export type Tx = Parameters<Parameters<typeof withTenant>[1]>[0]

export function tenantOf(actor: Actor): string {
  if (!actor.institutionId) {
    throw new FinanceError(400, 'no_institution', 'no institution for this session')
  }
  return actor.institutionId
}

// --- who may do what ---------------------------------------------------------------
//
// Three rights, from widest to narrowest:
//
//   read      the accounts office and the administration see the books;
//   operate   the accounts office writes and submits the day's documents --
//             invoices, payments, vouchers, receipts, stock entries -- which is
//             its job, and was impossible while only an administrator could post;
//   configure the institution decides its chart, its taxes, its fiscal year and
//             when a period or year is closed. That stays with an administrator.
//
// Free-hand posting of a raw entry (postEntry) remains an administrator's act:
// an accountant's free-hand entry is a journal voucher, which is a document,
// numbered and cancellable, rather than a row nobody can trace.
//
// Beyond roles, the accounts office names members of staff for three jobs --
// storekeeper, purchaser, approver -- the way placement names its officers. A
// lab assistant who keeps the chemistry store is faculty or staff by role and a
// storekeeper by appointment.

const OFFICE: Role[] = ['institution_admin', 'super_admin', 'accounts_staff']
const ADMIN: Role[] = ['institution_admin', 'super_admin']
/** Anybody who works here: who may ask the stores for something. */
const STAFF: Role[] = [
  'institution_admin',
  'super_admin',
  'hod',
  'faculty',
  'accounts_staff',
  'library_staff',
  'hostel_staff',
]

export const canRead = (r: Role) => OFFICE.includes(r)
export const canOperate = (r: Role) => OFFICE.includes(r)
export const canConfigure = (r: Role) => ADMIN.includes(r)
export const isStaff = (r: Role) => STAFF.includes(r)

export function requireRead(actor: Actor): string {
  const tenant = tenantOf(actor)
  if (!canRead(actor.role)) throw new FinanceError(403, 'forbidden', 'not permitted')
  return tenant
}

export function requireOperate(actor: Actor): string {
  const tenant = tenantOf(actor)
  if (!canOperate(actor.role)) throw new FinanceError(403, 'forbidden', 'not permitted')
  return tenant
}

export function requireConfigure(actor: Actor): string {
  const tenant = tenantOf(actor)
  if (!canConfigure(actor.role)) {
    throw new FinanceError(403, 'forbidden', 'only an administrator changes how the books are kept')
  }
  return tenant
}

export function requireStaff(actor: Actor): string {
  const tenant = tenantOf(actor)
  if (!isStaff(actor.role)) throw new FinanceError(403, 'forbidden', 'not permitted')
  return tenant
}

/** A row without some of its columns: a copy for a new draft, a report without its ids. */
export function without<T extends object, K extends keyof T>(row: T, ...keys: K[]): Omit<T, K> {
  const out = { ...row }
  for (const k of keys) delete out[k]
  return out
}

export type Capability = 'storekeeper' | 'purchaser' | 'approver'

/** Whether the accounts office has given this person that job (or they run the office). */
export async function hasCapability(
  tx: Tx,
  actor: Actor,
  capability: Capability,
  warehouseId?: string | null,
): Promise<boolean> {
  if (canOperate(actor.role)) return true
  if (!isStaff(actor.role)) return false
  const rows = await tx
    .select({ warehouseId: staff.warehouseId })
    .from(staff)
    .where(and(eq(staff.userId, actor.id), eq(staff.capability, capability)))
  return rows.some((r) => !r.warehouseId || !warehouseId || r.warehouseId === warehouseId)
}

export async function requireCapability(
  tx: Tx,
  actor: Actor,
  capability: Capability,
  warehouseId?: string | null,
): Promise<void> {
  if (!(await hasCapability(tx, actor, capability, warehouseId))) {
    const job = { storekeeper: 'a storekeeper', purchaser: 'the purchase office', approver: 'an approver' }[capability]
    throw new FinanceError(403, 'forbidden', `that is for ${job}`)
  }
}

// --- refusals ----------------------------------------------------------------------

/**
 * The database's refusals, named. Every rule in the migrations raises with a
 * constraint name; this turns the name into the sentence a person reads and
 * the status a client acts on (decision 110).
 */
const REFUSALS: Record<string, [400 | 403 | 404 | 409, string]> = {
  finance_period_closed: [409, 'that accounting period is closed'],
  finance_fiscal_year_closed: [409, 'that fiscal year is closed'],
  finance_lines_with_entry: [409, 'a line is written with its entry'],
  finance_lines_group_account: [400, 'a group of accounts takes no postings; choose one of its accounts'],
  finance_lines_account_currency: [400, 'that account is kept in another currency'],
  finance_accounts_parent_group: [400, 'an account sits under a group'],
  finance_accounts_parent_type: [400, 'an account sits under a group of its own type'],
  finance_accounts_loop: [400, 'an account cannot sit under itself'],
  finance_accounts_depth: [400, 'the chart is twelve levels deep at most'],
  finance_accounts_has_postings: [409, 'that account has postings; its type, currency and kind stay as they are'],
  finance_accounts_has_children: [409, 'that group has accounts under it'],
  finance_accounts_group_purpose: [400, 'a group cannot serve a purpose; give it to one of its accounts'],
  finance_accounts_code: [409, 'that code is already in the chart'],
  finance_accounts_purpose: [409, 'another account already serves that purpose'],
  finance_cost_centers_code: [409, 'that cost centre code is taken'],
  finance_cost_centers_loop: [400, 'a cost centre cannot sit under itself'],
  finance_funds_code: [409, 'that fund code is taken'],
  finance_fiscal_years_no_overlap: [409, 'that fiscal year overlaps another'],
  finance_fiscal_years_label: [409, 'there is already a fiscal year by that name'],
  finance_exchange_rates_day: [409, 'a rate for that currency on that day is already entered'],
  finance_approvals_reason: [400, 'say why it is refused'],
  finance_parties_code: [409, 'that party code is taken'],
  finance_parties_gstin: [400, 'that is not a GSTIN'],
  finance_parties_pan: [400, 'that is not a PAN'],
  finance_parties_ifsc: [400, 'that is not an IFSC'],
  finance_parties_registered: [400, 'a registered party has a GSTIN'],
  finance_parties_role: [400, 'a party is a customer, a supplier, or both'],
  finance_settings_gstin: [400, 'that is not a GSTIN'],
  finance_settings_pan: [400, 'that is not a PAN'],
  finance_tax_templates_name: [409, 'there is already a tax by that name'],
  finance_tds_sections_code: [409, 'there is already a TDS section with that code'],
  finance_lines_of_draft: [409, 'the lines of a submitted document are fixed'],
  finance_invoice_empty: [400, 'an invoice needs at least one line'],
  finance_invoice_totals: [409, 'the invoice totals do not agree with its lines'],
  finance_invoices_bill: [409, 'that supplier bill is already entered'],
  finance_invoices_source: [409, 'that is already invoiced'],
  finance_payment_overallocated: [409, 'a payment settles no more than it brought'],
  finance_party_ledger_oversettled: [
    409,
    'that would settle more than the invoice is for -- cancel the payments and credit notes against it first',
  ],
  finance_bank_statements_file: [409, 'that statement has already been imported'],
  finance_bank_statement_lines_matched: [409, 'that posting is already matched to a statement line'],
  finance_bank_match_account: [400, 'match a statement line to a posting on that bank account'],
  finance_bank_match_amount: [400, 'match a statement line to a posting of the same amount, the same way'],
  finance_bank_statement_matched: [409, 'a statement with matched lines is kept'],
  finance_bank_accounts_account: [409, 'that account already stands for a bank account'],
  finance_items_code: [409, 'that item code is taken'],
  finance_items_asset: [400, 'an asset item is not a stock item and names its asset category'],
  finance_items_tracking: [400, 'only a stock item is kept by batch or serial number'],
  finance_items_uom_fk: [400, 'no such unit of measure'],
  finance_warehouses_code: [409, 'that store code is taken'],
  finance_batches_no: [409, 'that batch number is taken for that item'],
  finance_stock_not_stock: [400, 'only a stock item moves through the stores'],
  finance_stock_batch_required: [400, 'that item is kept by batch; say which'],
  finance_stock_serials_required: [400, 'that item is kept by serial number; list one for each unit'],
  finance_stock_in_order: [409, 'stock is posted in date order; that item has moved in that store since'],
  finance_stock_running_balance: [409, 'the stock moved while this was being posted; try again'],
  finance_stock_negative: [409, 'there is not that much of it in that store'],
  finance_stock_value_without_qty: [409, 'an empty store holds no value'],
  finance_batch_bins_qty: [409, 'there is not that much of that batch in that store'],
  finance_stock_serial_in_stock: [409, 'a serial number coming in is already in stock'],
  finance_stock_serial_missing: [409, 'a serial number going out is not in that store'],
  finance_stock_batch_item: [400, 'that batch is of another item'],
  finance_stock_bins_by_ledger: [409, 'stock balances move only with the stock ledger'],
  finance_receipt_over_order: [409, 'that is more than was ordered'],
  finance_receipt_empty: [400, 'a receipt needs at least one line'],
  finance_invoice_over_receipt: [409, 'that bills more than was received'],
  finance_invoice_over_order: [409, 'that bills more than was ordered'],
  finance_order_closures_reason: [400, 'say why the order is closed'],
  finance_asset_categories_basis: [400, 'straight line needs a life in months; written down value needs a rate'],
  finance_asset_categories_name: [409, 'there is already a category by that name'],
  finance_assets_tag: [409, 'that tag is on another asset'],
  finance_assets_opening: [400, 'depreciation already charged cannot exceed the cost'],
  finance_assets_dates: [400, 'an asset is in use on or after the day it was bought'],
  finance_depreciation_posted: [409, 'posted depreciation is kept as it was posted'],
  finance_asset_event_not_capitalised: [409, 'only an asset in the books has a history'],
  finance_asset_disposed: [409, 'that asset has been disposed of'],
  finance_asset_cancel_used: [409, 'an asset that has depreciated or has a history is disposed of, not cancelled'],
  finance_invoice_unposted: [409, 'an invoice is numbered and posted as it is submitted'],
  finance_payment_unposted: [409, 'a payment is numbered and posted as it is submitted'],
  finance_receipt_unnumbered: [409, 'a receipt is numbered as it is submitted'],
  finance_payments_side: [400, 'a payment to or from a party says whose account it moves'],
  finance_depreciation_rewritten: [409, 'a depreciation row is posted, or dropped, never rewritten'],
  docstatus_locked: [409, 'a submitted document cannot be changed, only cancelled'],
  docstatus_final: [409, 'a cancelled document is final; amend it into a new draft'],
  docstatus_cancel_reason: [400, 'cancelling needs a reason'],
  docstatus_draft_cancel: [409, 'a draft is deleted, not cancelled'],
}

/**
 * Run `fn`, turning a refusal the database names, an upload refused, or a
 * lifecycle move refused into a FinanceError. Anything else is a defect and is
 * thrown as it is.
 */
export async function named<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn()
  } catch (e) {
    throw refusal(e)
  }
}

export function refusal(e: unknown): unknown {
  if (e instanceof FinanceError) return e
  if (e instanceof DocStatusError) return new FinanceError(e.status, e.code, e.message)
  if (e instanceof UploadError) return new FinanceError(400, e.code, e.message)
  const cause = (e as { cause?: { constraint?: string; code?: string } }).cause
  const constraint = cause?.constraint ?? (e as { constraint?: string }).constraint
  const known = constraint ? REFUSALS[constraint] : undefined
  if (known) return new FinanceError(known[0], constraint!, known[1])
  // finance_kept() names its refusal after the table: <table>_kept.
  if (constraint?.endsWith('_kept')) return new FinanceError(409, constraint, 'that record is kept as it was written')
  // An unnamed foreign key refusal: the thing pointed at does not exist here.
  if (cause?.code === '23503' || (e as { code?: string }).code === '23503') {
    return new FinanceError(400, 'no_such_reference', 'something it names does not exist, or is in use')
  }
  return e
}

/** A uuid from a form or query, or a 400. */
export function uuidOf(value: unknown, what: string): string {
  if (typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) {
    return value
  }
  throw new FinanceError(400, 'bad_id', `${what} is missing or not an id`)
}
