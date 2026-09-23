import { param, type PluginPage } from '@campusos/module-framework'
import {
  listShiftRequests,
  listShiftTypes,
  listStaff,
  roster,
  shiftDays,
  today,
  type Actor,
} from './api'

const OFFICE = ['institution_admin', 'super_admin', 'accounts_staff'] as const

/** The Monday on or before a date. */
const mondayOf = (d: string) => {
  const dow = (new Date(`${d}T00:00:00Z`).getUTCDay() + 6) % 7
  return shiftDays(d, -dow)
}

const DAY = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']

export const shiftsPages: PluginPage[] = [
  {
    path: '/shifts',
    title: 'Shifts',
    menu: 'Shifts',
    roles: [...OFFICE],
    async load(actor, req) {
      const a = actor as Actor
      const from = mondayOf(param(req, 'week') ?? today())
      const to = shiftDays(from, 6)
      const [types, week, requests, staff] = await Promise.all([
        listShiftTypes(a),
        roster(a, from, to),
        listShiftRequests(a),
        listStaff(a),
      ])
      return {
        types: types.map((t) => ({ ...t, when: `${t.startsAt} - ${t.endsAt}` })),
        week: week.rows.map((r) => ({
          ...r,
          ...Object.fromEntries(r.days.map((v, i) => [`d${i}`, v])),
        })),
        heading: `Week of ${from}`,
        prev: `/m/hr/shifts?week=${shiftDays(from, -7)}`,
        next: `/m/hr/shifts?week=${shiftDays(from, 7)}`,
        dayLabels: week.days.map((d, i) => `${DAY[i]} ${d.slice(8)}`),
        requests: requests.map((r) => ({ ...r, waiting: r.status === 'pending' })),
        staffOptions: staff.map((s) => ({ value: s.id, label: `${s.employeeCode} - ${s.name}` })),
        typeOptions: types.map((t) => ({ value: t.id, label: `${t.code} - ${t.name}` })),
        requestOptions: requests
          .filter((r) => r.status === 'pending')
          .map((r) => ({
            value: r.id,
            label: `${r.employeeCode} - ${r.shiftCode} ${r.fromOn} to ${r.toOn}`,
          })),
      }
    },
    sections: (data) => {
      const labels = data.dayLabels as string[]
      return [
        {
          kind: 'links',
          links: [
            { label: 'Previous week', href: data.prev as string },
            { label: data.heading as string, href: '/m/hr/shifts', active: true },
            { label: 'Next week', href: data.next as string },
          ],
        },
        {
          kind: 'table',
          title: 'Roster',
          note: 'Approved leave shows through the shift; the allowance is paid only for days on it.',
          rows: 'week',
          empty: 'Nobody is on a shift this week.',
          columns: [
            { key: 'employeeCode', label: 'Code', kind: 'code' },
            { key: 'staffName', label: 'Name' },
            ...labels.map((l, i) => ({ key: `d${i}`, label: l, kind: 'code' as const })),
          ],
        },
        {
          kind: 'form',
          title: 'Put somebody on a shift',
          note: 'Leave the end blank for until further notice. What it overlaps is carved around it.',
          submit: 'Assign',
          path: '/shifts/assign',
          fields: [
            { name: 'staffId', label: 'Who', kind: 'select', options: 'staffOptions' },
            { name: 'shiftTypeId', label: 'Shift', kind: 'select', options: 'typeOptions' },
            { name: 'fromOn', label: 'From', kind: 'date' },
            { name: 'toOn', label: 'To', kind: 'date', optional: true },
          ],
        },
        {
          kind: 'table',
          title: 'Requests',
          rows: 'requests',
          empty: 'No shift requests.',
          columns: [
            { key: 'employeeCode', label: 'Code', kind: 'code' },
            { key: 'staffName', label: 'Name' },
            { key: 'shiftCode', label: 'Shift', kind: 'code' },
            { key: 'fromOn', label: 'From', kind: 'date' },
            { key: 'toOn', label: 'To', kind: 'date' },
            { key: 'reason', label: 'Why' },
            { key: 'status', label: 'Status', alertWhen: 'waiting' },
          ],
        },
        {
          kind: 'form',
          title: 'Decide a request',
          submit: 'Decide',
          path: '/shifts/requests/decide',
          fields: [
            { name: 'requestId', label: 'Request', kind: 'select', options: 'requestOptions' },
            { name: 'approve', label: 'Approve', kind: 'checkbox', optional: true },
            { name: 'note', label: 'Note', optional: true },
          ],
        },
        {
          kind: 'table',
          title: 'Shift types',
          rows: 'types',
          empty: 'No shifts defined. Most teaching staff never need one.',
          columns: [
            { key: 'code', label: 'Code', kind: 'code' },
            { key: 'name', label: 'Name' },
            { key: 'when', label: 'Hours' },
            { key: 'hours', label: 'Paid hours' },
            { key: 'overnight', label: 'Overnight', kind: 'bool' },
            { key: 'allowancePaise', label: 'Allowance a day', kind: 'money' },
          ],
        },
        {
          kind: 'form',
          title: 'Define a shift',
          submit: 'Add',
          path: '/shifts/types',
          fields: [
            { name: 'code', label: 'Code' },
            { name: 'name', label: 'Name' },
            { name: 'startsAt', label: 'Starts', hint: 'HH:MM, 24-hour' },
            { name: 'endsAt', label: 'Ends', hint: 'Before the start means overnight' },
            { name: 'breakMinutes', label: 'Break, minutes', kind: 'number', optional: true },
            { name: 'allowance', label: 'Allowance a day', kind: 'money', optional: true },
          ],
        },
      ]
    },
  },
]
