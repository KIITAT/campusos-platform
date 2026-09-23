import { param, type PluginPage } from '@campusos/module-framework'
import { listOfferings, listStructure } from '@campusos/module-academic/api'
import {
  listPendingDevices,
  myAttendance,
  openSessions,
  roster,
  type Actor,
} from './api'

const STAFF = ['institution_admin', 'super_admin', 'faculty', 'hod'] as const
const ADMIN = ['institution_admin', 'super_admin'] as const

export const pages: PluginPage[] = [
  {
    path: '/',
    title: 'Attendance',
    menu: 'Sessions',
    roles: [...STAFF],
    async load(actor, req) {
      const a = actor as Actor
      const [sessions, offerings] = await Promise.all([openSessions(a), listOfferings(a)])
      const sessionId = param(req, 'sessionId')
      const marks = sessionId ? await roster(a, sessionId) : null

      return {
        sessions: sessions.map((s) => ({
          ...s,
          id: s.sessionId,
          openedAt: s.openedAt.toISOString(),
          who: `${s.courseCode} ${s.sectionLabel}`,
        })),
        offeringOptions: offerings.map((o) => ({
          value: o.id,
          label: `${o.courseCode} ${o.sectionLabel} (${o.termCode})`,
        })),
        openOptions: sessions.map((s) => ({
          value: s.sessionId,
          label: `${s.courseCode} ${s.sectionLabel}`,
        })),
        sessionId: sessionId ?? '',
        entries: (marks?.entries ?? []).map((e) => ({
          ...e,
          who: e.name ?? e.email,
          state: e.markedAt ? (e.method ?? 'present').replace(/_/g, ' ') : 'not marked',
          missing: !e.markedAt,
        })),
        qr: sessionId
          ? `/api/v1/modules/attendance/sessions/qr?sessionId=${sessionId}`
          : null,
      }
    },
    sections: (data) => [
      {
        kind: 'note',
        text:
          'The code on the projector rotates every few seconds and the previous ' +
          'one still works, so a student who photographs it as it changes is not ' +
          'told they are wrong. A screenshot is useless a moment later.',
      },
      {
        kind: 'table',
        title: 'Open sessions',
        rows: 'sessions',
        empty: 'Nothing open.',
        columns: [
          {
            key: 'who',
            label: 'Class',
            href: '/m/attendance?sessionId={id}',
          },
          { key: 'roomCode', label: 'Room', kind: 'code' },
          { key: 'openedAt', label: 'Opened', kind: 'when' },
          { key: 'present', label: 'Present' },
        ],
      },
      {
        kind: 'form',
        title: 'Open a session',
        submit: 'Open',
        path: '/sessions',
        fields: [
          { name: 'offeringId', label: 'Class', kind: 'select', options: 'offeringOptions' },
        ],
      },
      ...(data.qr
        ? [
            {
              kind: 'links' as const,
              title: 'Gate screen',
              links: [{ label: 'Fetch the current code', href: String(data.qr) }],
            },
          ]
        : []),
      {
        kind: 'table',
        title: 'Register',
        note:
          'Absent students are listed too, so this is usable as a register rather ' +
          'than a list of who happened to scan.',
        rows: 'entries',
        empty: 'Pick a session above.',
        columns: [
          { key: 'who', label: 'Student' },
          { key: 'state', label: 'Status', kind: 'status', alertWhen: 'missing' },
          { key: 'markedAt', label: 'When', kind: 'when' },
          { key: 'overrideReason', label: 'Reason' },
        ],
      },
      {
        kind: 'form',
        title: 'Mark somebody by hand',
        note:
          'A reason is required and goes on the shared audit trail. It cannot ' +
          'invent attendance for somebody not in the class.',
        submit: 'Mark present',
        path: '/override',
        fields: [
          { name: 'sessionId', kind: 'hidden', label: '', value: String(data.sessionId ?? '') },
          { name: 'studentId', label: 'Student' },
          { name: 'reason', label: 'Reason', hint: 'At least five characters' },
        ],
      },
      {
        kind: 'form',
        title: 'Close the session',
        submit: 'Close',
        path: '/sessions/close',
        fields: [
          { name: 'sessionId', label: 'Session', kind: 'select', options: 'openOptions' },
        ],
      },
    ],
  },

  {
    path: '/devices',
    title: 'Devices',
    menu: 'Devices',
    roles: [...ADMIN],
    async load(actor) {
      const a = actor as Actor
      const [pending, structure] = await Promise.all([
        listPendingDevices(a),
        listStructure(a),
      ])
      return {
        pending: pending.map((d) => ({
          ...d,
          who: d.studentName ?? d.studentEmail,
        })),
        pendingOptions: pending.map((d) => ({
          value: d.id,
          label: `${d.studentName ?? d.studentEmail} — ${d.label ?? 'unnamed'}`,
        })),
        roomOptions: structure.rooms.map((r) => ({ value: r.id, label: r.code })),
      }
    },
    sections: () => [
      {
        kind: 'note',
        text:
          'A student may hold one active device, and the database is what enforces ' +
          'that. Re-registration is approved here rather than self-service: a lost ' +
          'phone is a support ticket, not a way around device binding.',
      },
      {
        kind: 'table',
        title: 'Waiting for approval',
        rows: 'pending',
        empty: 'Nothing waiting.',
        columns: [
          { key: 'who', label: 'Student' },
          { key: 'label', label: 'Device' },
          { key: 'createdAt', label: 'Registered', kind: 'when' },
        ],
      },
      {
        kind: 'form',
        title: 'Approve a device',
        note: 'Approving revokes whatever they had before.',
        submit: 'Approve',
        path: '/devices/approve',
        fields: [
          { name: 'deviceId', label: 'Device', kind: 'select', options: 'pendingOptions' },
        ],
      },
      {
        kind: 'form',
        title: 'Set a room geofence',
        note:
          'Radius in metres. A room with no geofence is flagged rather than ' +
          'blocked: an unmapped room should not stop a class.',
        submit: 'Save geofence',
        path: '/geofences',
        fields: [
          { name: 'roomId', label: 'Room', kind: 'select', options: 'roomOptions' },
          { name: 'latitude', label: 'Latitude' },
          { name: 'longitude', label: 'Longitude' },
          { name: 'radiusM', label: 'Radius (m)', kind: 'number', value: '50' },
        ],
      },
    ],
  },

  {
    path: '/me',
    title: 'My attendance',
    menu: 'My attendance',
    roles: ['student'],
    async load(actor) {
      const rows = await myAttendance(actor as Actor)
      return {
        marked: rows.length,
        rows: rows.map((r) => ({
          courseCode: r.courseCode,
          markedAt: r.markedAt.toISOString(),
          method: r.method.replace(/_/g, ' '),
        })),
      }
    },
    sections: (data) => [
      {
        kind: 'figures',
        figures: [{ label: 'Classes marked present', value: String(data.marked ?? 0) }],
      },
      {
        kind: 'table',
        rows: 'rows',
        empty: 'Nothing marked yet.',
        columns: [
          { key: 'courseCode', label: 'Course', kind: 'code' },
          { key: 'markedAt', label: 'When', kind: 'when' },
          { key: 'method', label: 'How' },
        ],
      },
    ],
  },
]
