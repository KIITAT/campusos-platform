import { formatPaise } from '@campusos/money'
import type { DuesReport, StudentLedger } from '../api/schemas'

/** Presentational only, as with the other modules. */

const money = (paise: number) => formatPaise(paise)

export function LedgerView({ ledger: l }: { ledger: StudentLedger }) {
  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Figure label="Payable" value={money(l.payablePaise)} />
        <Figure label="Paid" value={money(l.paidPaise)} />
        <Figure
          label="Outstanding"
          value={money(l.outstandingPaise)}
          tone={l.outstandingPaise > 0 ? 'due' : 'clear'}
        />
        {l.overpaidPaise > 0 ? (
          <Figure label="In credit" value={money(l.overpaidPaise)} tone="clear" />
        ) : (
          <Figure label="Waived" value={money(l.waivedPaise)} />
        )}
      </div>

      {l.unreconciledPaise > 0 && (
        <p className="rounded border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-800">
          {money(l.unreconciledPaise)} is recorded but not yet confirmed against the
          bank. It counts against what you owe, and the receipt will be marked
          pending until it clears.
        </p>
      )}

      <section className="space-y-2">
        <h2 className="text-sm font-medium text-neutral-700">Charges</h2>
        {l.lines.length === 0 ? (
          <Empty>No charges for {l.termCode} yet.</Empty>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-md text-left text-sm">
              <thead className="border-b border-neutral-300 text-xs uppercase text-neutral-500">
                <tr>
                  <th className="py-2 pr-4 font-medium">Item</th>
                  <th className="py-2 pr-4 font-medium">Charged</th>
                  <th className="py-2 pr-4 font-medium">Waived</th>
                  <th className="py-2 pr-4 font-medium">Payable</th>
                </tr>
              </thead>
              <tbody>
                {l.lines.map((line) => (
                  <tr key={line.feeItemId} className="border-b border-neutral-200">
                    <td className="py-2 pr-4">
                      {line.label}
                      {line.waiverReason && (
                        <span className="ml-2 text-xs text-neutral-500">
                          {line.waiverReason}
                        </span>
                      )}
                    </td>
                    <td className="py-2 pr-4">{money(line.chargedPaise)}</td>
                    <td className="py-2 pr-4">
                      {line.waivedPaise > 0 ? money(line.waivedPaise) : '-'}
                    </td>
                    <td className="py-2 pr-4">
                      {money(line.chargedPaise - line.waivedPaise)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="space-y-2">
        <h2 className="text-sm font-medium text-neutral-700">Payments</h2>
        {l.payments.length === 0 ? (
          <Empty>Nothing received yet.</Empty>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-md text-left text-sm">
              <thead className="border-b border-neutral-300 text-xs uppercase text-neutral-500">
                <tr>
                  <th className="py-2 pr-4 font-medium">Receipt</th>
                  <th className="py-2 pr-4 font-medium">Date</th>
                  <th className="py-2 pr-4 font-medium">Method</th>
                  <th className="py-2 pr-4 font-medium">Amount</th>
                  <th className="py-2 pr-4 font-medium">Status</th>
                </tr>
              </thead>
              <tbody>
                {l.payments.map((p) => (
                  <tr key={p.id} className="border-b border-neutral-200">
                    <td className="py-2 pr-4 font-mono text-xs">
                      <a
                        className="underline"
                        href={`/api/v1/modules/fees/receipt.pdf?paymentId=${encodeURIComponent(p.id)}`}
                      >
                        {p.receiptNo}
                      </a>
                    </td>
                    <td className="py-2 pr-4">{p.receivedAt.slice(0, 10)}</td>
                    <td className="py-2 pr-4">{p.method.replace(/_/g, ' ')}</td>
                    <td className="py-2 pr-4">{money(p.amountPaise)}</td>
                    <td className="py-2 pr-4">
                      {p.reconciledAt ? (
                        <span className="text-green-700">confirmed</span>
                      ) : (
                        <span className="text-amber-700">pending</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  )
}

/**
 * linkTermId turns each name into a link to that student's ledger. Optional so
 * the table renders anywhere; the app supplies the term it is showing.
 */
export function DuesTable({
  report,
  linkTermId,
}: {
  report: DuesReport
  linkTermId?: string
}) {
  if (report.rows.length === 0) {
    return <Empty>No charges have been raised for {report.termCode}.</Empty>
  }

  return (
    <div className="space-y-3">
      <p className="text-sm text-neutral-600">
        {report.defaulterCount} of {report.rows.length} students owe money, totalling{' '}
        <strong>{money(report.totalOutstandingPaise)}</strong>.
      </p>
      <div className="overflow-x-auto">
        <table className="w-full min-w-md text-left text-sm">
          <thead className="border-b border-neutral-300 text-xs uppercase text-neutral-500">
            <tr>
              <th className="py-2 pr-4 font-medium">Student</th>
              <th className="py-2 pr-4 font-medium">Program</th>
              <th className="py-2 pr-4 font-medium">Payable</th>
              <th className="py-2 pr-4 font-medium">Paid</th>
              <th className="py-2 pr-4 font-medium">Outstanding</th>
            </tr>
          </thead>
          <tbody>
            {report.rows.map((r) => (
              <tr key={r.studentId} className="border-b border-neutral-200">
                <td className="py-2 pr-4">
                  {linkTermId ? (
                    <a
                      className="underline"
                      href={`/fees/${r.studentId}?termId=${linkTermId}`}
                    >
                      {r.studentName ?? r.studentEmail}
                    </a>
                  ) : (
                    (r.studentName ?? r.studentEmail)
                  )}
                  {r.unreconciledPaise > 0 && (
                    <span className="ml-2 text-xs text-amber-700">
                      {money(r.unreconciledPaise)} pending
                    </span>
                  )}
                </td>
                <td className="py-2 pr-4 font-mono text-xs">{r.programCode}</td>
                <td className="py-2 pr-4">{money(r.payablePaise)}</td>
                <td className="py-2 pr-4">{money(r.paidPaise)}</td>
                <td className="py-2 pr-4">
                  <span className={r.outstandingPaise > 0 ? 'font-medium text-red-700' : ''}>
                    {money(r.outstandingPaise)}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
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

function Empty({ children }: { children: React.ReactNode }) {
  return <p className="text-sm text-neutral-500">{children}</p>
}
