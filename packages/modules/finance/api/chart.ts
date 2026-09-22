/**
 * The chart an institution gets if it never builds its own.
 *
 * Eleven accounts, which is the smallest set that lets fees, aid, the library
 * and payroll all post something an accountant would recognise. Codes follow the
 * convention almost every Indian college's auditor already uses -- 1000s
 * assets, 2000s liabilities, 4000s income, 5000s expense -- so the first
 * conversation about this is "renumber these" rather than "what is any of
 * this".
 *
 * Every row carries a purpose, because the point of the default chart is that
 * posting works on day one without anybody opening the accounts screen.
 */
export const DEFAULT_CHART = [
  { code: '1000', name: 'Cash in hand', type: 'asset', purpose: 'cash' },
  { code: '1010', name: 'Bank account', type: 'asset', purpose: 'bank' },
  { code: '1100', name: 'Fees receivable', type: 'asset', purpose: 'fees_receivable' },
  {
    code: '2100',
    name: 'Salaries payable',
    type: 'liability',
    purpose: 'salaries_payable',
  },
  {
    code: '2200',
    name: 'Statutory withholdings payable',
    type: 'liability',
    purpose: 'withholdings_payable',
  },
  { code: '4000', name: 'Tuition and fees', type: 'income', purpose: 'fee_income' },
  { code: '4100', name: 'Fines and charges', type: 'income', purpose: 'fine_income' },
  {
    code: '5000',
    name: 'Fee waivers and concessions',
    type: 'expense',
    purpose: 'fee_waiver',
  },
  {
    code: '5200',
    name: 'Scholarships awarded',
    type: 'expense',
    purpose: 'scholarship_expense',
  },
  { code: '5100', name: 'Salaries and wages', type: 'expense', purpose: 'salaries_expense' },
  {
    code: '5110',
    name: 'Employer contributions',
    type: 'expense',
    purpose: 'employer_cost',
  },
] as const

/** Which side of an account a positive balance sits on. */
export const normalSide = (type: string): 'debit' | 'credit' =>
  type === 'asset' || type === 'expense' ? 'debit' : 'credit'
