import type { Timetable } from '../api/schemas'

/**
 * Presentational only: no data fetching, no auth, no server actions. The module
 * owns how its domain looks; the app owns wiring. That split is what lets the
 * parent portal in a later phase render the same grid against a different
 * caller without duplicating it.
 */

const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']

export function TimetableGrid({ timetable }: { timetable: Timetable }) {
  if (!timetable.termCode) {
    return (
      <p className="text-sm text-neutral-600">
        No term is marked current. An administrator opens the semester on the
        Structure page.
      </p>
    )
  }

  if (timetable.entries.length === 0) {
    return (
      <p className="text-sm text-neutral-600">
        Nothing scheduled for {timetable.termCode}.
      </p>
    )
  }

  // Group by weekday so a reader scans a week, not a flat list.
  const byDay = new Map<number, Timetable['entries']>()
  for (const e of timetable.entries) {
    const day = byDay.get(e.dayOfWeek) ?? []
    day.push(e)
    byDay.set(e.dayOfWeek, day)
  }

  return (
    <div className="space-y-6">
      <p className="text-sm text-neutral-500">Term {timetable.termCode}</p>
      {[...byDay.entries()]
        .sort(([a], [b]) => a - b)
        .map(([day, entries]) => (
          <section key={day}>
            <h3 className="mb-2 text-sm font-medium">{DAYS[day - 1] ?? `Day ${day}`}</h3>
            <ul className="space-y-1">
              {entries.map((e) => (
                <li
                  key={e.slotId}
                  className="flex flex-wrap items-baseline gap-x-3 gap-y-1 rounded border border-neutral-200 bg-white px-3 py-2 text-sm"
                >
                  <span className="font-mono text-xs text-neutral-500">
                    {e.startsAt.slice(0, 5)}–{e.endsAt.slice(0, 5)}
                  </span>
                  <span className="font-medium">{e.courseCode}</span>
                  <span className="min-w-0 truncate text-neutral-700">{e.courseTitle}</span>
                  <span className="text-xs text-neutral-500">
                    {e.programCode}-{e.sectionLabel} · {e.roomCode}
                    {e.facultyName && ` · ${e.facultyName}`}
                  </span>
                </li>
              ))}
            </ul>
          </section>
        ))}
    </div>
  )
}
