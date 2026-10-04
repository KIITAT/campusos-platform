import type { AccountSubtype } from '../schema'

/**
 * The chart an institution gets if it never builds its own.
 *
 * A tree now: five groups at the top -- assets, liabilities, funds, income,
 * expenditure -- with the current and fixed halves of assets and the current
 * liabilities beneath, because a balance sheet is read in that shape and an
 * auditor expects to find it. Codes follow the convention almost every Indian
 * college's auditor already uses -- 1000s assets, 2000s liabilities, 3000s
 * funds, 4000s income, 5000s expenditure -- and the original fourteen keep the
 * numbers they always had, so nothing posted before moves.
 *
 * Every ledger account carries a purpose, because the point of the default
 * chart is that posting works on day one without anybody opening the accounts
 * screen. Groups carry none: nothing posts to a group.
 */

type Type = 'asset' | 'liability' | 'equity' | 'income' | 'expense'

export interface ChartRow {
  code: string
  name: string
  type: Type
  purpose?: string
  subtype?: AccountSubtype
  group?: true
  parent?: string
  cashFlow?: 'operating' | 'investing' | 'financing'
}

export const DEFAULT_CHART: readonly ChartRow[] = [
  { code: '1', name: 'Assets', type: 'asset', group: true },
  { code: '11', name: 'Current assets', type: 'asset', group: true, parent: '1' },
  { code: '12', name: 'Fixed assets', type: 'asset', group: true, parent: '1' },
  { code: '2', name: 'Liabilities', type: 'liability', group: true },
  { code: '21', name: 'Current liabilities', type: 'liability', group: true, parent: '2' },
  { code: '3', name: 'Funds', type: 'equity', group: true },
  { code: '4', name: 'Income', type: 'income', group: true },
  { code: '5', name: 'Expenditure', type: 'expense', group: true },

  { code: '1000', name: 'Cash in hand', type: 'asset', purpose: 'cash', subtype: 'cash', parent: '11' },
  { code: '1010', name: 'Bank account', type: 'asset', purpose: 'bank', subtype: 'bank', parent: '11' },
  { code: '1100', name: 'Fees receivable', type: 'asset', purpose: 'fees_receivable', subtype: 'receivable', parent: '11' },
  { code: '1150', name: 'Trade receivables', type: 'asset', purpose: 'accounts_receivable', subtype: 'receivable', parent: '11' },
  { code: '1200', name: 'Advances to staff', type: 'asset', purpose: 'employee_advances', subtype: 'advance', parent: '11' },
  { code: '1300', name: 'Stock in hand', type: 'asset', purpose: 'stock_in_hand', subtype: 'stock', parent: '11' },
  { code: '1400', name: 'GST input credit', type: 'asset', purpose: 'gst_input', subtype: 'tax', parent: '11' },
  { code: '1410', name: 'Tax deducted by others (TDS receivable)', type: 'asset', purpose: 'tds_receivable', subtype: 'tax', parent: '11' },
  { code: '1500', name: 'Fixed assets', type: 'asset', purpose: 'fixed_assets', subtype: 'fixed_asset', parent: '12', cashFlow: 'investing' },
  { code: '1550', name: 'Accumulated depreciation', type: 'asset', purpose: 'accumulated_depreciation', subtype: 'accumulated_depreciation', parent: '12', cashFlow: 'investing' },
  { code: '1590', name: 'Capital work in progress', type: 'asset', purpose: 'capital_wip', subtype: 'capital_wip', parent: '12', cashFlow: 'investing' },

  { code: '2000', name: 'Trade payables', type: 'liability', purpose: 'accounts_payable', subtype: 'payable', parent: '21' },
  { code: '2050', name: 'Goods received, not yet billed', type: 'liability', purpose: 'stock_received_not_billed', subtype: 'stock_received_not_billed', parent: '21' },
  { code: '2100', name: 'Salaries payable', type: 'liability', purpose: 'salaries_payable', subtype: 'current_liability', parent: '21' },
  { code: '2200', name: 'Statutory withholdings payable', type: 'liability', purpose: 'withholdings_payable', subtype: 'tax', parent: '21' },
  { code: '2300', name: 'Expense claims payable', type: 'liability', purpose: 'expense_claims_payable', subtype: 'current_liability', parent: '21' },
  { code: '2400', name: 'GST payable', type: 'liability', purpose: 'gst_output', subtype: 'tax', parent: '21' },
  { code: '2410', name: 'TDS payable', type: 'liability', purpose: 'tds_payable', subtype: 'tax', parent: '21' },

  { code: '3100', name: 'Retained surplus', type: 'equity', purpose: 'retained_surplus', subtype: 'retained_surplus', parent: '3', cashFlow: 'financing' },
  { code: '3900', name: 'Opening balance difference', type: 'equity', purpose: 'opening_balance', subtype: 'temporary', parent: '3', cashFlow: 'financing' },

  { code: '4000', name: 'Tuition and fees', type: 'income', purpose: 'fee_income', subtype: 'income', parent: '4' },
  { code: '4100', name: 'Fines and charges', type: 'income', purpose: 'fine_income', subtype: 'income', parent: '4' },
  { code: '4200', name: 'Sales and services', type: 'income', purpose: 'sales_income', subtype: 'income', parent: '4' },
  { code: '4300', name: 'Other income', type: 'income', purpose: 'other_income', subtype: 'income', parent: '4' },
  { code: '4900', name: 'Exchange gain or loss', type: 'income', purpose: 'exchange_gain_loss', subtype: 'exchange_gain_loss', parent: '4' },

  { code: '5000', name: 'Fee waivers and concessions', type: 'expense', purpose: 'fee_waiver', subtype: 'expense', parent: '5' },
  { code: '5100', name: 'Salaries and wages', type: 'expense', purpose: 'salaries_expense', subtype: 'expense', parent: '5' },
  { code: '5110', name: 'Employer contributions', type: 'expense', purpose: 'employer_cost', subtype: 'expense', parent: '5' },
  { code: '5200', name: 'Scholarships awarded', type: 'expense', purpose: 'scholarship_expense', subtype: 'expense', parent: '5' },
  { code: '5300', name: 'Staff expenses reimbursed', type: 'expense', purpose: 'staff_expenses', subtype: 'expense', parent: '5' },
  { code: '5400', name: 'Purchases and consumption', type: 'expense', purpose: 'purchase_expense', subtype: 'expense', parent: '5' },
  { code: '5410', name: 'Cost of goods sold', type: 'expense', purpose: 'cost_of_goods', subtype: 'cost_of_goods', parent: '5' },
  { code: '5420', name: 'Stock adjustments', type: 'expense', purpose: 'stock_adjustment', subtype: 'stock_adjustment', parent: '5' },
  { code: '5500', name: 'Depreciation', type: 'expense', purpose: 'depreciation_expense', subtype: 'depreciation', parent: '5' },
  { code: '5510', name: 'Loss or gain on disposal of assets', type: 'expense', purpose: 'asset_disposal', subtype: 'expense', parent: '5', cashFlow: 'investing' },
  { code: '5600', name: 'Bank charges', type: 'expense', purpose: 'bank_charges', subtype: 'expense', parent: '5' },
  { code: '5900', name: 'Rounding off', type: 'expense', purpose: 'round_off', subtype: 'round_off', parent: '5' },
]

/** Which side of an account a positive balance sits on. */
export const normalSide = (type: string): 'debit' | 'credit' =>
  type === 'asset' || type === 'expense' ? 'debit' : 'credit'

/** Where a movement against an account of this kind sits in a cash flow statement. */
export function cashFlowOf(
  subtype: string | null,
  type: string,
  declared?: string | null,
): 'operating' | 'investing' | 'financing' {
  if (declared === 'operating' || declared === 'investing' || declared === 'financing') return declared
  if (
    subtype === 'fixed_asset' ||
    subtype === 'capital_wip' ||
    subtype === 'accumulated_depreciation' ||
    subtype === 'investment'
  ) {
    return 'investing'
  }
  if (subtype === 'loan' || type === 'equity') return 'financing'
  return 'operating'
}
