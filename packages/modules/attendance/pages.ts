import { param, type PluginPage } from '@campusos/module-framework'
import { getTimetable, listStructure } from '@campusos/module-academic/api'
import {
  institutionDevices,
  myDevices,
  offlinePolicy,
  openSessions,
  roster,
  type Actor,
} from './api'
import { myAttendancePage, summaryPages } from './summary-pages'

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
      const [sessions, timetable] = await Promise.all([openSessions(a), getTimetable(a)])
      const sessionId = param(req, 'sessionId')
      const marks = sessionId ? await roster(a, sessionId) : null

      return {
        sessions: sessions.map((s) => ({
          ...s,
          id: s.sessionId,
          openedAt: s.openedAt.toISOString(),
          who: `${s.courseCode} ${s.sectionLabel}`,
        })),
        slotOptions: timetable.entries.map((entry) => ({
          value: entry.slotId,
          label: `${entry.courseCode} ${entry.sectionLabel} · day ${entry.dayOfWeek}, ${entry.startsAt} · ${entry.roomCode}`,
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
          'Students sign scans on their approved phone after biometric or PIN verification. Offline scans remain pending until synced; late submissions are flagged for review.',
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
          { name: 'slotId', label: 'Timetable class', kind: 'select', options: 'slotOptions' },
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
          { key: 'anomalies', label: 'Review flags' },
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
      const [devices, structure] = await Promise.all([
        institutionDevices(a),
        listStructure(a),
      ])
      return {
        devices,
        pending: devices.filter((device) => device.status === 'pending_approval'),
        pendingOptions: devices.filter((device) => device.status === 'pending_approval').map((d) => ({
          value: d.id,
          label: `${d.who} — ${d.label ?? 'unnamed'} (${d.signing})`,
        })),
        activeOptions: devices.filter((device) => device.status === 'active').map((device) => ({ value: device.id, label: `${device.who} — ${device.label ?? 'unnamed'}` })),
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
          { key: 'signing', label: 'Signing' },
          { key: 'fingerprint', label: 'Public key SHA-256', kind: 'code' },
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
        kind: 'table',
        title: 'Registered devices',
        rows: 'devices',
        columns: [{ key: 'who', label: 'Student' }, { key: 'label', label: 'Device' }, { key: 'status', label: 'Status', kind: 'status' }, { key: 'signing', label: 'Signing' }],
      },
      {
        kind: 'form',
        title: 'Revoke a lost device',
        path: '/devices/revoke',
        submit: 'Revoke',
        fields: [{ name: 'deviceId', label: 'Active device', kind: 'select', options: 'activeOptions' }],
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
    path: '/offline-policy',
    title: 'Signed attendance policy',
    menu: 'Offline policy',
    roles: [...ADMIN],
    async load(actor) { return { policy: await offlinePolicy(actor as Actor) } },
    sections(data) {
      const policy = data.policy as Awaited<ReturnType<typeof offlinePolicy>>
      return [
        { kind: 'note', text: 'Signed scans prove possession of an approved device key. Native apps enforce biometric or PIN unlock; the server does not remotely attest secure hardware. Late scans retain their capture and receipt times for review.' },
        { kind: 'form', title: 'Offline acceptance', path: '/offline/policy', submit: 'Save policy', fields: [
          { name: 'requireSignedScans', label: 'Require signed scans', kind: 'checkbox', value: String(policy.requireSignedScans), hint: 'Enabled by default. Accounts with signing keys can never use unsigned scans.' },
          { name: 'acceptLateSync', label: 'Accept late scans and flag them', kind: 'checkbox', value: String(policy.acceptLateSync) },
          { name: 'maxLateSyncHours', label: 'Maximum sync delay (hours)', kind: 'number', value: String(policy.maxLateSyncHours), hint: '1–168 hours; default 24.' },
          { name: 'clockSkewSeconds', label: 'Clock tolerance (seconds)', kind: 'number', value: String(policy.clockSkewSeconds), hint: '0–300 seconds; default 60.' },
        ] },
      ]
    },
  },

  {
    path: '/device',
    title: 'My attendance device',
    menu: 'My device',
    roles: ['student'],
    async load(actor) {
      const devices = await myDevices(actor as Actor)
      return { devices: devices.map((device) => ({ ...device, signing: device.signed ? 'P-256 signing enabled' : 'Enroll a signing key in the mobile app' })), activeOptions: devices.filter((device) => device.status === 'active').map((device) => ({ value: device.id, label: device.label ?? device.deviceHash })) }
    },
    sections: () => [
      { kind: 'note', text: 'Use the CampusOS mobile app to enroll this phone’s signing key. An administrator approves it here before you scan. Every scan asks for biometric or device PIN verification. Replacing a phone requires a new key and approval.' },
      { kind: 'table', title: 'My devices', rows: 'devices', columns: [{ key: 'label', label: 'Device' }, { key: 'status', label: 'Status', kind: 'status' }, { key: 'signing', label: 'Signing' }] },
      { kind: 'form', title: 'Revoke my lost phone', path: '/devices/revoke', submit: 'Revoke', fields: [{ name: 'deviceId', label: 'Device', kind: 'select', options: 'activeOptions' }] },
    ],
  },

  myAttendancePage,

  ...summaryPages,
]
