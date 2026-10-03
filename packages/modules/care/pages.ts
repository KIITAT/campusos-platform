import { param, type PluginPage, type PluginSection } from '@campusos/module-framework'
import {
  careHome,
  careSettings,
  caseView,
  checkToTake,
  crisisText,
  queue,
  resultView,
  statistics,
  words,
  CareError,
  type Actor,
} from './api'
import { optionsOf } from './api/instruments'

const STAFF = ['super_admin', 'institution_admin', 'hod', 'faculty', 'accounts_staff', 'library_staff', 'hostel_staff'] as const
const ADMIN = ['institution_admin', 'super_admin'] as const

const choices = (m: Record<string, string>) => Object.entries(m).map(([value, label]) => ({ value, label }))
const TOPIC = choices(words.topics)
const URGENCY = choices(words.urgency)
const MODE = choices(words.modes)
const OUTCOME = choices(words.outcomes)

const PRIVATE =
  'What you do here is yours. Your answers are seen by nobody -- not your teachers, your mentor, your parents or the office -- unless you share them with a counsellor when you ask for help. The office sees only counts.'
const NOT_A_DIAGNOSIS = 'This is a screening questionnaire, not a diagnosis: only a conversation with a professional can tell you more.'

const crisisNote = (crisisLine: string | undefined, contact?: string): PluginSection => ({
  kind: 'note',
  text: `In danger, or thinking of harming yourself? Call ${crisisText(crisisLine)} now, at any hour.${typeof contact === 'string' && contact ? ` ${contact}` : ''}`,
})

/** What a result suggests asking for: today after a safety answer, soon in the upper bands. */
const suggested = (r: { safety: boolean; rank: number; top: number }) =>
  r.safety ? 'today' : r.top > 0 && r.rank >= Math.max(2, r.top - 1) ? 'soon' : 'routine'

/** The topic a check is about, to start the request form on. */
const topicFor = (code: string) => (code === 'PHQ-9' ? 'mood' : code === 'GAD-7' ? 'anxiety' : 'not_said')

