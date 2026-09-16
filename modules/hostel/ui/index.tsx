import type { MyHostel, RollCall, RoomRow, VisitorRow } from '../api/schemas'

/** Presentational only, as with the other modules. */

export function OccupancyGrid({
  rooms,
  hrefFor,
}: {
  rooms: RoomRow[]
  hrefFor?: (r: RoomRow) => string
}) {
  if (rooms.length === 0) {
    return <p className="text-sm text-neutral-500">No rooms yet.</p>
  }

  return (
    <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
      {rooms.map((r) => {
        const free = r.capacity - r.occupied
        return (
          <div
            key={r.id}
            className={`rounded border px-3 py-2 ${
              free === 0 ? 'border-neutral-300 bg-neutral-50' : 'border-green-300 bg-green-50'
            }`}
          >
            <p className="flex items-baseline justify-between">
              <span className="font-medium">
                {hrefFor ? (
                  <a className="underline" href={hrefFor(r)}>
                    {r.blockCode}-{r.number}
                  </a>
                ) : (
                  `${r.blockCode}-${r.number}`
                )}
              </span>
              <span className="text-xs text-neutral-600">
                {r.occupied}/{r.capacity}
                {free > 0 && ` · ${free} free`}
              </span>
            </p>
            <ul className="mt-1 space-y-0.5 text-xs text-neutral-700">
              {r.residents.map((p) => (
                <li key={p.allocationId}>{p.name ?? p.email}</li>
              ))}
              {r.residents.length === 0 && <li className="text-neutral-400">empty</li>}
            </ul>
          </div>
        )
      })}
    </div>
  )
}

export function RollCallTable({ roll }: { roll: RollCall }) {
  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Figure label="Present" value={String(roll.present)} tone="clear" />
        <Figure label="Absent" value={String(roll.absent)} tone={roll.absent ? 'due' : undefined} />
        <Figure label="On leave" value={String(roll.onLeave)} />
        <Figure
          label="Not yet marked"
          value={String(roll.unmarked)}
          tone={roll.unmarked ? 'due' : 'clear'}
        />
      </div>

      {roll.rows.length === 0 ? (
        <p className="text-sm text-neutral-500">Nobody is resident in this block tonight.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-md text-left text-sm">
            <thead className="border-b border-neutral-300 text-xs uppercase text-neutral-500">
              <tr>
                <th className="py-2 pr-4 font-medium">Room</th>
                <th className="py-2 pr-4 font-medium">Resident</th>
                <th className="py-2 pr-4 font-medium">Status</th>
                <th className="py-2 pr-4 font-medium">Note</th>
              </tr>
            </thead>
            <tbody>
              {roll.rows.map((r) => (
                <tr key={r.studentId} className="border-b border-neutral-200">
                  <td className="py-2 pr-4 font-mono text-xs">{r.roomNumber}</td>
                  <td className="py-2 pr-4">{r.name ?? r.email}</td>
                  <td className="py-2 pr-4">
                    {r.onLeave && !r.status ? (
                      <span className="text-neutral-600">on leave</span>
                    ) : r.status === 'present' ? (
                      <span className="text-green-700">present</span>
                    ) : r.status === 'absent' ? (
                      <span className="font-medium text-red-700">absent</span>
                    ) : r.status === 'on_leave' ? (
                      <span className="text-neutral-600">on leave</span>
                    ) : (
                      <span className="text-amber-700">not marked</span>
                    )}
                    {r.method && (
                      <span className="ml-2 text-xs text-neutral-500">{r.method}</span>
                    )}
                  </td>
                  <td className="py-2 pr-4 text-xs text-neutral-600">{r.note ?? ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

export function VisitorTable({ visitors }: { visitors: VisitorRow[] }) {
  if (visitors.length === 0) {
    return <p className="text-sm text-neutral-500">Nobody signed in.</p>
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-md text-left text-sm">
        <thead className="border-b border-neutral-300 text-xs uppercase text-neutral-500">
          <tr>
            <th className="py-2 pr-4 font-medium">Visitor</th>
            <th className="py-2 pr-4 font-medium">For</th>
            <th className="py-2 pr-4 font-medium">In</th>
            <th className="py-2 pr-4 font-medium">Out</th>
          </tr>
        </thead>
        <tbody>
          {visitors.map((v) => (
            <tr key={v.id} className="border-b border-neutral-200">
              <td className="py-2 pr-4">
                {v.name}
                {v.relation && (
                  <span className="ml-2 text-xs text-neutral-500">{v.relation}</span>
                )}
                {v.phone && (
                  <span className="ml-2 font-mono text-xs text-neutral-500">{v.phone}</span>
                )}
              </td>
              <td className="py-2 pr-4">{v.studentName ?? '-'}</td>
              <td className="py-2 pr-4">{v.enteredAt.slice(11, 16)}</td>
              <td className="py-2 pr-4">
                {v.exitedAt ? (
                  v.exitedAt.slice(11, 16)
                ) : (
                  <span className="text-amber-700">still inside</span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

export function MyHostelCard({ status: s }: { status: MyHostel }) {
  if (!s.allocated) {
    return (
      <p className="rounded border border-neutral-300 bg-neutral-50 px-3 py-2 text-sm text-neutral-700">
        No room is allocated to you. The hostel office allocates beds; this page
        fills in once yours is.
      </p>
    )
  }

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        <Figure label="Block" value={`${s.blockCode} — ${s.blockName ?? ''}`} />
        <Figure label="Room" value={s.roomNumber ?? '-'} />
        <Figure label="Floor" value={String(s.floor ?? 0)} />
      </div>

      {s.roommates.length > 0 && (
        <p className="text-sm text-neutral-700">
          Sharing with {s.roommates.map((r) => r.name).filter(Boolean).join(', ')}.
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
