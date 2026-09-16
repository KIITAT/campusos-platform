import { formatPaise } from '@campusos/money'
import type { BorrowerStatus, CatalogueRow, LoanRow } from '../api/schemas'

/** Presentational only, as with the other modules. */

const day = (iso: string) => iso.slice(0, 10)

/** Why a borrower is blocked, in words a librarian can say out loud. */
export const blockedMessage = (code: string, max: number) =>
  code === 'loan_limit_reached'
    ? `already holding the maximum of ${max} books`
    : code === 'fines_outstanding'
      ? 'unpaid fines above the borrowing limit'
      : 'not permitted to borrow at present'

export function CatalogueTable({
  rows,
  hrefFor,
}: {
  rows: CatalogueRow[]
  hrefFor?: (r: CatalogueRow) => string
}) {
  if (rows.length === 0) {
    return <p className="text-sm text-neutral-500">Nothing matches.</p>
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-md text-left text-sm">
        <thead className="border-b border-neutral-300 text-xs uppercase text-neutral-500">
          <tr>
            <th className="py-2 pr-4 font-medium">Title</th>
            <th className="py-2 pr-4 font-medium">Author</th>
            <th className="py-2 pr-4 font-medium">Year</th>
            <th className="py-2 pr-4 font-medium">Copies</th>
            <th className="py-2 pr-4 font-medium">On shelf</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.titleId} className="border-b border-neutral-200">
              <td className="py-2 pr-4">
                {hrefFor ? (
                  <a className="underline" href={hrefFor(r)}>
                    {r.title}
                  </a>
                ) : (
                  r.title
                )}
                {r.isbn && (
                  <span className="ml-2 font-mono text-xs text-neutral-500">{r.isbn}</span>
                )}
              </td>
              <td className="py-2 pr-4">{r.author}</td>
              <td className="py-2 pr-4">{r.year ?? '-'}</td>
              <td className="py-2 pr-4">{r.copies}</td>
              <td className="py-2 pr-4">
                <span className={r.available === 0 ? 'text-red-700' : 'text-green-700'}>
                  {r.available}
                </span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

export function LoanTable({
  loans,
  showBorrower = true,
}: {
  loans: LoanRow[]
  showBorrower?: boolean
}) {
  if (loans.length === 0) {
    return <p className="text-sm text-neutral-500">Nothing out.</p>
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-md text-left text-sm">
        <thead className="border-b border-neutral-300 text-xs uppercase text-neutral-500">
          <tr>
            <th className="py-2 pr-4 font-medium">Book</th>
            {showBorrower && <th className="py-2 pr-4 font-medium">Borrower</th>}
            <th className="py-2 pr-4 font-medium">Accession</th>
            <th className="py-2 pr-4 font-medium">Due</th>
            <th className="py-2 pr-4 font-medium">Fine</th>
          </tr>
        </thead>
        <tbody>
          {loans.map((l) => (
            <tr key={l.id} className="border-b border-neutral-200">
              <td className="py-2 pr-4">
                {l.title}
                <span className="ml-2 text-xs text-neutral-500">{l.author}</span>
              </td>
              {showBorrower && (
                <td className="py-2 pr-4">{l.borrowerName ?? l.borrowerEmail}</td>
              )}
              <td className="py-2 pr-4 font-mono text-xs">{l.accessionNo}</td>
              <td className="py-2 pr-4">
                {day(l.dueOn)}
                {l.daysOverdue > 0 && !l.returnedAt && (
                  <span className="ml-2 font-medium text-red-700">
                    {l.daysOverdue}d late
                  </span>
                )}
                {l.renewals > 0 && (
                  <span className="ml-2 text-xs text-neutral-500">
                    renewed {l.renewals}x
                  </span>
                )}
              </td>
              <td className="py-2 pr-4">
                {l.finePaise === 0 ? (
                  '-'
                ) : (
                  <span className={l.finePaidAt ? 'text-neutral-500' : 'text-red-700'}>
                    {formatPaise(l.finePaise - l.fineWaivedPaise)}
                    {l.finePaidAt && ' paid'}
                    {l.fineWaivedPaise > 0 && !l.finePaidAt && ' after waiver'}
                  </span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

export function BorrowerCard({ status: s }: { status: BorrowerStatus }) {
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        <Figure label="Out now" value={`${s.openCount} of ${s.maxConcurrentLoans}`} />
        <Figure
          label="Fines owed"
          value={formatPaise(s.outstandingFinePaise)}
          tone={s.outstandingFinePaise > 0 ? 'due' : undefined}
        />
        <Figure
          label="Borrowing"
          value={s.blockedBy ? 'blocked' : 'allowed'}
          tone={s.blockedBy ? 'due' : 'clear'}
        />
      </div>

      {s.blockedBy && (
        <p className="rounded border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-800">
          Cannot borrow: {blockedMessage(s.blockedBy, s.maxConcurrentLoans)}.
        </p>
      )}
    </div>
  )
}

function Figure({
  label,
  value,
  tone,
}: {
  label: string
  value: string
  tone?: 'due' | 'clear'
}) {
  const color =
    tone === 'due' ? 'text-red-700' : tone === 'clear' ? 'text-green-700' : 'text-neutral-900'
  return (
    <div className="rounded border border-neutral-200 px-3 py-2">
      <p className="text-xs uppercase text-neutral-500">{label}</p>
      <p className={`text-lg font-medium ${color}`}>{value}</p>
    </div>
  )
}
