import { formatPaise } from '@campusos/money'
import { param, type PluginPage } from '@campusos/module-framework'
import {
  casePage,
  feeChoices,
  getPolicy,
  listBlocks,
  listCases,
  listPasses,
  listRooms,
  listScopes,
  listWindows,
  myHostel,
  rollCall,
  visitorLog,
  visitorPage,
  type Actor,
} from './api'

const WARDEN = ['institution_admin', 'super_admin', 'hostel_staff'] as const
const ADMIN = ['institution_admin', 'super_admin'] as const

export const pages: PluginPage[] = [
  {
    path: '/',
    title: 'Hostel',
    menu: 'Rooms',
    roles: [...WARDEN],
    async load(actor, req) {
      const a = actor as Actor
      const blockId = param(req, 'blockId')
      const [blocks, rooms, fees] = await Promise.all([listBlocks(a), listRooms(a, blockId), feeChoices(a)])
      return {
        feesOn: fees.on,
        termOptions: fees.terms,
        rooms: rooms.map((r) => ({
          ...r,
          room: `${r.blockCode}-${r.number}`,
          free: r.capacity - r.occupied,
          fee: r.termFeePaise === null ? '-' : formatPaise(r.termFeePaise),
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
          { key: 'fee', label: 'Fee a term' },
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
      ...(data.feesOn
        ? [
            {
              kind: 'form' as const,
              title: 'Set the room fee',
              note:
                'The fee for one bed for one term, charged to the student\'s fee account: on ' +
                'allocation for the rest of that term, and by "Charge residents" for the terms after. ' +
                'Leave the beds empty to set every room of the block. Leave the fee empty to stop charging.',
              submit: 'Set fee',
              path: '/rooms/fee',
              roles: [...ADMIN],
              fields: [
                { name: 'blockId', label: 'Block', kind: 'select' as const, options: 'blockOptions' },
                { name: 'capacity', label: 'Only rooms with this many beds', kind: 'number' as const, optional: true },
                { name: 'termFee', label: 'Fee a term', kind: 'money' as const, optional: true, hint: 'Rupees.' },
                { name: 'reason', label: 'Reason' },
              ],
            },
            {
              kind: 'form' as const,
              title: 'Charge residents for a term',
              note:
                'Charges everyone living in a priced room during the term who has no charge for it yet, ' +
                'for the nights inside the term. Billed on the next invoice. Safe to run again.',
              submit: 'Charge',
              path: '/charges',
              roles: [...ADMIN],
              fields: [{ name: 'termId', label: 'Term', kind: 'select' as const, options: 'termOptions' }],
            },
          ]
        : []),
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
          { key: 'state', label: 'Status', kind: 'status', alertWhen: 'missing' },
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
        // Everyone inside: bounded by the building, not by the years of the log.
        visitorLog(a, blockId, true, visitorPage(new Request('https://x/?n=500'), '')).then((p) => p.rows),
        visitorLog(a, blockId, false, visitorPage(req, 'all')),
      ])
      const row = (v: (typeof all.rows)[number]) => ({
        ...v,
        in: v.enteredAt.slice(11, 16),
        out: v.exitedAt ? v.exitedAt.slice(11, 16) : 'still inside',
        here: !v.exitedAt,
      })
      return {
        inside: inside.map(row),
        all: all.rows.map(row),
        allPage: { total: all.total, next: all.next },
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
        paging: { data: 'allPage', sorts: ['entered'] },
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
    path: '/presence',
    title: 'Curfew cases',
    menu: 'Curfew cases',
    roles: [...WARDEN],
    async load(actor, req) {
      const a = actor as Actor
      const [open, closed] = await Promise.all([
        listCases(a, { resolved: false }, casePage(req, 'open')),
        listCases(a, { resolved: true }, casePage(req, 'done')),
      ])
      const row = (c: (typeof open.rows)[number]) => ({
        ...c,
        curfewAt: c.curfewAt.toISOString(),
        openedAt: c.openedAt.toISOString(),
        steps: [c.nudgeAt ? 'nudged' : '', c.wardenAt ? 'warden told' : '', c.guardianAt ? 'guardians told' : ''].filter(Boolean).join(', ') || '-',
        resolvedAt: c.resolvedAt ? c.resolvedAt.toISOString() : null,
        how: c.resolution ? c.resolution.replace(/_/g, ' ') : '',
        open: !c.resolvedAt,
      })
      return {
        open: open.rows.map(row),
        openPage: { total: open.total, next: open.next },
        done: closed.rows.map(row),
        donePage: { total: closed.total, next: closed.next },
        count: open.total,
        caseOptions: open.rows.map((c) => ({ value: c.id, label: `${c.name} (${c.blockCode}), night ${c.night}` })),
      }
    },
    sections: (data) => [
      {
        kind: 'note',
        text:
          'A case opens when a resident has not checked in after curfew and nothing accounts for them (a check-in, leave, a late-stay pass, or, with consent, the library or a class). ' +
          'The resident is nudged first, then the floor warden, then guardians (with consent) and the block and chief wardens.',
      },
      { kind: 'figures', figures: [{ label: 'Open cases', value: String(data.count), tone: Number(data.count) > 0 ? 'due' : 'clear' }] },
      {
        kind: 'table',
        title: 'Open',
        rows: 'open',
        paging: { data: 'openPage', sorts: ['opened'] },
        empty: 'No open cases.',
        columns: [
          { key: 'name', label: 'Resident' },
          { key: 'blockCode', label: 'Block', kind: 'code' },
          { key: 'night', label: 'Night', kind: 'date' },
          { key: 'curfewAt', label: 'Curfew', kind: 'when' },
          { key: 'steps', label: 'So far', alertWhen: 'open' },
        ],
      },
      {
        kind: 'form',
        title: 'Resolve a case',
        note: 'Verified in person, or closed with a note. Audited.',
        submit: 'Resolve',
        path: '/presence/cases/resolve',
        fields: [
          { name: 'caseId', label: 'Case', kind: 'select', options: 'caseOptions' },
          {
            name: 'resolution',
            label: 'Outcome',
            kind: 'select',
            options: [
              { value: 'warden_verified', label: 'verified in person' },
              { value: 'warden_closed', label: 'closed with a note' },
            ],
          },
          { name: 'note', label: 'Note', optional: true, hint: 'Required when closing; 5 to 300 characters' },
        ],
      },
      {
        kind: 'table',
        title: 'Resolved',
        rows: 'done',
        paging: { data: 'donePage', sorts: ['opened'] },
        empty: 'Nothing resolved yet.',
        columns: [
          { key: 'name', label: 'Resident' },
          { key: 'night', label: 'Night', kind: 'date' },
          { key: 'how', label: 'Resolved by' },
          { key: 'note', label: 'Note' },
        ],
      },
    ],
  },

  {
    path: '/late-stay',
    title: 'Late stay',
    menu: 'Late stay',
    roles: [...WARDEN, 'student'],
    async load(actor) {
      const a = actor as Actor
      const student = a.role === 'student'
      const [passes, windows, blocks] = await Promise.all([
        listPasses(a),
        student ? Promise.resolve([]) : listWindows(a),
        student ? Promise.resolve([]) : listBlocks(a),
      ])
      const rows = passes as { id: string; name: string; night: string; untilAt: Date | string; reason: string; status: string }[]
      return {
        student,
        passes: rows.map((p) => ({ ...p, untilAt: new Date(p.untilAt).toISOString() })),
        windows: windows as Record<string, unknown>[],
        blockOptions: [{ value: '', label: 'all blocks' }, ...blocks.map((b) => ({ value: b.id, label: `${b.code} - ${b.name}` }))],
        windowOptions: (windows as { id: string; fromOn: string; toOn: string; untilTime: string; cancelledAt: unknown }[])
          .filter((w) => !w.cancelledAt)
          .map((w) => ({ value: w.id, label: `${w.fromOn} to ${w.toOn}, until ${w.untilTime.slice(0, 5)}` })),
        pendingOptions: rows
          .filter((p) => p.status === 'requested')
          .map((p) => ({ value: p.id, label: `${p.name}, night ${p.night}, until ${new Date(p.untilAt).toISOString().slice(11, 16)} UTC` })),
      }
    },
    sections: (data) =>
      data.student
        ? [
            {
              kind: 'note',
              text: 'Ask for a late-stay pass for tonight. A warden approves it; nothing is automatic. Your curfew alerts start from the end of an approved pass.',
            },
            {
              kind: 'form',
              title: 'Ask for a pass',
              submit: 'Ask',
              path: '/late-stay/passes',
              fields: [
                { name: 'untilTime', label: 'Back by (HH:MM)', hint: 'e.g. 23:30' },
                { name: 'nextDay', label: 'That time is after midnight', kind: 'checkbox', optional: true },
                { name: 'reason', label: 'Reason' },
              ],
            },
            {
              kind: 'table',
              title: 'My passes',
              rows: 'passes',
              empty: 'None.',
              columns: [
                { key: 'night', label: 'Night', kind: 'date' },
                { key: 'untilAt', label: 'Until', kind: 'when' },
                { key: 'status', label: 'Status', kind: 'status' },
                { key: 'reason', label: 'Reason' },
              ],
            },
          ]
        : [
            {
              kind: 'note',
              text: 'A window moves curfew for a block, or all blocks, on given nights: exam week. Administrators and chief wardens set them. A resident asks for a pass for one night, and a warden decides.',
            },
            {
              kind: 'table',
              title: 'Windows',
              rows: 'windows',
              empty: 'None.',
              columns: [
                { key: 'blockCode', label: 'Block' },
                { key: 'fromOn', label: 'From', kind: 'date' },
                { key: 'toOn', label: 'To', kind: 'date' },
                { key: 'untilTime', label: 'Curfew moves to' },
                { key: 'reason', label: 'Reason' },
              ],
            },
            {
              kind: 'form',
              title: 'Add a window',
              submit: 'Add',
              path: '/late-stay/windows',
              fields: [
                { name: 'blockId', label: 'Block', kind: 'select', options: 'blockOptions', optional: true },
                { name: 'fromOn', label: 'From', kind: 'date' },
                { name: 'toOn', label: 'To', kind: 'date', hint: 'Inclusive; at most 60 days' },
                { name: 'untilTime', label: 'Curfew moves to (HH:MM)', hint: '21:00 to 23:59' },
                { name: 'reason', label: 'Reason' },
              ],
            },
            {
              kind: 'form',
              title: 'Cancel a window',
              submit: 'Cancel',
              path: '/late-stay/windows/cancel',
              fields: [{ name: 'windowId', label: 'Window', kind: 'select', options: 'windowOptions' }],
            },
            {
              kind: 'table',
              title: 'Passes',
              rows: 'passes',
              empty: 'None.',
              columns: [
                { key: 'name', label: 'Resident' },
                { key: 'night', label: 'Night', kind: 'date' },
                { key: 'untilAt', label: 'Until', kind: 'when' },
                { key: 'status', label: 'Status', kind: 'status' },
                { key: 'reason', label: 'Reason' },
              ],
            },
            {
              kind: 'form',
              title: 'Decide a pass',
              submit: 'Decide',
              path: '/late-stay/passes/decide',
              fields: [
                { name: 'passId', label: 'Pass', kind: 'select', options: 'pendingOptions' },
                {
                  name: 'decision',
                  label: 'Decision',
                  kind: 'select',
                  options: [
                    { value: 'approved', label: 'approve' },
                    { value: 'refused', label: 'refuse' },
                  ],
                },
              ],
            },
          ],
  },

  {
    path: '/wardens',
    title: 'Wardens and curfew',
    menu: 'Wardens',
    roles: [...ADMIN],
    async load(actor) {
      const a = actor as Actor
      const [scopes, policy, blocks] = await Promise.all([listScopes(a), getPolicy(a), listBlocks(a)])
      const t = (v: string) => v.slice(0, 5)
      return {
        scopes: scopes.map((s) => ({ ...s, where: s.blockCode ? (s.floor != null ? `${s.blockCode}, floor ${s.floor}` : s.blockCode) : 'all' })),
        scopeOptions: scopes.map((s) => ({ value: s.id, label: `${s.name}: ${s.level}${s.blockCode ? ' ' + s.blockCode : ''}${s.floor != null ? ' floor ' + s.floor : ''}` })),
        blockOptions: blocks.map((b) => ({ value: b.id, label: `${b.code} - ${b.name}` })),
        blockCurfews: blocks.map((b) => ({ code: b.code, name: b.name })),
        policy: {
          curfewTime: t(policy.curfewTime),
          nudgeAfterMin: String(policy.nudgeAfterMin),
          wardenAfterMin: String(policy.wardenAfterMin),
          womensWardenAfterMin: String(policy.womensWardenAfterMin),
          guardianAfterMin: String(policy.guardianAfterMin),
          walkBackMin: String(policy.walkBackMin),
          caseWindowHours: String(policy.caseWindowHours),
          latePassLatestTime: t(policy.latePassLatestTime),
          presenceRetentionDays: String(policy.presenceRetentionDays),
          notifyWardenOnLibraryEntry: policy.notifyWardenOnLibraryEntry ? 'true' : 'false',
        },
      }
    },
    sections: (data) => {
      const p = data.policy as Record<string, string>
      return [
        {
          kind: 'note',
          text: 'Scopes name who is told about which residents. Until the warden portal arrives they decide only who receives alerts; they do not yet limit what a warden can see.',
        },
        {
          kind: 'table',
          title: 'Scopes',
          rows: 'scopes',
          empty: 'No scopes: every hostel staff member is told, then the administrators.',
          columns: [
            { key: 'name', label: 'Warden' },
            { key: 'level', label: 'Level', kind: 'status' },
            { key: 'where', label: 'Where' },
          ],
        },
        {
          kind: 'form',
          title: 'Add a scope',
          note: 'Floor needs a block and a floor; block needs a block; chief and estate need neither. The person must be hostel staff.',
          submit: 'Add',
          path: '/scopes',
          fields: [
            { name: 'userId', label: 'Warden', hint: 'Their user id' },
            {
              name: 'level',
              label: 'Level',
              kind: 'select',
              options: [
                { value: 'floor', label: 'floor' },
                { value: 'block', label: 'block' },
                { value: 'chief', label: 'chief' },
                { value: 'estate', label: 'estate' },
              ],
            },
            { name: 'blockId', label: 'Block', kind: 'select', options: 'blockOptions', optional: true },
            { name: 'floor', label: 'Floor', kind: 'number', optional: true },
          ],
        },
        {
          kind: 'form',
          title: 'Remove a scope',
          submit: 'Remove',
          path: '/scopes/remove',
          fields: [{ name: 'scopeId', label: 'Scope', kind: 'select', options: 'scopeOptions' }],
        },
        {
          kind: 'form',
          title: 'Curfew and ladder',
          note: 'Minutes count from the effective curfew. Library and class status counts only for residents whose hostel presence consent is given.',
          submit: 'Save',
          path: '/policy',
          method: 'PUT',
          fields: [
            { name: 'curfewTime', label: 'Curfew (HH:MM)', value: p.curfewTime },
            { name: 'nudgeAfterMin', label: 'Nudge the resident after (minutes)', kind: 'number', value: p.nudgeAfterMin },
            { name: 'wardenAfterMin', label: 'Tell the floor warden after', kind: 'number', value: p.wardenAfterMin },
            { name: 'womensWardenAfterMin', label: "Tell the floor warden in a women's block after", kind: 'number', value: p.womensWardenAfterMin },
            { name: 'guardianAfterMin', label: 'Tell guardians and chief wardens after', kind: 'number', value: p.guardianAfterMin },
            { name: 'walkBackMin', label: 'Library exit counts for (minutes)', kind: 'number', value: p.walkBackMin },
            { name: 'caseWindowHours', label: 'Cases open for (hours after curfew)', kind: 'number', value: p.caseWindowHours },
            { name: 'latePassLatestTime', label: 'Latest late pass (next day, HH:MM)', value: p.latePassLatestTime },
            { name: 'presenceRetentionDays', label: 'Keep presence history (days)', kind: 'number', value: p.presenceRetentionDays },
            { name: 'notifyWardenOnLibraryEntry', label: 'Tell the floor warden on every library entry', kind: 'select', options: [{ value: 'false', label: 'no' }, { value: 'true', label: 'yes' }], value: p.notifyWardenOnLibraryEntry },
            { name: 'reason', label: 'Reason' },
          ],
        },
        {
          kind: 'form',
          title: 'A block\'s own curfew',
          submit: 'Set',
          path: '/blocks/curfew',
          fields: [
            { name: 'blockId', label: 'Block', kind: 'select', options: 'blockOptions' },
            { name: 'curfewTime', label: 'Curfew (HH:MM)' },
          ],
        },
      ]
    },
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
        presence: s.presence ? s.presence.label : '',
        sharing: s.presence ? (s.presence.sharing ? 'on' : 'off') : '',
        notice: s.policyNotice,
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
              kind: 'figures' as const,
              title: 'Presence',
              figures: [
                { label: 'Where the hostel thinks you are', value: String(data.presence || 'Unknown') },
                { label: 'Library and class status shared', value: String(data.sharing || 'off') },
              ],
            },
            { kind: 'note' as const, text: String(data.notice) },
            { kind: 'links' as const, links: [{ label: 'Ask for a late-stay pass', href: '/m/hostel/late-stay' }] },
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
                { key: 'status', label: 'Status', kind: 'status' },
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
