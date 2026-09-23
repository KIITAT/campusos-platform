import { param, type PluginPage } from '@campusos/module-framework'
import {
  certificateView,
  checkinBoard,
  listCandidates,
  listCeremonies,
  listCertificates,
  listHolds,
  myGraduation,
  programChoices,
  type Actor,
} from './api'

const OFFICE = ['institution_admin', 'super_admin'] as const
const READERS = ['institution_admin', 'super_admin', 'hod'] as const
const MARSHALS = ['institution_admin', 'super_admin', 'hod', 'faculty'] as const
const PDF = '/api/v1/modules/ceremonies/certificate.pdf?certificateId='

const next: Record<string, { value: string; label: string }[]> = {
  planning: [{ value: 'open', label: 'open for replies' }],
  open: [{ value: 'held', label: 'held' }],
  held: [{ value: 'closed', label: 'closed' }],
  closed: [],
}

export const pages: PluginPage[] = [
  {
    path: '/',
    title: 'Ceremonies',
    menu: 'Ceremonies',
    roles: [...READERS],
    async load(actor) {
      const a = actor as Actor
      const [rows, progs] = await Promise.all([
        listCeremonies(a),
        a.role === 'hod' ? Promise.resolve([]) : programChoices(a),
      ])
      return {
        ceremonies: rows,
        programOptions: progs.map((p) => ({ value: p.id, label: `${p.code} - ${p.name}` })),
        totals: {
          upcoming: rows.filter((r) => r.status === 'planning' || r.status === 'open').length,
          cleared: rows.reduce((n, r) => n + r.eligible, 0),
          issued: rows.reduce((n, r) => n + r.issued, 0),
        },
      }
    },
    sections: (data) => {
      const t = data.totals as { upcoming: number; cleared: number; issued: number }
      return [
        {
          kind: 'figures',
          figures: [
            { label: 'Upcoming ceremonies', value: String(t.upcoming) },
            { label: 'Cleared to graduate', value: String(t.cleared), hint: 'by the degree audit' },
            { label: 'Certificates issued', value: String(t.issued) },
          ],
        },
        {
          kind: 'table',
          title: 'Ceremonies',
          rows: 'ceremonies',
          empty: 'No ceremony planned yet.',
          columns: [
            { key: 'name', label: 'Ceremony', href: '/m/ceremonies/ceremony?ceremonyId={id}' },
            { key: 'heldOn', label: 'On', kind: 'date' },
            { key: 'venue', label: 'Venue' },
            { key: 'status', label: 'Status', kind: 'status' },
            { key: 'candidates', label: 'On the list' },
            { key: 'eligible', label: 'Cleared' },
            { key: 'issued', label: 'Issued' },
          ],
        },
        {
          kind: 'form',
          title: 'Plan a ceremony',
          note: 'Leave the programme empty for a ceremony every programme graduates at.',
          submit: 'Plan',
          path: '/ceremonies',
          roles: [...OFFICE],
          fields: [
            { name: 'name', label: 'Name', hint: 'e.g. Twelfth Convocation' },
            { name: 'heldOn', label: 'On', kind: 'date' },
            { name: 'venue', label: 'Venue', optional: true },
            { name: 'rsvpClosesOn', label: 'Replies close', kind: 'date', optional: true },
            { name: 'programIds', label: 'Programme', kind: 'select', options: 'programOptions', optional: true },
            { name: 'guestLimit', label: 'Guests each', kind: 'number', value: '2' },
          ],
        },
      ]
    },
  },

  {
    path: '/ceremony',
    title: 'Ceremony',
    roles: [...READERS],
    async load(actor, req) {
      const a = actor as Actor
      const ceremonyId = param(req, 'ceremonyId')
      const all = await listCeremonies(a)
      const c = all.find((x) => x.id === ceremonyId) ?? null
      if (!c) return { ceremony: null, candidates: [], holds: [], certificates: [] }
      const [cands, hs, certs] = await Promise.all([
        listCandidates(a, c.id),
        listHolds(a, c.id),
        listCertificates(a, c.id),
      ])
      return {
        ceremony: c,
        ceremonyId: c.id,
        candidates: cands.map((x) => ({
          ...x,
          name: x.name ?? x.email,
          credits: x.creditsRequired ? `${x.creditsEarned} / ${x.creditsRequired}` : String(x.creditsEarned),
          reply: x.attendance ? `${x.attendance.replace('_', ' ')}${x.guests ? `, ${x.guests} guests` : ''}` : '',
        })),
        holds: hs.map((h) => ({ ...h, open: !h.clearedAt })),
        certificates: certs,
        statusOptions: next[c.status] ?? [],
        candidateOptions: cands.map((x) => ({ value: x.id, label: `${x.name ?? x.email} (${x.programCode})` })),
        openHoldOptions: hs.filter((h) => !h.clearedAt).map((h) => ({ value: h.id, label: `${h.name}: ${h.reason}` })),
        figures: {
          listed: cands.length,
          cleared: cands.filter((x) => x.eligible).length,
          held: cands.filter((x) => x.stage === 'held').length,
          issued: cands.filter((x) => x.stage === 'issued').length,
          attending: cands.filter((x) => x.attendance === 'in_person').length,
          guests: cands.reduce((n, x) => n + (x.attendance === 'in_person' ? x.guests : 0), 0),
          checkedIn: cands.filter((x) => x.checkedInAt).length,
        },
      }
    },
    record: (data) => {
      const c = data.ceremony as Awaited<ReturnType<typeof listCeremonies>>[number] | null
      if (typeof c?.id !== 'string') return null
      return {
        title: c.name,
        subtitle: [c.heldOn, c.venue].filter(Boolean).join(' at '),
        status: { label: c.status },
        fields: [
          { label: 'On', value: c.heldOn, kind: 'date' },
          { label: 'Venue', value: c.venue },
        ],
      }
    },
    sections: (data) => {
      if (typeof (data.ceremony as { id?: unknown } | null)?.id !== 'string') {
        return [{ kind: 'note', tone: 'warn', text: 'No such ceremony. Pick one from the list.' }]
      }
      const f = data.figures as Record<string, number>
      return [
        {
          kind: 'figures',
          figures: [
            { label: 'On the list', value: String(f.listed) },
            { label: 'Cleared', value: String(f.cleared), tone: 'clear' },
            { label: 'On hold', value: String(f.held), tone: f.held ? 'due' : undefined },
            { label: 'Issued', value: String(f.issued) },
            { label: 'Attending', value: String(f.attending), hint: `${f.guests} guests` },
            { label: 'Checked in', value: String(f.checkedIn) },
          ],
        },
        {
          kind: 'table',
          title: 'Graduands',
          note: 'Found by the degree audit, not typed in. Run eligibility again to refresh after any grade changes.',
          rows: 'candidates',
          empty: 'Nobody yet: run eligibility.',
          pageSize: 50,
          bulk: [
            {
              label: 'Issue certificates',
              path: '/certificates/issue',
              idKey: 'id',
              field: 'candidateIds',
              roles: [...OFFICE],
              fields: [{ name: 'ceremonyId', label: '', kind: 'hidden', value: data.ceremonyId as string }],
            },
          ],
          columns: [
            { key: 'name', label: 'Graduand' },
            { key: 'programCode', label: 'Programme', kind: 'code' },
            { key: 'credits', label: 'Credits' },
            { key: 'cgpa', label: 'CGPA' },
            { key: 'stage', label: 'Stage', kind: 'status' },
            { key: 'shortOf', label: 'Short of' },
            { key: 'reply', label: 'Reply' },
            { key: 'checkedInAt', label: 'Checked in', kind: 'when' },
            { key: 'serial', label: 'Certificate', kind: 'code', href: '/m/ceremonies/certificate?certificateId={certificateId}' },
          ],
        },
        {
          kind: 'table',
          title: 'Holds',
          rows: 'holds',
          empty: 'Nobody held back.',
          columns: [
            { key: 'name', label: 'Graduand' },
            { key: 'reason', label: 'Reason', alertWhen: 'open' },
            { key: 'placedAt', label: 'Placed', kind: 'when' },
            { key: 'clearedAt', label: 'Cleared', kind: 'when' },
            { key: 'clearReason', label: 'Why cleared' },
          ],
        },
        {
          kind: 'table',
          title: 'Certificates',
          rows: 'certificates',
          empty: 'None issued.',
          columns: [
            { key: 'serial', label: 'Serial', kind: 'code', href: '/m/ceremonies/certificate?certificateId={id}' },
            { key: 'studentName', label: 'Name' },
            { key: 'programCode', label: 'Programme', kind: 'code' },
            { key: 'cgpa', label: 'CGPA' },
            { key: 'docstatus', label: 'Status', kind: 'status' },
            { key: 'cancelReason', label: 'Revoked because' },
          ],
        },
        {
          kind: 'form',
          title: 'Run eligibility',
          note: 'Audits every student reading a programme graduating here, and records what the audit found.',
          submit: 'Run the degree audit',
          path: '/ceremonies/eligibility',
          roles: [...OFFICE],
          placement: 'action',
          fields: [{ name: 'ceremonyId', label: '', kind: 'hidden', value: data.ceremonyId as string }],
        },
        {
          kind: 'form',
          title: 'Issue every cleared certificate',
          note: 'Each graduand is audited again as the certificate is issued. Anybody not cleared, or on hold, is skipped and named.',
          submit: 'Issue',
          path: '/certificates/issue',
          roles: [...OFFICE],
          placement: 'action',
          fields: [{ name: 'ceremonyId', label: '', kind: 'hidden', value: data.ceremonyId as string }],
        },
        {
          kind: 'form',
          title: 'Move the ceremony forward',
          note: 'Planning, open for replies, held, closed. Never back.',
          submit: 'Move',
          path: '/ceremonies/status',
          roles: [...OFFICE],
          placement: 'action',
          fields: [
            { name: 'ceremonyId', label: '', kind: 'hidden', value: data.ceremonyId as string },
            { name: 'status', label: 'To', kind: 'select', options: 'statusOptions' },
          ],
        },
        {
          kind: 'form',
          title: 'Hold somebody back',
          note: 'Audited. No certificate is issued while a hold is open.',
          submit: 'Hold',
          path: '/holds',
          roles: [...OFFICE],
          placement: 'action',
          fields: [
            { name: 'candidateId', label: 'Graduand', kind: 'select', options: 'candidateOptions' },
            { name: 'reason', label: 'Reason', hint: 'e.g. library books not returned' },
          ],
        },
        {
          kind: 'form',
          title: 'Clear a hold',
          submit: 'Clear',
          path: '/holds/clear',
          roles: [...OFFICE],
          placement: 'action',
          fields: [
            { name: 'holdId', label: 'Hold', kind: 'select', options: 'openHoldOptions' },
            { name: 'reason', label: 'Why it is cleared' },
          ],
        },
      ]
    },
  },

  {
    path: '/certificate',
    title: 'Certificate',
    roles: [...READERS, 'student'],
    async load(actor, req) {
      const id = param(req, 'certificateId')
      const c = id ? await certificateView(actor as Actor, id) : null
      return { c }
    },
    record: (data) => {
      const c = data.c as Awaited<ReturnType<typeof certificateView>> | null
      if (typeof c?.id !== 'string') return null
      return {
        title: c.serial,
        subtitle: `${c.studentName}, ${c.programName}`,
        fields: [
          { label: 'Graduand', value: c.studentName },
          { label: 'Programme', value: c.programName },
          { label: 'Conferred on', value: c.conferredOn, kind: 'date' },
          { label: 'Ceremony', value: c.ceremony },
          { label: 'CGPA', value: c.cgpa },
          { label: 'Credits', value: c.creditsEarned },
          { label: 'Verification code', value: c.verificationCode, kind: 'code' },
          { label: 'Revoked because', value: c.cancelReason },
        ],
        createdAt: c.createdAt.toISOString(),
        audit: { entity: 'ceremony_certificates', entityId: c.id },
        docStatus: {
          value: c.docstatus,
          id: c.id,
          idField: 'certificateId',
          cancel: '/certificates/revoke',
          amend: '/certificates/reissue',
          roles: [...OFFICE],
          labels: { cancel: 'Revoke', amend: 'Reissue' },
        },
      }
    },
    sections: (data) => {
      const c = data.c as Awaited<ReturnType<typeof certificateView>> | null
      if (typeof c?.id !== 'string') return [{ kind: 'note', tone: 'warn', text: 'No such certificate.' }]
      const links = [
        ...(c.docstatus === 'submitted' ? [{ label: 'Print the certificate', href: `${PDF}${c.id}` }] : []),
        ...(c.replaces ? [{ label: `Replaces ${c.replaces.serial}`, href: `/m/ceremonies/certificate?certificateId=${c.replaces.id}` }] : []),
        ...(c.replacedBy ? [{ label: `Replaced by ${c.replacedBy.serial}`, href: `/m/ceremonies/certificate?certificateId=${c.replacedBy.id}` }] : []),
      ]
      return [
        ...(c.docstatus === 'cancelled'
          ? [{ kind: 'note' as const, tone: 'danger' as const, text: `Revoked: ${c.cancelReason ?? ''}. It is not printed, and checking its code says so.` }]
          : []),
        ...(links.length ? [{ kind: 'links' as const, links }] : []),
        {
          kind: 'note',
          text:
            'Issued on the degree audit taken at that moment, which the certificate keeps. Revoking needs a reason; ' +
            'a revoked certificate is reissued under a new serial, after the audit is taken again.',
        },
      ]
    },
  },

  {
    path: '/checkin',
    title: 'Check-in',
    menu: 'Check-in',
    roles: [...MARSHALS],
    async load(actor) {
      const rows = await checkinBoard(actor as Actor)
      return {
        rows: rows.map((r) => ({
          ...r,
          in: !!r.checkedInAt,
          reply: r.attendance ? r.attendance.replace('_', ' ') : 'no reply',
        })),
        waitingOptions: rows
          .filter((r) => !r.checkedInAt)
          .map((r) => ({ value: r.id, label: `${r.name} (${r.programCode}) - ${r.ceremony}` })),
      }
    },
    sections: () => [
      {
        kind: 'form',
        title: 'Check somebody in',
        submit: 'Check in',
        path: '/checkin',
        placement: 'inline',
        fields: [{ name: 'candidateId', label: 'Graduand', kind: 'select', options: 'waitingOptions' }],
      },
      {
        kind: 'table',
        title: 'Graduands expected',
        rows: 'rows',
        empty: 'No ceremony is open or being held.',
        pageSize: 100,
        columns: [
          { key: 'name', label: 'Graduand' },
          { key: 'programCode', label: 'Programme', kind: 'code' },
          { key: 'ceremony', label: 'Ceremony' },
          { key: 'reply', label: 'Reply' },
          { key: 'guests', label: 'Guests' },
          { key: 'checkedInAt', label: 'In at', kind: 'when' },
        ],
      },
    ],
  },

  {
    path: '/me',
    title: 'My graduation',
    menu: 'My graduation',
    roles: ['student'],
    async load(actor) {
      const g = await myGraduation(actor as Actor)
      const open = g.ceremonies.find((c) => c.status === 'open' && c.eligible)
      return {
        ceremonies: g.ceremonies.map((c) => ({
          ...c,
          standing: c.holds > 0 ? 'held' : c.eligible ? 'cleared' : 'not_eligible',
          reply: c.attendance ? `${c.attendance.replace('_', ' ')}${c.guests ? `, ${c.guests} guests` : ''}` : '',
        })),
        certificates: g.certificates.map((c) => ({
          ...c,
          print: c.docstatus === 'submitted' ? 'print' : '',
        })),
        openId: open?.ceremonyId ?? '',
        openName: open?.ceremony ?? '',
        guestLimit: String(open?.guestLimit ?? 0),
      }
    },
    sections: (data) => [
      {
        kind: 'note',
        text:
          'You are on a ceremony list when you read a programme graduating at it, and cleared when the degree audit ' +
          'says every requirement is met. If it says you are short, the office can show you the audit.',
      },
      {
        kind: 'table',
        title: 'Ceremonies',
        rows: 'ceremonies',
        empty: 'You are not on a ceremony list yet.',
        columns: [
          { key: 'ceremony', label: 'Ceremony' },
          { key: 'heldOn', label: 'On', kind: 'date' },
          { key: 'venue', label: 'Venue' },
          { key: 'standing', label: 'You are', kind: 'status' },
          { key: 'shortOf', label: 'Short of' },
          { key: 'reply', label: 'Your reply' },
          { key: 'rsvpClosesOn', label: 'Replies close', kind: 'date' },
        ],
      },
      ...(data.openId
        ? [
            {
              kind: 'form' as const,
              title: `Reply for ${String(data.openName)}`,
              note: `You may bring up to ${String(data.guestLimit)} guests. You can change your reply until replies close.`,
              submit: 'Send reply',
              path: '/respond',
              placement: 'inline' as const,
              fields: [
                { name: 'ceremonyId', label: '', kind: 'hidden' as const, value: data.openId as string },
                {
                  name: 'attendance',
                  label: 'Will you attend?',
                  kind: 'select' as const,
                  options: [
                    { value: 'in_person', label: 'Yes, in person' },
                    { value: 'in_absentia', label: 'No, confer it in my absence' },
                  ],
                },
                { name: 'guests', label: 'Guests', kind: 'number' as const, value: '0' },
              ],
            },
          ]
        : []),
      {
        kind: 'table',
        title: 'Certificates',
        rows: 'certificates',
        empty: 'None issued yet.',
        columns: [
          { key: 'serial', label: 'Serial', kind: 'code', href: '/m/ceremonies/certificate?certificateId={id}' },
          { key: 'programName', label: 'Programme' },
          { key: 'conferredOn', label: 'Conferred', kind: 'date' },
          { key: 'docstatus', label: 'Status', kind: 'status' },
          { key: 'print', label: 'Print', href: `${PDF}{id}` },
        ],
      },
    ],
  },
]
