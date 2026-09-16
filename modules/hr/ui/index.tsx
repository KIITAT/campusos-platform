import { formatPaise } from '@campusos/money'
import type { LeaveBalance, LeaveRow, PayslipRow, StaffRow } from '../api/schemas'

/** Presentational only, as with the other modules. */

export function StaffTable({
  staff,
  hrefFor,
}: {
  staff: StaffRow[]
  hrefFor?: (s: StaffRow) => string
}) {
  if (staff.length === 0) {
    return <p className="text-sm text-neutral-500">Nobody on record yet.</p>
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-md text-left text-sm">
        <thead className="border-b border-neutral-300 text-xs uppercase text-neutral-500">
          <tr>
            <th className="py-2 pr-4 font-medium">Code</th>
            <th className="py-2 pr-4 font-medium">Name</th>
            <th className="py-2 pr-4 font-medium">Designation</th>
            <th className="py-2 pr-4 font-medium">Since</th>
            <th className="py-2 pr-4 font-medium">Monthly gross</th>
          </tr>
        </thead>
        <tbody>
          {staff.map((s) => (
            <tr key={s.id} className="border-b border-neutral-200">
              <td className="py-2 pr-4 font-mono text-xs">
                {hrefFor ? (
                  <a className="underline" href={hrefFor(s)}>
                    {s.employeeCode}
                  </a>
                ) : (
                  s.employeeCode
                )}
              </td>
              <td className="py-2 pr-4">
                {s.name}
                {s.leftOn && (
                  <span className="ml-2 text-xs text-neutral-500">left {s.leftOn}</span>
                )}
              </td>
              <td className="py-2 pr-4">
                {s.designation}
                {s.department && (
                  <span className="ml-2 text-xs text-neutral-500">{s.department}</span>
                )}
              </td>
              <td className="py-2 pr-4">{s.joinedOn}</td>
              <td className="py-2 pr-4">
                {s.monthlyGrossPaise === 0 ? (
                  <span className="text-amber-700">no pay set</span>
                ) : (
                  formatPaise(s.monthlyGrossPaise)
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

export function LeaveTable({ leave }: { leave: LeaveRow[] }) {
  if (leave.length === 0) {
    return <p className="text-sm text-neutral-500">Nothing on record.</p>
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-md text-left text-sm">
        <thead className="border-b border-neutral-300 text-xs uppercase text-neutral-500">
          <tr>
            <th className="py-2 pr-4 font-medium">Who</th>
            <th className="py-2 pr-4 font-medium">Type</th>
            <th className="py-2 pr-4 font-medium">Dates</th>
            <th className="py-2 pr-4 font-medium">Days</th>
            <th className="py-2 pr-4 font-medium">Status</th>
          </tr>
        </thead>
        <tbody>
          {leave.map((l) => (
            <tr key={l.id} className="border-b border-neutral-200">
              <td className="py-2 pr-4">{l.staffName}</td>
              <td className="py-2 pr-4">
                {l.typeName}
                {!l.paid && <span className="ml-2 text-xs text-amber-700">unpaid</span>}
              </td>
              <td className="py-2 pr-4">
                {l.fromOn}
                {l.toOn !== l.fromOn && ` to ${l.toOn}`}
              </td>
              <td className="py-2 pr-4">{l.days}</td>
              <td className="py-2 pr-4">
                <StatusTag status={l.status} />
                {l.decisionNote && (
                  <span className="ml-2 text-xs text-neutral-500">{l.decisionNote}</span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function StatusTag({ status }: { status: LeaveRow['status'] }) {
  const cls =
    status === 'approved'
      ? 'text-green-700'
      : status === 'rejected'
        ? 'text-red-700'
        : status === 'cancelled'
          ? 'text-neutral-500'
          : 'text-amber-700'
  return <span className={cls}>{status}</span>
}

export function BalanceList({ balances }: { balances: LeaveBalance[] }) {
  if (balances.length === 0) {
    return <p className="text-sm text-neutral-500">No leave types defined.</p>
  }

  return (
    <ul className="flex flex-wrap gap-2 text-xs">
      {balances.map((b) => (
        <li key={b.typeCode} className="rounded border border-neutral-300 px-2 py-1">
          {b.typeName}:{' '}
          {b.remainingDays === null ? (
            <span className="text-neutral-600">{b.takenDays} taken, no limit</span>
          ) : (
            <span className={b.remainingDays === 0 ? 'text-red-700' : ''}>
              {b.remainingDays} of {b.annualDays} left
            </span>
          )}
        </li>
      ))}
    </ul>
  )
}

export function PayslipTable({
  payslips,
  showWho = true,
}: {
  payslips: PayslipRow[]
  showWho?: boolean
}) {
  if (payslips.length === 0) {
    return <p className="text-sm text-neutral-500">No payslips yet.</p>
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-md text-left text-sm">
        <thead className="border-b border-neutral-300 text-xs uppercase text-neutral-500">
          <tr>
            <th className="py-2 pr-4 font-medium">Month</th>
            {showWho && <th className="py-2 pr-4 font-medium">Who</th>}
            <th className="py-2 pr-4 font-medium">Gross</th>
            <th className="py-2 pr-4 font-medium">Deductions</th>
            <th className="py-2 pr-4 font-medium">Net</th>
          </tr>
        </thead>
        <tbody>
          {payslips.map((p) => (
            <tr key={p.id} className="border-b border-neutral-200">
              <td className="py-2 pr-4">{p.period.slice(0, 7)}</td>
              {showWho && (
                <td className="py-2 pr-4">
                  {p.staffName}
                  <span className="ml-2 font-mono text-xs text-neutral-500">
                    {p.employeeCode}
                  </span>
                </td>
              )}
              <td className="py-2 pr-4">
                {formatPaise(p.grossPaise)}
                {p.unpaidLeaveDays > 0 && (
                  <span className="ml-2 text-xs text-amber-700">
                    {p.unpaidLeaveDays}d unpaid, −{formatPaise(p.lossOfPayPaise)}
                  </span>
                )}
              </td>
              <td className="py-2 pr-4">{formatPaise(p.deductionsPaise)}</td>
              <td className="py-2 pr-4 font-medium">{formatPaise(p.netPaise)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

export function PayslipDetail({ payslip: p }: { payslip: PayslipRow }) {
  return (
    <div className="space-y-2 rounded border border-neutral-200 p-3">
      <p className="text-sm font-medium">
        {p.staffName} — {p.period.slice(0, 7)}
      </p>
      <table className="w-full text-left text-sm">
        <tbody>
          {p.lines.map((l) => (
            <tr key={l.code} className="border-b border-neutral-100">
              <td className="py-1 pr-4">
                {l.label}
                {l.appliedPaise !== l.amountPaise && (
                  <span className="ml-2 text-xs text-neutral-500">
                    contracted {formatPaise(l.amountPaise)}
                  </span>
                )}
              </td>
              <td className="py-1 pr-4 text-right">
                {l.kind === 'deduction' ? '−' : ''}
                {formatPaise(l.appliedPaise)}
              </td>
            </tr>
          ))}
          <tr>
            <td className="py-1 pr-4 font-medium">Net</td>
            <td className="py-1 pr-4 text-right font-medium">{formatPaise(p.netPaise)}</td>
          </tr>
        </tbody>
      </table>
    </div>
  )
}
