import { param, type PluginPage, type PluginField } from '@campusos/module-framework'
import {
  appraisalView,
  listAppraisals,
  listCycles,
  listGoals,
  listKras,
  listStaff,
  myAppraisals,
  type Actor,
} from './api'

const OFFICE = ['institution_admin', 'super_admin', 'accounts_staff'] as const
const ADMIN = ['institution_admin', 'super_admin'] as const
const EVERYONE = ['faculty', 'hod', 'institution_admin', 'super_admin', 'accounts_staff'] as const

const score = (c: number | null) => (c === null ? '' : (c / 100).toFixed(2))

type View = Awaited<ReturnType<typeof appraisalView>>

/** One rating field (and a comment) per KRA, which the API folds back into a list. */
const ratingFields = (v: View): PluginField[] =>
  v.lines.flatMap((l) => [
    { name: `rating:${l.kraId}`, label: `${l.name} (${l.weight}%), 1 to 5`, kind: 'number' as const },
    { name: `comment:${l.kraId}`, label: `${l.name}: comment`, optional: true },
  ])

export const performancePages: PluginPage[] = [
  {
    path: '/performance',
    title: 'Performance',
    menu: 'Performance',
    roles: [...OFFICE],
    async load(actor, req) {
      const a = actor as Actor
      const [cycles, kras, staff] = await Promise.all([listCycles(a), listKras(a), listStaff(a)])
      const cycleId = param(req, 'cycleId') ?? cycles.find((c) => c.status === 'open')?.id
      const rows = cycleId ? await listAppraisals(a, cycleId) : []
      return {
        cycles: cycles.map((c) => ({
          ...c,
          progress: `${c.completed} of ${c.people} complete; ${c.selfReview} awaiting self review, ${c.managerReview} awaiting reviewer`,
        })),
        appraisals: rows.map((r) => ({ ...r, score: score(r.scoreCenti) })),
        kras,
        cycleName: cycles.find((c) => c.id === cycleId)?.name ?? '',
        cycleOptions: cycles.map((c) => ({ value: c.id, label: `${c.name} (${c.status})` })),
        staffOptions: staff.map((s) => ({ value: s.id, label: `${s.employeeCode} - ${s.name}` })),
      }
    },
    sections: (data) => [
      {
        kind: 'table',
        title: 'Cycles',
        rows: 'cycles',
        empty: 'No review cycles yet.',
        columns: [
          { key: 'name', label: 'Cycle', href: '/m/hr/performance?cycleId={id}' },
          { key: 'startsOn', label: 'From', kind: 'date' },
          { key: 'endsOn', label: 'To', kind: 'date' },
          { key: 'status', label: 'Status', kind: 'status' },
          { key: 'progress', label: 'Progress' },
        ],
      },
      {
        kind: 'table',
        title: data.cycleName ? `Appraisals: ${data.cycleName}` : 'Appraisals',
        rows: 'appraisals',
        empty: 'Pick a cycle, or enrol people into it.',
        columns: [
          { key: 'employeeCode', label: 'Code', kind: 'code', href: '/m/hr/appraisal?appraisalId={id}' },
          { key: 'staffName', label: 'Name' },
          { key: 'reviewer', label: 'Reviewer' },
          { key: 'status', label: 'Stage', kind: 'status' },
          { key: 'score', label: 'Score' },
        ],
      },
      {
        kind: 'form',
        title: 'Create a cycle',
        submit: 'Create',
        path: '/performance/cycles',
        roles: [...ADMIN],
        fields: [
          { name: 'name', label: 'Name', hint: 'e.g. 2026-27' },
          { name: 'startsOn', label: 'From', kind: 'date' },
          { name: 'endsOn', label: 'To', kind: 'date' },
        ],
      },
      {
        kind: 'form',
        title: 'Open or close a cycle',
        note: 'One way: draft, open, closed. A closed cycle takes no more ratings.',
        submit: 'Set',
        path: '/performance/cycles/status',
        roles: [...ADMIN],
        fields: [
          { name: 'cycleId', label: 'Cycle', kind: 'select', options: 'cycleOptions' },
          {
            name: 'status',
            label: 'To',
            kind: 'select',
            options: [
              { value: 'open', label: 'open' },
              { value: 'closed', label: 'closed' },
            ],
          },
        ],
      },
      {
        kind: 'table',
        title: 'Key result areas',
        note: 'People are enrolled with weighted KRAs through the API: POST /performance/enrol.',
        rows: 'kras',
        empty: 'None defined.',
        columns: [
          { key: 'code', label: 'Code', kind: 'code' },
          { key: 'name', label: 'Name' },
          { key: 'description', label: 'Covers' },
        ],
      },
      {
        kind: 'form',
        title: 'Add a KRA',
        submit: 'Add',
        path: '/performance/kras',
        roles: [...ADMIN],
        fields: [
          { name: 'code', label: 'Code' },
          { name: 'name', label: 'Name' },
          { name: 'description', label: 'Covers', optional: true },
        ],
      },
    ],
  },
  {
    path: '/appraisal',
    title: 'Appraisal',
    menu: 'My appraisals',
    roles: [...EVERYONE],
    async load(actor, req) {
      const a = actor as Actor
      const mine = await myAppraisals(a)
      const appraisalId = param(req, 'appraisalId')
      const view = appraisalId ? await appraisalView(a, appraisalId) : null
      const goals = await listGoals(a, view?.staffId)
      const me = mine.find((m) => m.id === appraisalId)
      return {
        mine: mine.map((m) => ({ ...m, score: score(m.scoreCenti) })),
        view,
        lines: view?.lines ?? [],
        feedback: (view?.feedback ?? []).map((f) => ({ ...f, from: f.from ?? 'a colleague' })),
        goals,
        heading: view
          ? `${view.staffName}: ${view.status.replace('_', ' ')}${view.score === null ? '' : `, score ${view.score.toFixed(2)}`}`
          : '',
        canSelf: !!view && me?.role === 'appraisee' && view.status === 'self_review',
        canReview: !!view && me?.role === 'reviewer' && view.status === 'manager_review',
        canComment: !!view && me?.role !== 'appraisee' && view.status !== 'completed',
        appraisalId: appraisalId ?? '',
        cycle: me?.cycle ?? '',
      }
    },
    // With an appraisal open, the page is its form view: the facts, the
    // sidebar, and when each stage was reached.
    record: (data) => {
      const v = data.view && Array.isArray((data.view as View).lines) ? (data.view as View) : null
      if (!v) return null
      const at = (d: unknown) => (d ? new Date(d as string).toISOString() : null)
      return {
        title: v.staffName,
        subtitle: data.cycle ? `Appraisal, ${String(data.cycle)}` : 'Appraisal',
        status: { label: v.status },
        fields: [
          { label: 'Stage', value: v.status, kind: 'status' },
          { label: 'Weighted score', value: v.score === null ? null : v.score.toFixed(2) },
          { label: 'Self review submitted', value: at(v.selfSubmittedAt), kind: 'when' },
          { label: 'Completed', value: at(v.completedAt), kind: 'when' },
        ],
        createdAt: at(v.createdAt),
        timeline: [
          { at: at(v.createdAt)!, text: 'Enrolled in the cycle' },
          ...(v.selfSubmittedAt ? [{ at: at(v.selfSubmittedAt)!, text: 'Self review submitted' }] : []),
          ...(v.completedAt ? [{ at: at(v.completedAt)!, text: 'Reviewed; score frozen' }] : []),
        ],
      }
    },
    sections: (data) => {
      // Anything without KRA lines is not an appraisal to show.
      const v = data.view && Array.isArray((data.view as View).lines) ? (data.view as View) : null
      const out: ReturnType<PluginPage['sections']> = [
        {
          kind: 'table',
          title: 'Appraisals',
          rows: 'mine',
          empty: 'You are not being appraised or reviewing anybody.',
          columns: [
            { key: 'cycle', label: 'Cycle', href: '/m/hr/appraisal?appraisalId={id}' },
            { key: 'staffName', label: 'Who' },
            { key: 'role', label: 'You are' },
            { key: 'status', label: 'Stage', kind: 'status' },
            { key: 'waiting', label: 'Waiting on you', kind: 'bool', alertWhen: 'waiting' },
            { key: 'score', label: 'Score' },
          ],
        },
      ]
      if (v) {
        out.push({
          kind: 'table',
          title: 'Key result areas',
          rows: 'lines',
          columns: [
            { key: 'name', label: 'KRA' },
            { key: 'weight', label: 'Weight %' },
            { key: 'selfRating', label: 'Self' },
            { key: 'selfComment', label: 'Self comment' },
            { key: 'reviewerRating', label: 'Reviewer' },
            { key: 'reviewerComment', label: 'Reviewer comment' },
          ],
        })
        if (data.canSelf) {
          out.push({
            kind: 'form',
            title: 'Your self review',
            note: 'Submitted once. Your reviewer reads it before rating you.',
            submit: 'Submit',
            path: '/performance/self-review',
            fields: [
              { name: 'appraisalId', label: '', kind: 'hidden', value: data.appraisalId as string },
              ...ratingFields(v),
              { name: 'summary', label: 'Summary of the year', kind: 'textarea', rows: 4 },
            ],
          })
        }
        if (data.canReview) {
          out.push({
            kind: 'form',
            title: 'Your review',
            note: 'Completes the appraisal and freezes the weighted score.',
            submit: 'Complete',
            path: '/performance/review',
            fields: [
              { name: 'appraisalId', label: '', kind: 'hidden', value: data.appraisalId as string },
              ...ratingFields(v),
              { name: 'summary', label: 'Summary', kind: 'textarea', rows: 4 },
            ],
          })
        }
        out.push({
          kind: 'table',
          title: 'What colleagues said',
          rows: 'feedback',
          empty: 'No colleague feedback.',
          columns: [
            { key: 'from', label: 'From' },
            { key: 'relation', label: 'As' },
            { key: 'strengths', label: 'Does well' },
            { key: 'improvements', label: 'Could do better' },
            { key: 'rating', label: 'Rating' },
          ],
        })
        if (data.canComment) {
          out.push({
            kind: 'form',
            title: 'Give feedback',
            note: 'Once. The person appraised sees it without your name.',
            submit: 'Submit',
            path: '/performance/feedback',
            fields: [
              { name: 'appraisalId', label: '', kind: 'hidden', value: data.appraisalId as string },
              {
                name: 'relation',
                label: 'You are their',
                kind: 'select',
                options: [
                  { value: 'peer', label: 'peer' },
                  { value: 'report', label: 'report' },
                  { value: 'other', label: 'other' },
                ],
              },
              { name: 'strengths', label: 'What they do well', kind: 'textarea' },
              { name: 'improvements', label: 'What they could do better', kind: 'textarea' },
              { name: 'rating', label: 'Overall, 1 to 5', kind: 'number' },
            ],
          })
        }
      }
      out.push({
        kind: 'table',
        title: 'Goals',
        rows: 'goals',
        empty: 'No goals set.',
        columns: [
          { key: 'title', label: 'Goal' },
          { key: 'kra', label: 'KRA', kind: 'code' },
          { key: 'targetOn', label: 'By', kind: 'date' },
          { key: 'progress', label: 'Progress %' },
          { key: 'status', label: 'Status', kind: 'status' },
        ],
      })
      return out
    },
  },
]
