import { formatPaise } from '@campusos/money'
import { flag, param, type PluginPage } from '@campusos/module-framework'
import { childOverview, listLinks, myChildren, type Actor } from './api'

const ADMIN = ['institution_admin', 'super_admin'] as const

export const pages: PluginPage[] = [
  {
    path: '/',
    title: 'My children',
    menu: 'My children',
    roles: ['parent'],
    async load(actor, req) {
      const a = actor as Actor
      const claims = await myChildren(a)
      const verified = claims.filter((c) => c.verifiedAt)
      const wanted = param(req, 'studentId')
      const chosen = verified.find((c) => c.studentId === wanted) ?? verified[0]
      const child = chosen ? await childOverview(a, chosen.studentId) : null

      return {
        waiting: claims.length > 0 && verified.length === 0,
        refused: claims.find((c) => c.refusedReason)?.refusedReason ?? null,
        children: verified.map((c) => ({
          label: c.studentName ?? c.studentEmail ?? c.studentId,
          href: `/m/parents?studentId=${c.studentId}`,
          active: c.studentId === chosen?.studentId,
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
          { key: 'state', label: 'Status', alertWhen: 'waiting' },
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
          { key: 'state', label: 'Status' },
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
]
