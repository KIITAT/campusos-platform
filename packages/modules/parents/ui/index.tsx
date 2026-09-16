import { formatPaise } from '@campusos/money'
import type { ChildOverview, LinkRow } from '../api/schemas'

/** Presentational only, as with the other modules. */

export function ChildView({ child: c }: { child: ChildOverview }) {
  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-xl font-semibold">{c.studentName ?? c.studentEmail}</h2>
        {c.sections.length === 0 && (
          <p className="mt-1 rounded border border-neutral-300 bg-neutral-50 px-3 py-2 text-sm text-neutral-700">
            This institution has not enabled any of the modules this portal reads
            from, so there is nothing to show yet.
          </p>
        )}
      </div>

      {c.attendance && (
        <Section title="Attendance">
          <p className="text-sm text-neutral-700">
            {c.attendance.marked} classes marked present.
          </p>
          {c.attendance.recent.length > 0 && (
            <ul className="mt-2 flex flex-wrap gap-2 text-xs">
              {c.attendance.recent.map((r) => (
                <li
                  key={`${r.courseCode}-${r.markedAt}`}
                  className="rounded border border-neutral-300 px-2 py-1"
                >
                  {r.courseCode} · {r.markedAt.slice(0, 10)}
                </li>
              ))}
            </ul>
          )}
        </Section>
      )}

      {c.results && (
        <Section title="Results">
          {c.results.provisional && (
            <p className="mb-2 rounded border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-800">
              Provisional: some courses have no published results yet, so these
              figures cover only what has been published.
            </p>
          )}
          {c.results.gpa !== null && (
            <p className="text-sm text-neutral-700">GPA {c.results.gpa.toFixed(2)}</p>
          )}
          {c.results.grades.length === 0 ? (
            <p className="text-sm text-neutral-500">Nothing published yet.</p>
          ) : (
            <div className="mt-2 overflow-x-auto">
              <table className="w-full min-w-md text-left text-sm">
                <thead className="border-b border-neutral-300 text-xs uppercase text-neutral-500">
                  <tr>
                    <th className="py-2 pr-4 font-medium">Course</th>
                    <th className="py-2 pr-4 font-medium">%</th>
                    <th className="py-2 pr-4 font-medium">Grade</th>
                  </tr>
                </thead>
                <tbody>
                  {c.results.grades.map((g) => (
                    <tr key={g.courseCode} className="border-b border-neutral-200">
                      <td className="py-2 pr-4">
                        <span className="font-mono text-xs">{g.courseCode}</span> {g.courseTitle}
                      </td>
                      <td className="py-2 pr-4">{g.percent.toFixed(2)}</td>
                      <td className="py-2 pr-4">
                        <span className={g.passed ? '' : 'font-medium text-red-700'}>
                          {g.label ?? '-'}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Section>
      )}

      {c.fees && (
        <Section title={`Fees — ${c.fees.termCode}`}>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
            <Figure label="Payable" value={formatPaise(c.fees.payablePaise)} />
            <Figure label="Paid" value={formatPaise(c.fees.paidPaise)} />
            <Figure
              label="Outstanding"
              value={formatPaise(c.fees.outstandingPaise)}
              tone={c.fees.outstandingPaise > 0 ? 'due' : 'clear'}
            />
          </div>
          {c.fees.unreconciledPaise > 0 && (
            <p className="mt-2 text-xs text-amber-700">
              {formatPaise(c.fees.unreconciledPaise)} is recorded but not yet
              confirmed against the bank.
            </p>
          )}
        </Section>
      )}

      {c.library && (
        <Section title="Library">
          <p className="text-sm text-neutral-700">
            {c.library.openCount} books out
            {c.library.overdue > 0 && `, ${c.library.overdue} overdue`}
            {c.library.outstandingFinePaise > 0 &&
              `, ${formatPaise(c.library.outstandingFinePaise)} in fines`}
            .
          </p>
        </Section>
      )}

      {c.hostel && (
        <Section title="Hostel">
          {c.hostel.allocated ? (
            <p className="text-sm text-neutral-700">
              Room {c.hostel.blockCode}-{c.hostel.roomNumber}.
            </p>
          ) : (
            <p className="text-sm text-neutral-500">No room allocated.</p>
          )}
          {c.hostel.recentNights.length > 0 && (
            <ul className="mt-2 flex flex-wrap gap-2 text-xs">
              {c.hostel.recentNights.map((n) => (
                <li
                  key={n.onNight}
                  className={`rounded border px-2 py-1 ${
                    n.status === 'present'
                      ? 'border-green-300 text-green-800'
                      : n.status === 'absent'
                        ? 'border-red-300 text-red-800'
                        : 'border-neutral-300 text-neutral-700'
                  }`}
                >
                  {n.onNight} · {n.status.replace(/_/g, ' ')}
                </li>
              ))}
            </ul>
          )}
        </Section>
      )}
    </div>
  )
}

export function LinkTable({ links }: { links: LinkRow[] }) {
  if (links.length === 0) {
    return <p className="text-sm text-neutral-500">Nothing here.</p>
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-md text-left text-sm">
        <thead className="border-b border-neutral-300 text-xs uppercase text-neutral-500">
          <tr>
            <th className="py-2 pr-4 font-medium">Parent</th>
            <th className="py-2 pr-4 font-medium">Student</th>
            <th className="py-2 pr-4 font-medium">Relation</th>
            <th className="py-2 pr-4 font-medium">Status</th>
          </tr>
        </thead>
        <tbody>
          {links.map((l) => (
            <tr key={l.id} className="border-b border-neutral-200">
              <td className="py-2 pr-4">
                {l.parentName ?? l.parentEmail}
                <span className="ml-2 font-mono text-xs text-neutral-500">{l.id.slice(0, 8)}</span>
              </td>
              <td className="py-2 pr-4">{l.studentName ?? l.studentEmail}</td>
              <td className="py-2 pr-4">{l.relation}</td>
              <td className="py-2 pr-4">
                {l.verifiedAt ? (
                  <span className="text-green-700">verified</span>
                ) : l.refusedReason ? (
                  <span className="text-red-700">
                    refused
                    <span className="ml-2 text-xs text-neutral-500">{l.refusedReason}</span>
                  </span>
                ) : (
                  <span className="text-amber-700">awaiting verification</span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="space-y-1 border-t border-neutral-200 pt-4">
      <h3 className="text-sm font-medium text-neutral-700">{title}</h3>
      {children}
    </section>
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
