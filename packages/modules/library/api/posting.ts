import { postWithin } from '@campusos/module-finance/api'
import { withTenant } from '@campusos/db'

/**
 * What the library says to the books, which is one thing and only sometimes.
 *
 * A fine is income when it is collected, not when it is incurred. Nobody
 * invoices an overdue book: the fine accrues on the loan, grows while the book
 * is out, and is settled or forgiven at the desk. So there is no receivable to
 * raise and nothing to post until money actually changes hands --
 *
 *   debit  cash            it was taken at the desk
 *   credit fines and charges  income, and deliberately not tuition income
 *
 * -- and a waived fine posts nothing at all, because income never recognised
 * cannot be forgone.
 *
 * `finance` is a soft dependency. A library that cannot take a five-rupee fine
 * because the institution has not bought the books is a library that has
 * stopped working, so when finance is off the desk still works and the loan
 * record is still the record. What it does not do is pretend: a fine settled
 * while the books were off is not backfilled when they are turned on, the same
 * way hostel roll call does not invent the attendance it never had.
 */

type Tx = Parameters<Parameters<typeof withTenant>[1]>[0]

export async function postFineSettled(
  tx: Tx,
  institutionId: string,
  actorId: string | null,
  fine: {
    loanId: string
    amountPaise: number
    borrowerName: string | null
    title: string
  },
): Promise<void> {
  if (fine.amountPaise <= 0) return

  await postWithin(tx, institutionId, actorId, {
    memo: `Library fine, ${fine.borrowerName ?? 'a borrower'} (${fine.title})`,
    sourceModule: 'library',
    sourceRef: `fine:${fine.loanId}`,
    lines: [
      // Cash, because this is a desk taking coins. A library that starts
      // collecting by transfer wants a method on the settlement first.
      { purpose: 'cash', debitPaise: fine.amountPaise },
      { purpose: 'fine_income', creditPaise: fine.amountPaise },
    ],
  })
}
