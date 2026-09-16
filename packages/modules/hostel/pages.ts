import { param, type PluginPage } from '@campusos/module-framework'
import {
  listBlocks,
  listRooms,
  myHostel,
  rollCall,
  visitorLog,
  type Actor,
} from './api'

const WARDEN = ['institution_admin', 'super_admin', 'hostel_staff'] as const

export const pages: PluginPage[] = [
  {
    path: '/',
    title: 'Hostel',
    menu: 'Rooms',
    roles: [...WARDEN],
    async load(actor, req) {
      const a = actor as Actor
      const blockId = param(req, 'blockId')
      const [blocks, rooms] = await Promise.all([listBlocks(a), listRooms(a, blockId)])
      return {
        rooms: rooms.map((r) => ({
          ...r,
          room: `${r.blockCode}-${r.number}`,
          free: r.capacity - r.occupied,
          full: r.occupied >= r.capacity,
          residents: r.residents.map((p) => p.name ?? p.email).join(', ') || 'empty',
        })),
        beds: rooms.reduce((n, r) => n + r.capacity, 0),
        taken: rooms.reduce((n, r) => n + r.occupied, 0),
        blocks: [
          { label: 'all', href: '/m/hostel', active: !blockId },
          ...blocks.map((b) => ({
            label: b.code,
            href: `/m/hostel?blockId=${b.id}`,
            active: b.id === blockId,
          })),
        ],
        blockOptions: blocks.map((b) => ({ value: b.id, label: `${b.code} - ${b.name}` })),
        freeOptions: rooms
          .filter((r) => r.occupied < r.capacity)
          .map((r) => ({
            value: r.id,
            label: `${r.blockCode}-${r.number} — ${r.capacity - r.occupied} free`,
          })),
        residentOptions: rooms.flatMap((r) =>
          r.residents.map((p) => ({
            value: p.allocationId,
            label: `${r.blockCode}-${r.number} — ${p.name ?? p.email}`,
          })),
        ),
      }
    },
    sections: (data) => [
      { kind: 'links', title: 'Block', links: data.blocks as never },
      {
        kind: 'note',
        text:
          `${data.taken} of ${data.beds} beds taken. A room cannot be over-filled ` +
          `and a student cannot hold two beds — Postgres enforces both, so two ` +
          `wardens allocating at once cannot both win.`,
      },
      {
        kind: 'table',
        rows: 'rooms',
        empty: 'No rooms yet.',
        columns: [
          { key: 'room', label: 'Room', kind: 'code' },
          { key: 'floor', label: 'Floor' },
          { key: 'occupied', label: 'Taken', alertWhen: 'full' },
          { key: 'capacity', label: 'Beds' },
          { key: 'residents', label: 'Residents' },
        ],
      },
      {
        kind: 'form',
        title: 'Allocate a bed',
        submit: 'Allocate',
        path: '/allocations',
        fields: [
          { name: 'roomId', label: 'Room', kind: 'select', options: 'freeOptions' },
          { name: 'studentId', label: 'Student' },
        ],
      },
      {
        kind: 'form',
        title: 'Vacate a bed',
        note:
          'Audited with a reason. The allocation is kept, not deleted: who slept ' +
          'where is a record somebody official will ask for.',
        submit: 'Vacate',
        path: '/allocations/vacate',
        fields: [
          { name: 'allocationId', label: 'Resident', kind: 'select', options: 'residentOptions' },
          { name: 'reason', label: 'Reason' },
        ],
      },
      {
        kind: 'form',
        title: 'Add a block',
        submit: 'Add block',
        path: '/blocks',
        fields: [
          { name: 'code', label: 'Code', hint: 'e.g. a, ganga' },
          { name: 'name', label: 'Name' },
          {
            name: 'kind',
            label: 'Kind',
            kind: 'select',
            options: [
              { value: 'mens', label: "men's" },
              { value: 'womens', label: "women's" },
              { value: 'any', label: 'any' },
            ],
          },
        ],
      },
      {
        kind: 'form',
        title: 'Add rooms',
        note: 'One number per line or comma separated — a floor at a time.',
        submit: 'Add rooms',
        path: '/rooms',
        fields: [
          { name: 'blockId', label: 'Block', kind: 'select', options: 'blockOptions' },
          { name: 'numbers', label: 'Room numbers', kind: 'textarea', rows: 4 },
          { name: 'floor', label: 'Floor', kind: 'number', value: '1' },
          { name: 'capacity', label: 'Beds per room', kind: 'number', value: '2' },
        ],
      },
    ],
  },

  {
    path: '/rollcall',
    title: 'Roll call',
    menu: 'Roll call',
    roles: [...WARDEN],
    async load(actor, req) {
      const a = actor as Actor
      const blocks = await listBlocks(a)
      const wanted = param(req, 'blockId')
      const block = blocks.find((b) => b.id === wanted) ?? blocks[0]
      if (!block) return { rows: [], blocks: [], mode: 'manual', residents: [] }

      const roll = await rollCall(a, block.id, param(req, 'night'))
      return {
        blockId: block.id,
        mode: roll.mode,
        onNight: roll.onNight,
        present: roll.present,
        absent: roll.absent,
        onLeave: roll.onLeave,
        unmarked: roll.unmarked,
        rows: roll.rows.map((r) => ({
          ...r,
          who: r.name ?? r.email,
          state: r.status ?? (r.onLeave ? 'on leave' : 'not marked'),
          missing: r.status === 'absent' || (!r.status && !r.onLeave),
        })),
        residents: roll.rows.map((r) => ({
          value: r.studentId,
          label: `${r.roomNumber} — ${r.name ?? r.email}`,
        })),
        blocks: blocks.map((b) => ({
          label: b.code,
          href: `/m/hostel/rollcall?blockId=${b.id}`,
          active: b.id === block.id,
        })),
      }
    },
    sections: (data) => [
      { kind: 'links', title: 'Block', links: data.blocks as never },
      {
        kind: 'note',
        text:
          data.mode === 'scan'
            ? 'The Attendance module is enabled, so residents can scan in at the gate — the code rotates every 20 seconds and the previous one still works, so a queue is not punished for being slow. The register below still overrides a scan.'
            : 'The Attendance module is not enabled for this institution, so this is a manual register. Everything on this page works either way; only the gate screen is missing.',
      },
      {
        kind: 'figures',
        figures: [
          { label: 'Present', value: String(data.present ?? 0), tone: 'clear' },
          {
            label: 'Absent',
            value: String(data.absent ?? 0),
            tone: Number(data.absent ?? 0) > 0 ? 'due' : undefined,
          },
          { label: 'On leave', value: String(data.onLeave ?? 0) },
          {
            label: 'Not yet marked',
            value: String(data.unmarked ?? 0),
            tone: Number(data.unmarked ?? 0) > 0 ? 'due' : 'clear',
          },
        ],
      },
      {
        kind: 'table',
        rows: 'rows',
        empty: 'Nobody is resident in this block tonight.',
        columns: [
          { key: 'roomNumber', label: 'Room', kind: 'code' },
          { key: 'who', label: 'Resident' },
          { key: 'state', label: 'Status', alertWhen: 'missing' },
          { key: 'method', label: 'How' },
          { key: 'note', label: 'Note' },
        ],
      },
      {
        kind: 'form',
        title: 'Mark a resident',
        note: 'A manual mark corrects a scan. A scan never overwrites one of these.',
        submit: 'Record',
        path: '/rollcall/mark',
        fields: [
          { name: 'blockId', kind: 'hidden', label: '', value: String(data.blockId ?? '') },
          { name: 'studentId', label: 'Resident', kind: 'select', options: 'residents' },
          {
            name: 'status',
            label: 'Status',
            kind: 'select',
            options: [
              { value: 'present', label: 'present' },
              { value: 'absent', label: 'absent' },
              { value: 'on_leave', label: 'on leave' },
            ],
          },
          { name: 'note', label: 'Note', optional: true },
        ],
      },
      {
        kind: 'form',
        title: 'Record leave',
        note:
          'Granted in advance, so an empty bed reads as expected rather than ' +
          'missing. Overlapping leave for one student is refused.',
        submit: 'Grant leave',
        path: '/leave',
        fields: [
          { name: 'studentId', label: 'Resident', kind: 'select', options: 'residents' },
          { name: 'fromOn', label: 'From', kind: 'date' },
          { name: 'toOn', label: 'To', kind: 'date', hint: 'Inclusive' },
          { name: 'reason', label: 'Reason' },
        ],
      },
    ],
  },

  {
    path: '/visitors',
    title: 'Visitors',
    menu: 'Visitors',
    roles: [...WARDEN],
    async load(actor, req) {
      const a = actor as Actor
      const blockId = param(req, 'blockId')
      const [blocks, inside, all] = await Promise.all([
        listBlocks(a),
        visitorLog(a, blockId, true),
        visitorLog(a, blockId),
      ])
      const row = (v: (typeof all)[number]) => ({
        ...v,
        in: v.enteredAt.slice(11, 16),
        out: v.exitedAt ? v.exitedAt.slice(11, 16) : 'still inside',
        here: !v.exitedAt,
      })
      return {
        inside: inside.map(row),
        all: all.map(row),
        count: inside.length,
        blockOptions: blocks.map((b) => ({ value: b.id, label: `${b.code} - ${b.name}` })),
        insideOptions: inside.map((v) => ({
          value: v.id,
          label: `${v.name} - in at ${v.enteredAt.slice(11, 16)}`,
        })),
      }
    },
    sections: (data) => [
      {
        kind: 'note',
        text:
          `${data.count} still inside. A log, not an approval queue — what the gate ` +
          `needs at 21:40 is a record of who came and whether they have left.`,
      },
      {
        kind: 'table',
        title: 'Inside now',
        rows: 'inside',
        empty: 'Nobody signed in.',
        columns: [
          { key: 'name', label: 'Visitor' },
          { key: 'relation', label: 'Relation' },
          { key: 'studentName', label: 'For' },
          { key: 'in', label: 'In' },
          { key: 'out', label: 'Out', alertWhen: 'here' },
        ],
      },
      {
        kind: 'form',
        title: 'Sign in',
        submit: 'Sign in',
        path: '/visitors',
        fields: [
          { name: 'blockId', label: 'Block', kind: 'select', options: 'blockOptions' },
          { name: 'name', label: 'Visitor name' },
          { name: 'phone', label: 'Phone', optional: true },
          { name: 'relation', label: 'Relation', optional: true },
          { name: 'studentId', label: 'Visiting (student)', optional: true },
          { name: 'purpose', label: 'Purpose', optional: true },
        ],
      },
      {
        kind: 'form',
        title: 'Sign out',
        submit: 'Sign out',
        path: '/visitors/out',
        fields: [
          { name: 'visitorId', label: 'Visitor', kind: 'select', options: 'insideOptions' },
        ],
      },
      {
        kind: 'table',
        title: 'Recent',
        rows: 'all',
        empty: 'Nothing recorded.',
        columns: [
          { key: 'name', label: 'Visitor' },
          { key: 'studentName', label: 'For' },
          { key: 'in', label: 'In' },
          { key: 'out', label: 'Out' },
        ],
      },
    ],
  },

  {
    path: '/me',
    title: 'My hostel',
    menu: 'My hostel',
    roles: ['student'],
    async load(actor) {
      const a = actor as Actor
      const s = await myHostel(a)
      return {
        allocated: s.allocated,
        block: s.blockName ? `${s.blockCode} — ${s.blockName}` : '-',
        room: s.roomNumber ?? '-',
        floor: String(s.floor ?? 0),
        roommates: s.roommates.map((r) => r.name).filter(Boolean).join(', '),
        nights: s.recentNights,
        leave: s.upcomingLeave,
      }
    },
    sections: (data) =>
      data.allocated
        ? [
            {
              kind: 'figures',
              figures: [
                { label: 'Block', value: String(data.block) },
                { label: 'Room', value: String(data.room) },
                { label: 'Floor', value: String(data.floor) },
              ],
            },
            ...(data.roommates
              ? [{ kind: 'note' as const, text: `Sharing with ${String(data.roommates)}.` }]
              : []),
            {
              kind: 'table',
              title: 'Leave on record',
              rows: 'leave',
              empty: 'None.',
              columns: [
                { key: 'fromOn', label: 'From', kind: 'date' },
                { key: 'toOn', label: 'To', kind: 'date' },
                { key: 'reason', label: 'Reason' },
              ],
            },
            {
              kind: 'table',
              title: 'Recent nights',
              rows: 'nights',
              empty: 'Nothing recorded yet.',
              columns: [
                { key: 'onNight', label: 'Night', kind: 'date' },
                { key: 'status', label: 'Status' },
                { key: 'method', label: 'How' },
              ],
            },
          ]
        : [
            {
              kind: 'note',
              text:
                'No room is allocated to you. The hostel office allocates beds; ' +
                'this page fills in once yours is.',
            },
          ],
  },
]
