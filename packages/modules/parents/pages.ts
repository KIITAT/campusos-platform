import { formatPaise } from '@campusos/money'
import { flag, param, type PluginPage } from '@campusos/module-framework'
import {
  childConsents,
  childOverview,
  listGuardianInvites,
  listLinks,
  myChildren,
  myGuardians,
  studentChoices,
  type Actor,
} from './api'

const ADMIN = ['institution_admin', 'super_admin'] as const

const PURPOSE_LABEL: Record<string, string> = { privacy_notice: 'Privacy notice', care_self_checks: 'Counselling self-checks', apaar: 'APAAR ID' }

export const pages: PluginPage[] = [
  {
    path: '/',
    title: 'My children',
    menu: 'My children',
    roles: ['parent'],
    async load(actor, req) {
      const a = actor as Actor
      const claims = await myChildren(a)
      const verified = claims.filter((c) => c.verifiedAt && !c.lapsed)
      const lapsed = claims.filter((c) => c.lapsed)
      const wanted = param(req, 'studentId')
      const chosen = verified.find((c) => c.studentId === wanted) ?? verified[0]
      const child = chosen ? await childOverview(a, chosen.studentId) : null
      // A choice is the guardian's for a student under 18; for an adult the link has lapsed and no row is read.
      const consents = chosen ? await childConsents(a, chosen.studentId).catch(() => []) : []

      return {
        waiting: claims.length > 0 && verified.length === 0 && lapsed.length === 0,
        lapsed: lapsed.map((c) => c.studentName ?? c.studentEmail ?? c.studentId),
        refused: claims.find((c) => c.refusedReason)?.refusedReason ?? null,
        children: verified.map((c) => ({
          label: c.studentName ?? c.studentEmail ?? c.studentId,
          href: `/m/parents?studentId=${c.studentId}`,
          active: c.studentId === chosen?.studentId,
        })),
        studentId: chosen?.studentId ?? null,
        consentRows: consents.map((c) => ({
          purpose: PURPOSE_LABEL[c.purpose] ?? c.purpose,
          decision: c.decision,
          basis: c.basis ? c.basis.replace(/_/g, ' ') : '',
          on: c.recordedAt ? c.recordedAt.toISOString().slice(0, 10) : '',
        })),
        name: child?.studentName ?? null,
        sections: child?.sections ?? [],
        grades: child?.results?.grades ?? [],
        provisional: child?.results?.provisional ?? false,
        gpa: child?.results?.gpa ?? null,
        attendance: child?.attendance?.marked ?? null,
        recent: child?.attendance?.recent ?? [],
        fees: child?.fees ?? null,
        library: child?.library ?? null,
        hostel: child?.hostel ?? null,
      }
    },
    sections: (data) => [
      { kind: 'links', title: 'Child', links: data.children as never },
      ...(((data.lapsed as string[]) ?? []).length > 0
        ? [
            {
              kind: 'note' as const,
              tone: 'warn' as const,
              text: `Your access ended when this student turned 18: ${(data.lapsed as string[]).join(', ')}. They can renew it from their own account.`,
            },
          ]
        : []),
      ...(data.waiting
        ? [
            {
              kind: 'note' as const,
              tone: 'warn' as const,
              text:
                'Your claim is with the institution. Nothing is visible until they ' +
                'have verified who you are — that check is the point of it.' +
                (data.refused ? ` One was refused: ${String(data.refused)}` : ''),
            },
          ]
        : []),
      ...(((data.sections as string[]) ?? []).length === 0 && !data.waiting
        ? [
            {
              kind: 'note' as const,
              text:
                'This institution has not enabled any of the modules this portal ' +
                'reads from, so there is nothing to show yet.',
            },
          ]
        : []),
      ...(data.fees
        ? [
            {
              kind: 'figures' as const,
              title: 'Fees',
              figures: [
                {
                  label: 'Payable',
                  value: formatPaise((data.fees as { payablePaise: number }).payablePaise),
                },
                {
                  label: 'Paid',
                  value: formatPaise((data.fees as { paidPaise: number }).paidPaise),
                },
                {
                  label: 'Outstanding',
                  value: formatPaise(
                    (data.fees as { outstandingPaise: number }).outstandingPaise,
                  ),
                  tone:
                    (data.fees as { outstandingPaise: number }).outstandingPaise > 0
                      ? ('due' as const)
                      : ('clear' as const),
                },
              ],
            },
          ]
        : []),
      ...(data.provisional
        ? [
            {
              kind: 'note' as const,
              tone: 'warn' as const,
              text:
                'Provisional: some courses have no published results yet, so these ' +
                'figures cover only what has been published.',
            },
          ]
        : []),
      ...(((data.grades as unknown[]) ?? []).length > 0
        ? [
            {
              kind: 'table' as const,
              title: data.gpa === null ? 'Results' : `Results — GPA ${data.gpa}`,
              rows: 'grades',
              columns: [
                { key: 'courseCode', label: 'Course', kind: 'code' as const },
                { key: 'courseTitle', label: 'Title' },
                { key: 'percent', label: '%' },
                { key: 'label', label: 'Grade' },
              ],
            },
          ]
        : []),
      ...(data.attendance !== null
        ? [
            {
              kind: 'table' as const,
              title: `Attendance — ${data.attendance} classes marked present`,
              rows: 'recent',
              empty: 'Nothing marked yet.',
              columns: [
                { key: 'courseCode', label: 'Course', kind: 'code' as const },
                { key: 'markedAt', label: 'When', kind: 'date' as const },
                { key: 'method', label: 'How' },
              ],
            },
          ]
        : []),
      ...(data.library
        ? [
            {
              kind: 'note' as const,
              text: `Library: ${(data.library as { openCount: number }).openCount} books out${
                (data.library as { overdue: number }).overdue > 0
                  ? `, ${(data.library as { overdue: number }).overdue} overdue`
                  : ''
              }.`,
            },
          ]
        : []),
      ...(data.hostel && (data.hostel as { allocated: boolean }).allocated
        ? [
            {
              kind: 'note' as const,
              text: `Hostel: room ${(data.hostel as { blockCode: string }).blockCode}-${
                (data.hostel as { roomNumber: string }).roomNumber
              }.`,
            },
          ]
        : []),
      ...(data.studentId
        ? [
            {
              kind: 'table' as const,
              title: 'Choices you have made for this child',
              rows: 'consentRows',
              empty: 'Nothing asked yet.',
              columns: [
                { key: 'purpose', label: 'For' },
                { key: 'decision', label: 'Decision' },
                { key: 'basis', label: 'Recorded as' },
                { key: 'on', label: 'On' },
              ],
            },
            {
              kind: 'form' as const,
              title: 'Give, refuse or withdraw a consent',
              note: 'A refusal of the APAAR ID removes any ID already saved. You can change your mind later.',
              submit: 'Record',
              path: '/consents',
              fields: [
                { name: 'studentId', label: '', kind: 'hidden' as const, value: String(data.studentId) },
                {
                  name: 'purpose',
                  label: 'For',
                  kind: 'radio' as const,
                  value: 'apaar',
                  options: Object.entries(PURPOSE_LABEL).map(([value, label]) => ({ value, label })),
                },
                {
                  name: 'decision',
                  label: 'Decision',
                  kind: 'radio' as const,
                  value: 'given',
                  options: [
                    { value: 'given', label: 'Give' },
                    { value: 'refused', label: 'Refuse' },
                    { value: 'withdrawn', label: 'Withdraw' },
                  ],
                },
              ],
            },
          ]
        : []),
      {
        kind: 'form',
        title: 'Add a child',
        note:
          'The institution verifies the link before anything appears. Ask the ' +
          'office for the student id if you do not have it.',
        submit: 'Claim',
        path: '/links',
        fields: [
          { name: 'studentId', label: 'Student' },
          { name: 'relation', label: 'Relation', hint: 'e.g. father, mother, guardian' },
        ],
      },
    ],
  },

  {
    path: '/access',
    title: 'Who can see my record',
    menu: 'Guardian access',
    roles: ['student'],
    async load(actor) {
      const rows = await myGuardians(actor as Actor)
      return {
        rows: rows.map((r) => ({
          linkId: r.linkId,
          who: r.parentName ?? r.parentEmail ?? r.linkId,
          relation: r.relation,
          state: r.lapsed ? 'ended at 18 until you renew it' : r.kept ? 'kept by you' : 'active',
        })),
        decidable: rows.filter((r) => r.adult).map((r) => ({ value: r.linkId, label: `${r.parentName ?? r.parentEmail ?? r.linkId} (${r.relation})` })),
      }
    },
    sections: (data) => [
      {
        kind: 'note' as const,
        text: 'When you turn 18 a parent or guardian can see your record only if you say so. Keep or end each one here.',
      },
      {
        kind: 'table' as const,
        title: 'Guardians linked to you',
        rows: 'rows',
        empty: 'No guardian is linked to you.',
        columns: [
          { key: 'who', label: 'Guardian' },
          { key: 'relation', label: 'Relation' },
          { key: 'state', label: 'Access' },
        ],
      },
      ...(((data.decidable as unknown[]) ?? []).length > 0
        ? [
            {
              kind: 'form' as const,
              title: 'Keep or end a guardian’s access',
              submit: 'Save',
              path: '/links/adult',
              fields: [
                { name: 'linkId', label: 'Guardian', kind: 'select' as const, options: 'decidable' },
                {
                  name: 'keep',
                  label: 'Access',
                  kind: 'radio' as const,
                  value: 'true',
                  options: [
                    { value: 'true', label: 'Keep' },
                    { value: 'false', label: 'End' },
                  ],
                },
              ],
            },
          ]
        : []),
    ],
  },

  {
    path: '/links',
    title: 'Parent links',
    menu: 'Parent links',
    roles: [...ADMIN],
    async load(actor, req) {
      const a = actor as Actor
      const [pending, all] = await Promise.all([
        listLinks(a, true),
        listLinks(a, flag(req, 'x') ? true : false),
      ])
      const row = (l: (typeof all)[number]) => ({
        ...l,
        parent: l.parentName ?? l.parentEmail,
        student: l.studentName ?? l.studentEmail,
        state: l.verifiedAt ? 'verified' : l.refusedReason ? 'refused' : 'awaiting',
        waiting: !l.verifiedAt && !l.refusedReason,
      })
      return {
        pending: pending.map(row),
        all: all.map(row),
        pendingOptions: pending.map((l) => ({
          value: l.id,
          label: `${l.parentName ?? l.parentEmail} - ${l.studentName ?? l.studentEmail} (${l.relation})`,
        })),
        verifiedOptions: all
          .filter((l) => l.verifiedAt)
          .map((l) => ({
            value: l.id,
            label: `${l.parentName ?? l.parentEmail} - ${l.studentName ?? l.studentEmail}`,
          })),
      }
    },
    sections: () => [
      {
        kind: 'note',
        text:
          'A claim shows a parent nothing until it is verified here, and verifying ' +
          'grants sight of a child’s attendance, results and fees — so it is ' +
          'audited either way.',
      },
      {
        kind: 'table',
        title: 'Awaiting verification',
        rows: 'pending',
        empty: 'Nothing waiting.',
        columns: [
          { key: 'parent', label: 'Parent' },
          { key: 'student', label: 'Student' },
          { key: 'relation', label: 'Relation' },
          { key: 'state', label: 'Status', kind: 'status', alertWhen: 'waiting' },
        ],
      },
      {
        kind: 'form',
        title: 'Decide',
        submit: 'Record decision',
        path: '/links/decide',
        fields: [
          { name: 'linkId', label: 'Claim', kind: 'select', options: 'pendingOptions' },
          {
            name: 'approve',
            label: 'Decision',
            kind: 'select',
            options: [
              { value: 'true', label: 'verify' },
              { value: 'false', label: 'refuse' },
            ],
          },
          { name: 'reason', label: 'Reason', hint: 'At least five characters' },
        ],
      },
      {
        kind: 'form',
        title: 'Register a link directly',
        note:
          'Registering it here counts as verifying it: the office has already ' +
          'checked who is standing in front of them.',
        submit: 'Register',
        path: '/links',
        fields: [
          { name: 'parentId', label: 'Parent' },
          { name: 'studentId', label: 'Student' },
          { name: 'relation', label: 'Relation' },
        ],
      },
      {
        kind: 'table',
        title: 'Everything on record',
        rows: 'all',
        empty: 'Nothing on record.',
        columns: [
          { key: 'parent', label: 'Parent' },
          { key: 'student', label: 'Student' },
          { key: 'state', label: 'Status', kind: 'status' },
          { key: 'refusedReason', label: 'Reason' },
        ],
      },
      {
        kind: 'form',
        title: 'Withdraw a link',
        note:
          'Sight is withdrawn immediately. Usually a custody or safeguarding ' +
          'decision, so the reason is part of the record.',
        submit: 'Withdraw',
        path: '/links/revoke',
        fields: [
          { name: 'linkId', label: 'Link', kind: 'select', options: 'verifiedOptions' },
          { name: 'reason', label: 'Reason' },
        ],
      },
    ],
  },

  {
    path: '/guardians',
    title: 'Guardians',
    menu: 'Guardians',
    roles: [...ADMIN],
    async load(actor) {
      const a = actor as Actor
      const [invites, students] = await Promise.all([listGuardianInvites(a), studentChoices(a)])
      return {
        invites: invites.map((i) => ({ ...i, open: i.state === 'open' })),
        studentOptions: students.map((s) => ({
          value: s.id,
          label: `${s.name ?? s.email} (${s.email})`,
        })),
        liveOptions: invites
          .filter((i) => i.state === 'open' || i.state === 'accepted')
          .map((i) => ({ value: i.id, label: `${i.email} (${i.state}): ${i.children}` })),
      }
    },
    sections: () => [
      {
        kind: 'note',
        text:
          'A guardian signs in at their own address, which the institution’s email domain ' +
          'would never admit. So the office names the address and the child, and sends the link ' +
          'it is given. Accepting it lets that address -- and only that address -- sign in, with ' +
          'Google or an emailed sign-in link; a forwarded link admits nobody else. The child is ' +
          'linked, already verified, the first time the guardian arrives.',
      },
      {
        kind: 'form',
        title: 'Invite a guardian',
        note: 'The link is shown once, after you submit. Inviting the same address again for another child sends one link covering both.',
        submit: 'Create invitation',
        path: '/guardians/invite',
        fields: [
          { name: 'email', label: 'Guardian’s email address' },
          { name: 'studentId', label: 'Child', kind: 'select', options: 'studentOptions' },
          { name: 'relation', label: 'Relation', hint: 'mother, father, guardian...' },
          { name: 'days', label: 'Days to accept', kind: 'number', value: '7', hint: '1 to 30' },
        ],
      },
      {
        kind: 'table',
        title: 'Invitations',
        rows: 'invites',
        empty: 'No guardians invited yet.',
        columns: [
          { key: 'email', label: 'Address' },
          { key: 'children', label: 'For' },
          { key: 'state', label: 'Status', kind: 'status' },
          { key: 'expiresAt', label: 'Accept by', kind: 'date', alertWhen: 'open' },
          { key: 'acceptedAt', label: 'Accepted', kind: 'when' },
          { key: 'signedIn', label: 'Signed in', kind: 'bool' },
          { key: 'revokeReason', label: 'Withdrawn because' },
        ],
      },
      {
        kind: 'form',
        title: 'Withdraw a guardian',
        note:
          'Before acceptance the link simply stops working. After, access ends now: the ' +
          'children are unlinked, the account is suspended and signed out. Audited.',
        submit: 'Withdraw',
        path: '/guardians/withdraw',
        fields: [
          { name: 'invitationId', label: 'Invitation', kind: 'select', options: 'liveOptions' },
          { name: 'reason', label: 'Reason', hint: 'At least five characters' },
        ],
      },
    ],
  },
]
