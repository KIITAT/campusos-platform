import type { Roster } from '../api/schemas'

/** Presentational only. See the academic module's ui/ for why. */

const ANOMALY_LABEL: Record<string, string> = {
  identical_coordinates: 'same coordinates as another student',
  implausible_accuracy: 'implausibly precise location',
  room_has_no_geofence: 'room has no geofence set',
}

export function RosterTable({ roster }: { roster: Roster }) {
  return (
    <div className="space-y-3">
      <p className="text-sm text-neutral-600">
        <b>
          {roster.present} of {roster.total}
        </b>{' '}
        present &middot; {roster.courseCode} &middot; {roster.sectionLabel} &middot;{' '}
        {roster.roomCode}
        {roster.closedAt && ' · closed'}
      </p>

      <div className="overflow-x-auto">
        <table className="w-full min-w-md text-left text-sm">
          <thead className="border-b border-neutral-300 text-xs uppercase text-neutral-500">
            <tr>
              <th className="py-2 pr-4 font-medium">Student</th>
              <th className="py-2 pr-4 font-medium">Status</th>
              <th className="py-2 pr-4 font-medium">Marked</th>
              <th className="py-2 pr-4 font-medium">Notes</th>
            </tr>
          </thead>
          <tbody>
            {roster.entries.map((e) => (
              <tr key={e.studentId} className="border-b border-neutral-200">
                <td className="py-2 pr-4">
                  {e.name ?? e.email ?? e.studentId}
                  {e.email && e.name && (
                    <span className="ml-2 text-xs text-neutral-500">{e.email}</span>
                  )}
                </td>
                <td className="py-2 pr-4">
                  {e.status === 'present' ? (
                    <span className="text-green-700">
                      present
                      {e.method === 'manual_override' && (
                        <span className="ml-1 text-xs text-neutral-500">(manual)</span>
                      )}
                    </span>
                  ) : (
                    <span className="text-neutral-400">absent</span>
                  )}
                </td>
                <td className="py-2 pr-4 font-mono text-xs text-neutral-500">
                  {e.markedAt ? new Date(e.markedAt).toLocaleTimeString() : '—'}
                </td>
                <td className="py-2 pr-4 text-xs">
                  {e.overrideReason && (
                    <span className="text-neutral-600">{e.overrideReason}</span>
                  )}
                  {e.anomalies.length > 0 && (
                    <span className="ml-1 text-amber-700">
                      {e.anomalies.map((a) => ANOMALY_LABEL[a] ?? a).join('; ')}
                    </span>
                  )}
                </td>
              </tr>
            ))}
            {roster.entries.length === 0 && (
              <tr>
                <td colSpan={4} className="py-3 text-neutral-500">
                  Nobody is enrolled in this cohort yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {roster.entries.some((e) => e.anomalies.length > 0) && (
        <p className="text-xs text-amber-700">
          Flags are for review, never automatic rejection: each one has an innocent
          explanation as well as a suspicious one.
        </p>
      )}
    </div>
  )
}