export const pages: PluginPage[] = [
  {
    path: '/',
    title: 'Student care',
    menu: 'Student care',
    roles: ['student'],
    async load(actor) {
      const v = await careHome(actor as Actor)
      const open = v.requests.find((r) => r.open)
      return {
        ...v,
        open: open ?? null,
        shareable: v.results.map((r) => ({ value: r.id, label: `${r.name}, ${r.takenAt.slice(0, 10)}: ${r.band}` })),
        upcoming: v.appointments.filter((a) => a.upcoming).map((a) => ({ value: a.id, label: `${a.when} with ${a.counsellor}` })),
      }
    },
    sections: (data) => {
      const s = (data.settings as { crisisLine: string; contact: string } | undefined) ?? { crisisLine: '', contact: '' }
      const checks = (data.checks as { code: string; name: string; about: string; last: string | null }[] | undefined) ?? []
      const open = data.open as { id: string; status: string; counsellor: string; urgency: string } | null | undefined
      const out: PluginSection[] = [
        crisisNote(s.crisisLine, s.contact),
        { kind: 'note', text: PRIVATE },
        {
          kind: 'shortcuts',
          title: 'Self-checks',
          items: checks.map((c) => ({
            label: c.name,
            href: `/m/care/check?code=${encodeURIComponent(c.code)}`,
            description: c.last ? `${c.about} Last: ${c.last}.` : c.about,
          })),
        },
        {
          kind: 'table',
          title: 'Your appointments',
          rows: 'appointments',
          empty: 'None yet. Ask to see a counsellor and one will offer you a time.',
          columns: [
            { key: 'when', label: 'When', kind: 'code' },
            { key: 'until', label: 'Until' },
            { key: 'counsellor', label: 'Counsellor' },
            { key: 'mode', label: 'How' },
            { key: 'place', label: 'Where' },
            { key: 'note', label: 'Note' },
            { key: 'status', label: 'State', kind: 'status' },
          ],
        },
        {
          kind: 'table',
          title: 'Your requests',
          rows: 'requests',
          empty: 'You have not asked to see a counsellor.',
          columns: [
            { key: 'asked', label: 'Asked', kind: 'code' },
            { key: 'topic', label: 'About' },
            { key: 'urgency', label: 'How soon' },
            { key: 'mode', label: 'How' },
            { key: 'counsellor', label: 'Counsellor' },
            { key: 'status', label: 'State', kind: 'status' },
          ],
        },
        {
          kind: 'table',
          title: 'Your results',
          note: 'Only you see these, unless you share one with a counsellor.',
          rows: 'results',
          empty: 'You have not taken a self-check.',
          columns: [
            { key: 'takenAt', label: 'Taken', kind: 'code' },
            { key: 'name', label: 'Check', href: '/m/care/result?id={id}' },
            { key: 'score', label: 'Score' },
            { key: 'band', label: 'Band', alertWhen: 'safety' },
          ],
        },
        {
          kind: 'table',
          title: 'Counsellors',
          rows: 'counsellors',
          empty: 'The institution has not named its counsellors yet.',
          columns: [
            { key: 'name', label: 'Name' },
            { key: 'title', label: 'Who they are' },
          ],
        },
      ]
      if (open && typeof open.id === 'string') {
        out.push(
          {
            kind: 'form',
            title: 'Add to your request',
            note: `Your request is ${open.status === 'waiting' ? 'waiting for a counsellor' : `with ${open.counsellor}`}. Share results with it, or say it has become more urgent.`,
            submit: 'Add',
            path: '/requests',
            fields: [
              { name: 'urgency', label: 'How soon do you need to talk?', kind: 'radio', options: URGENCY, value: open.urgency },
              { name: 'resultIds', label: 'Share results', kind: 'checkboxes', options: 'shareable', optional: true },
            ],
          },
          {
            kind: 'form',
            title: 'Withdraw your request',
            note: 'Anything booked for it is cancelled. You can ask again at any time.',
            submit: 'Withdraw',
            path: '/requests/withdraw',
            fields: [
              { name: 'requestId', label: 'Request', kind: 'hidden', value: open.id },
              { name: 'reason', label: 'Anything you want to say (optional)', optional: true },
            ],
          },
        )
      } else {
        out.push({
          kind: 'form',
          title: 'Talk to a counsellor',
          note: 'Only the counsellors see your request and what you write. Sharing results is up to you.',
          submit: 'Ask',
          path: '/requests',
          fields: [
            { name: 'topic', label: 'What is it about?', kind: 'select', options: TOPIC, value: 'not_said' },
            { name: 'urgency', label: 'How soon do you need to talk?', kind: 'radio', options: URGENCY, value: 'routine' },
            { name: 'mode', label: 'How would you like to talk?', kind: 'radio', options: MODE, value: 'in_person' },
            { name: 'preferredTimes', label: 'When suits you', hint: 'For example: after 4 pm on weekdays', optional: true },
            { name: 'message', label: 'Anything you want them to know first', kind: 'textarea', rows: 4, optional: true },
            { name: 'resultIds', label: 'Share results', kind: 'checkboxes', options: 'shareable', optional: true },
          ],
        })
      }
      if (((data.upcoming as unknown[] | undefined) ?? []).length) {
        out.push({
          kind: 'form',
          title: 'Cancel an appointment',
          submit: 'Cancel it',
          path: '/appointments/cancel',
          fields: [
            { name: 'appointmentId', label: 'Appointment', kind: 'select', options: 'upcoming' },
            { name: 'reason', label: 'Why', hint: 'Your counsellor will offer another time' },
          ],
        })
      }
      return out
    },
  },

  {
    path: '/check',
    title: 'Self-check',
    roles: ['student'],
    async load(actor, req) {
      const v = await checkToTake(actor as Actor, param(req, 'code') ?? '')
      return { ...v, code: v.check.code }
    },
    sections: (data) => {
      const v = data as unknown as Awaited<ReturnType<typeof checkToTake>>
      if (typeof v?.check?.code !== 'string') return [{ kind: 'note', text: 'No such check.' }]
      const c = v.check
      return [
        crisisNote(v.crisisLine),
        { kind: 'note', text: `${c.about} ${PRIVATE} ${NOT_A_DIAGNOSIS}` },
        {
          kind: 'form',
          title: c.name,
          note: c.stem,
          submit: 'See my result',
          path: '/checks',
          placement: 'inline',
          fields: [
            { name: 'code', label: 'Check', kind: 'hidden', value: c.code },
            ...c.items.map((item, i) => ({
              name: `a${i}`,
              label: `${i + 1}. ${item.text}`,
              kind: 'radio' as const,
              optional: Boolean(item.optional),
              options: optionsOf(c, item).map((o, j) => ({ value: String(j), label: o.label })),
            })),
          ],
        },
        { kind: 'note', text: `Source: ${c.source}` },
      ]
    },
  },

  {
    path: '/result',
    title: 'Self-check result',
    roles: ['student', ...STAFF],
    async load(actor, req) {
      return { v: await resultView(actor as Actor, param(req, 'id') ?? '') }
    },
    sections: (data) => {
      const v = data.v as Awaited<ReturnType<typeof resultView>> | undefined
      if (typeof v?.id !== 'string') return [{ kind: 'note', text: 'No such result.' }]
      const out: PluginSection[] = []
      if (v.safety) {
        out.push({
          kind: 'note',
          tone: 'danger',
          text: v.mine
            ? `You said that you have had thoughts that you would be better off dead, or of hurting yourself. Thank you for answering honestly; you do not have to carry this alone. If you might act on these thoughts, call ${crisisText(v.crisisLine)} now or go to the nearest hospital emergency department. You can also ask a counsellor to see you today, below: a request for today goes to the top of their list.`
            : 'The student answered the safety question above “not at all”. Make contact today.',
        })
      } else if (v.mine) {
        out.push(crisisNote(v.crisisLine, v.contact))
      }
      out.push(
        {
          kind: 'figures',
          figures: [
            { label: v.name, value: `${v.score} of ${v.max}` },
            { label: 'Band', value: v.band, tone: v.rank >= 2 || v.safety ? 'due' : 'clear' },
            { label: 'Taken', value: v.takenAt },
          ],
        },
        { kind: 'prose', title: v.mine ? 'What this means' : `Shared by ${v.student ?? 'the student'}`, text: `${v.advice}\n\n${NOT_A_DIAGNOSIS}` },
        {
          kind: 'table',
          title: 'The answers',
          rows: 'answers',
          pageSize: 40,
          columns: [
            { key: 'n', label: '#' },
            { key: 'question', label: 'Question' },
            { key: 'answer', label: 'Answer', alertWhen: 'flagged' },
            { key: 'points', label: 'Points' },
          ],
        },
        { kind: 'note', text: `Source: ${v.source}` },
      )
      if (!v.mine) return out
      const urgency = suggested(v)
      if (v.openRequest) {
        out.push({
          kind: 'form',
          title: 'Share this with your request',
          note: `Your request is ${v.openRequest.status === 'waiting' ? 'waiting for a counsellor' : `with ${v.openRequest.counsellor ?? 'a counsellor'}`}. Sharing this shows them these answers.`,
          submit: 'Share it',
          path: '/requests',
          placement: 'inline',
          fields: [
            { name: 'resultIds', label: 'Result', kind: 'hidden', value: v.id },
            {
              name: 'urgency',
              label: 'How soon do you need to talk?',
              kind: 'radio',
              options: URGENCY,
              value: { routine: 0, soon: 1, today: 2 }[urgency] > { routine: 0, soon: 1, today: 2 }[v.openRequest.urgency] ? urgency : v.openRequest.urgency,
            },
          ],
        })
      } else {
        out.push({
          kind: 'form',
          title: 'Talk to a counsellor about this',
          note: 'This result goes with your request, and only the counsellors see it.',
          submit: 'Ask',
          path: '/requests',
          placement: 'inline',
          fields: [
            { name: 'resultIds', label: 'Result', kind: 'hidden', value: v.id },
            { name: 'urgency', label: 'How soon do you need to talk?', kind: 'radio', options: URGENCY, value: urgency },
            { name: 'mode', label: 'How would you like to talk?', kind: 'radio', options: MODE, value: 'in_person' },
            { name: 'topic', label: 'What is it about?', kind: 'select', options: TOPIC, value: topicFor(v.code) },
            { name: 'preferredTimes', label: 'When suits you', optional: true },
            { name: 'message', label: 'Anything you want them to know first', kind: 'textarea', rows: 3, optional: true },
          ],
        })
      }
      out.push({
        kind: 'form',
        title: 'Delete this result',
        note: v.sharedWith ? 'It is also taken back from the counsellors you shared it with.' : 'Nobody else has seen it.',
        submit: 'Delete',
        path: '/results/delete',
        placement: 'inline',
        fields: [{ name: 'resultId', label: 'Result', kind: 'hidden', value: v.id }],
      })
      return out
    },
  },

  {
    path: '/queue',
    title: 'Counselling',
    menu: 'Requests',
    roles: [...STAFF],
    async load(actor) {
      return { v: await queue(actor as Actor), admin: (ADMIN as readonly string[]).includes((actor as Actor).role) }
    },
    sections: (data) => {
      const v = data.v as Awaited<ReturnType<typeof queue>> | undefined
      if (!v?.counsellor) {
        return [
          {
            kind: 'note',
            text: data.admin
              ? 'Only the institution’s counsellors see requests for counselling, and the office does not. Name counsellors under Settings; the statistics are counts.'
              : 'Only the institution’s counsellors see requests for counselling.',
          },
        ]
      }
      if (!Array.isArray(v.waiting)) return []
      return [
        {
          kind: 'figures',
          figures: [
            { label: 'Waiting', value: String(v.waiting.length), tone: v.waiting.length ? 'due' : 'clear' },
            { label: 'For today', value: String(v.urgentWaiting), tone: v.urgentWaiting ? 'due' : 'clear' },
            { label: 'Waiting over two days', value: String(v.waitingLong), tone: v.waitingLong ? 'due' : 'clear' },
            { label: 'My open cases', value: String(v.cases.length) },
          ],
        },
        {
          kind: 'table',
          title: 'Waiting for a counsellor',
          note: 'Most urgent first. Open one to read it and take it.',
          rows: 'waiting',
          empty: 'Nobody is waiting.',
          columns: [
            { key: 'urgency', label: 'How soon', kind: 'status' },
            { key: 'student', label: 'Student', href: '/m/care/case?id={id}' },
            { key: 'rollNo', label: 'Roll', kind: 'code' },
            { key: 'topic', label: 'About' },
            { key: 'mode', label: 'How' },
            { key: 'preferred', label: 'When suits them' },
            { key: 'asked', label: 'Asked', kind: 'code' },
            { key: 'shared', label: 'Results shared' },
            { key: 'safety', label: '', alertWhen: 'flagged' },
          ],
        },
        {
          kind: 'table',
          title: 'My cases',
          rows: 'cases',
          empty: 'No open cases.',
          columns: [
            { key: 'student', label: 'Student', href: '/m/care/case?id={id}' },
            { key: 'rollNo', label: 'Roll', kind: 'code' },
            { key: 'topic', label: 'About' },
            { key: 'urgency', label: 'How soon', kind: 'status' },
            { key: 'since', label: 'Since', kind: 'code' },
            { key: 'next', label: 'Next appointment', kind: 'code' },
            { key: 'lastNote', label: 'Last note', kind: 'code' },
          ],
        },
        {
          kind: 'table',
          title: 'My appointments',
          note: 'One that has begun is waiting to be recorded as held or missed.',
          rows: 'appointments',
          empty: 'Nothing booked.',
          columns: [
            { key: 'when', label: 'When', kind: 'code', alertWhen: 'due' },
            { key: 'student', label: 'Student', href: '/m/care/case?id={requestId}' },
            { key: 'mode', label: 'How' },
            { key: 'place', label: 'Where' },
          ],
        },
      ]
    },
  },

  {
    path: '/case',
    title: 'Counselling case',
    roles: [...STAFF],
    async load(actor, req) {
      const v = await caseView(actor as Actor, param(req, 'id') ?? '')
      return {
        v,
        results: v.results,
        appointments: v.appointments,
        notes: v.notes,
        counsellors: v.counsellors,
        booked: v.appointments.filter((a) => a.status === 'booked').map((a) => ({ value: a.id, label: `${a.when} (${a.mode.toLowerCase()})` })),
        due: v.appointments.filter((a) => a.due).map((a) => ({ value: a.id, label: `${a.when} (${a.mode.toLowerCase()})` })),
      }
    },
    record: (data) => {
      const v = data.v as Awaited<ReturnType<typeof caseView>> | undefined
      if (typeof v?.request?.id !== 'string') return null
      const r = v.request
      return {
        title: v.student.name,
        subtitle: [v.student.rollNo, r.topic].filter(Boolean).join(' · '),
        status: { label: r.status },
        fields: [
          { label: 'How soon', value: r.urgencyText },
          { label: 'How', value: r.mode },
          { label: 'When suits them', value: r.preferred },
          { label: 'Asked', value: r.asked },
          { label: 'Counsellor', value: r.counsellor },
          { label: 'Taken', value: r.accepted },
          { label: 'Closed', value: r.closed },
          { label: 'Outcome', value: r.outcome },
          { label: 'Email', value: v.student.email },
        ],
      }
    },
    sections: (data) => {
      const v = data.v as Awaited<ReturnType<typeof caseView>> | undefined
      if (typeof v?.request?.id !== 'string') return [{ kind: 'note', text: 'No such case.' }]
      const r = v.request
      const out: PluginSection[] = []
      if (v.results.some((x) => x.flagged)) {
        out.push({ kind: 'note', tone: 'danger', text: 'A shared result answers the safety question above “not at all”. Make contact today.' })
      }
      if (r.message) out.push({ kind: 'prose', title: 'What they wrote', text: r.message })
      out.push(
        {
          kind: 'table',
          title: 'Results they shared',
          rows: 'results',
          empty: 'None shared.',
          columns: [
            { key: 'name', label: 'Check', href: '/m/care/result?id={id}' },
            { key: 'takenAt', label: 'Taken', kind: 'code' },
            { key: 'score', label: 'Score' },
            { key: 'band', label: 'Band' },
            { key: 'safety', label: '', alertWhen: 'flagged' },
          ],
        },
        {
          kind: 'table',
          title: 'Appointments',
          rows: 'appointments',
          empty: 'None yet.',
          columns: [
            { key: 'when', label: 'When', kind: 'code', alertWhen: 'due' },
            { key: 'until', label: 'Until' },
            { key: 'mode', label: 'How' },
            { key: 'place', label: 'Where' },
            { key: 'note', label: 'Told the student' },
            { key: 'status', label: 'State', kind: 'status' },
            { key: 'reason', label: 'Why cancelled' },
          ],
        },
      )
      if (r.mine) {
        out.push({
          kind: 'table',
          title: 'Notes',
          note: 'Yours, and whoever holds the case after you. Kept as written.',
          rows: 'notes',
          empty: 'No notes.',
          columns: [
            { key: 'at', label: 'When', kind: 'code' },
            { key: 'by', label: 'By' },
            { key: 'body', label: 'Note' },
          ],
        })
      }
      if (r.status === 'waiting') {
        out.push({
          kind: 'form',
          title: 'Take this request',
          note: 'It becomes your case: the student is told, and you offer them a time.',
          submit: 'Take it',
          path: '/requests/accept',
          placement: 'inline',
          fields: [{ name: 'requestId', label: 'Request', kind: 'hidden', value: r.id }],
        })
      }
      if (r.open) {
        const id = { name: 'requestId', label: 'Request', kind: 'hidden' as const, value: r.id }
        out.push(
          {
            kind: 'form',
            title: 'Offer a time',
            note: `In ${v.timeZone}. The student is told at once.`,
            submit: 'Book',
            path: '/appointments',
            fields: [
              id,
              { name: 'startsAt', label: 'When', kind: 'datetime' },
              {
                name: 'minutes',
                label: 'For',
                kind: 'select',
                value: '45',
                options: [
                  { value: '30', label: '30 minutes' },
                  { value: '45', label: '45 minutes' },
                  { value: '60', label: 'An hour' },
                  { value: '90', label: 'An hour and a half' },
                ],
              },
              { name: 'mode', label: 'How', kind: 'radio', options: MODE, value: r.modeValue },
              { name: 'place', label: 'Where', hint: 'A room, the number you will call from, or a meeting link' },
              { name: 'noteToStudent', label: 'A note for the student', optional: true },
            ],
          },
          {
            kind: 'form',
            title: 'Record an appointment',
            submit: 'Record',
            path: '/appointments/record',
            fields: [
              { name: 'appointmentId', label: 'Appointment', kind: 'select', options: 'due' },
              {
                name: 'status',
                label: 'It was',
                kind: 'radio',
                value: 'held',
                options: [
                  { value: 'held', label: 'Held' },
                  { value: 'missed', label: 'Missed' },
                ],
              },
            ],
          },
          {
            kind: 'form',
            title: 'Cancel an appointment',
            submit: 'Cancel it',
            path: '/appointments/cancel',
            fields: [
              { name: 'appointmentId', label: 'Appointment', kind: 'select', options: 'booked' },
              { name: 'reason', label: 'What to tell the student' },
            ],
          },
          {
            kind: 'form',
            title: 'Add a note',
            submit: 'Add',
            path: '/notes',
            fields: [id, { name: 'body', label: 'Note', kind: 'textarea', rows: 5 }],
          },
          {
            kind: 'form',
            title: 'Hand to another counsellor',
            note: 'Your reason is kept in the notes for them. Times you booked are cancelled and the student told.',
            submit: 'Hand over',
            path: '/requests/handover',
            fields: [
              id,
              { name: 'counsellorId', label: 'To', kind: 'select', options: 'counsellors' },
              { name: 'reason', label: 'Why', kind: 'textarea', rows: 3 },
            ],
          },
          {
            kind: 'form',
            title: 'Close the case',
            submit: 'Close',
            path: '/requests/close',
            fields: [
              id,
              { name: 'outcome', label: 'Outcome', kind: 'radio', options: OUTCOME, value: 'supported' },
              { name: 'note', label: 'A closing note', kind: 'textarea', rows: 3, optional: true },
            ],
          },
        )
      } else if (r.mine && r.status === 'closed') {
        out.push({
          kind: 'form',
          title: 'Add a note',
          submit: 'Add',
          path: '/notes',
          fields: [
            { name: 'requestId', label: 'Request', kind: 'hidden', value: r.id },
            { name: 'body', label: 'Note', kind: 'textarea', rows: 5 },
          ],
        })
      }
      return out
    },
  },

  {
    path: '/statistics',
    title: 'Counselling statistics',
    menu: 'Statistics',
    roles: [...STAFF],
    async load(actor, req) {
      try {
        const v = await statistics(actor as Actor, param(req, 'period'))
        return {
          v,
          months: v.months,
          topics: v.topics,
          outcomes: v.outcomes,
          checks: v.checks,
          counsellors: v.counsellors,
          periods: (['30d', '12m', 'all'] as const).map((p) => ({
            label: { '30d': '30 days', '12m': '12 months', all: 'All time' }[p],
            href: `/m/care/statistics?period=${p}`,
            active: v.period === p,
          })),
        }
      } catch (e) {
        if (e instanceof CareError && e.status === 403) return { v: null }
        throw e
      }
    },
    sections: (data) => {
      const v = data.v as Awaited<ReturnType<typeof statistics>> | null | undefined
      if (typeof v?.periodText !== 'string') return [{ kind: 'note', text: 'The office and the counsellors see these.' }]
      const f = v.figures
      return [
        { kind: 'links', title: 'Period', links: data.periods as never },
        {
          kind: 'note',
          text: `Counts for ${v.periodText}. Nobody is named. Where a count describes students -- what they asked about, how their checks came out -- 1 to 4 is shown as “fewer than 5”, and where that could be worked out from the total, the next smallest is hidden too.`,
        },
        {
          kind: 'figures',
          figures: [
            { label: 'Requests', value: String(f.requests) },
            { label: 'Waiting now', value: String(f.waiting), tone: f.waiting ? 'due' : 'clear' },
            { label: 'Typical wait to be taken', value: f.medianToTaken, hint: 'the median' },
            { label: 'Typical wait to a first appointment', value: f.medianToFirst, hint: 'the median' },
            { label: 'Appointments held', value: String(f.held) },
            { label: 'Missed', value: String(f.missed) },
            { label: 'Students who took a self-check', value: f.students },
            { label: 'Safety question answered', value: f.safety, hint: 'above “not at all”' },
          ],
        },
        {
          kind: 'chart',
          title: 'Requests by month',
          type: 'bar',
          rows: 'months',
          x: 'month',
          series: [
            { key: 'requests', label: 'Asked' },
            { key: 'taken', label: 'Taken' },
          ],
          empty: 'No requests in this period.',
        },
        {
          kind: 'table',
          title: 'By month',
          rows: 'months',
          empty: 'No requests in this period.',
          columns: [
            { key: 'month', label: 'Month', kind: 'code' },
            { key: 'requests', label: 'Asked' },
            { key: 'today', label: 'For today' },
            { key: 'taken', label: 'Taken' },
            { key: 'closed', label: 'Closed' },
          ],
        },
        {
          kind: 'table',
          title: 'What students asked about',
          rows: 'topics',
          columns: [
            { key: 'topic', label: 'About' },
            { key: 'count', label: 'Requests' },
          ],
        },
        {
          kind: 'table',
          title: 'Outcomes of closed cases',
          rows: 'outcomes',
          columns: [
            { key: 'outcome', label: 'Outcome' },
            { key: 'count', label: 'Cases' },
          ],
        },
        {
          kind: 'table',
          title: 'Self-checks',
          note: 'How many came out in each band.',
          rows: 'checks',
          empty: 'No self-checks in this period.',
          pageSize: 50,
          columns: [
            { key: 'check', label: 'Check' },
            { key: 'band', label: 'Band' },
            { key: 'count', label: 'Taken' },
          ],
        },
        {
          kind: 'table',
          title: 'Counsellors',
          rows: 'counsellors',
          empty: 'No counsellors named.',
          columns: [
            { key: 'name', label: 'Counsellor' },
            { key: 'title', label: 'Title' },
            { key: 'state', label: 'State', kind: 'status' },
            { key: 'open', label: 'Open cases' },
            { key: 'held', label: 'Appointments held' },
          ],
        },
      ]
    },
  },

  {
    path: '/settings',
    title: 'Student care settings',
    menu: 'Settings',
    roles: [...ADMIN],
    async load(actor) {
      const v = await careSettings(actor as Actor)
      return {
        ...v,
        all: v.counsellors.map((c) => ({ value: c.userId, label: `${c.name} (${c.state})` })),
        retirable: v.checks.filter((c) => c.id && c.state === 'offered').map((c) => ({ value: c.id!, label: `${c.name} (${c.code})` })),
      }
    },
    sections: (data) => {
      const s = data.settings as { crisisLine: string; contact: string; timeZone: string } | undefined
      if (typeof s?.timeZone !== 'string') return []
      return [
        {
          kind: 'note',
          text: 'The office names the counsellors, sets the helpline and writes checks. It does not see who asked for help or how anyone scored: those are the students’ and the counsellors’.',
        },
        {
          kind: 'table',
          title: 'Counsellors',
          rows: 'counsellors',
          empty: 'None named yet. Students cannot be seen until one is.',
          columns: [
            { key: 'name', label: 'Name' },
            { key: 'title', label: 'Title' },
            { key: 'role', label: 'Role', kind: 'code' },
            { key: 'state', label: 'State', kind: 'status' },
            { key: 'openCases', label: 'Open cases' },
          ],
        },
        {
          kind: 'table',
          title: 'Self-checks',
          note: 'The PHQ-9 and GAD-7 are built in, free to use and validated as screens. A check of your own shows students its source.',
          rows: 'checks',
          columns: [
            { key: 'name', label: 'Check' },
            { key: 'code', label: 'Code', kind: 'code' },
            { key: 'kind', label: 'Kind' },
            { key: 'state', label: 'State', kind: 'status' },
            { key: 'taken', label: 'Times taken' },
            { key: 'source', label: 'Source' },
          ],
        },
        {
          kind: 'form',
          title: 'Helpline and centre',
          note: 'Shown to students at the top of every page of Student care, and at once to a student who answers a safety question.',
          submit: 'Save',
          path: '/settings',
          fields: [
            { name: 'crisisLine', label: 'Crisis helpline', value: s.crisisLine, hint: 'As students should read it, with the number', optional: true },
            { name: 'contact', label: 'The counselling centre', kind: 'textarea', rows: 3, value: s.contact, hint: 'Where it is and when it is open', optional: true },
            { name: 'timeZone', label: 'Time zone', value: s.timeZone },
          ],
        },
        {
          kind: 'form',
          title: 'Name a counsellor',
          submit: 'Name',
          path: '/counsellors',
          fields: [
            { name: 'userId', label: 'Member of staff', kind: 'select', options: 'staff' },
            { name: 'title', label: 'How students know them', value: 'Counsellor, Student Care Centre' },
          ],
        },
        {
          kind: 'form',
          title: 'A counsellor active or not',
          note: 'An inactive counsellor sees no requests. Their open cases are handed on first.',
          submit: 'Save',
          path: '/counsellors/active',
          fields: [
            { name: 'userId', label: 'Counsellor', kind: 'select', options: 'all' },
            {
              name: 'active',
              label: 'They are',
              kind: 'radio',
              value: 'false',
              options: [
                { value: 'true', label: 'Active' },
                { value: 'false', label: 'Inactive' },
              ],
            },
          ],
        },
        {
          kind: 'form',
          title: 'Write a check',
          note: 'Fixed once written: to change one, retire it and write another. Say where the questions come from -- a published scale and its licence, or that your counsellors wrote it.',
          submit: 'Offer it',
          path: '/instruments',
          fields: [
            { name: 'name', label: 'Name', hint: 'As students see it: Exam stress' },
            { name: 'code', label: 'Code', hint: 'Short: EXAM-STRESS' },
            { name: 'about', label: 'What it is', hint: 'One sentence' },
            { name: 'stem', label: 'The question the items answer', value: 'Over the last 2 weeks, how often have you felt the following?' },
            { name: 'options', label: 'Answers and their points', value: 'Never=0, Sometimes=1, Often=2, Always=3' },
            {
              name: 'items',
              label: 'Questions',
              kind: 'textarea',
              rows: 8,
              hint: 'One a line. Start a line with ! for a safety question: any answer above the lowest shows the helpline at once.',
            },
            { name: 'bands', label: 'Bands', kind: 'textarea', rows: 4, hint: 'One a line, covering every score: 0-4: Low: what it means and what to do' },
            { name: 'source', label: 'Source', kind: 'textarea', rows: 2 },
          ],
        },
        {
          kind: 'form',
          title: 'Stop offering a check',
          note: 'Results already taken stay with the students.',
          submit: 'Retire',
          path: '/instruments/retire',
          fields: [{ name: 'instrumentId', label: 'Check', kind: 'select', options: 'retirable' }],
        },
      ]
    },
  },
]
