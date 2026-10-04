import type { PluginPage } from '@campusos/module-framework'
import { ADMIN, MEMBERS, listEvents, listProfiles, listRegistrations } from './api'
import { choice, field, form, hidden, people, pick, screen, table } from './ui'

export const pages: PluginPage[] = [
  screen({
    path: '/', title: 'Alumni directory', menu: 'Directory', roles: MEMBERS,
    load: async actor => {
      const office = ADMIN.includes(actor.role)
      const [profiles, identities] = await Promise.all([listProfiles(actor), office ? people(actor) : []])
      return {
        office, profiles, own: profiles.find(row => row.userId === actor.id) ?? null,
        personOptions: identities.map(row => ({ value: row.id, label: `${row.name} · ${row.email}` })),
      }
    },
    sections: data => [
      { kind: 'note', text: 'Profiles start private. Only the profile owner can consent to directory publication and, separately, contact publication. The alumni office can maintain private records.' },
      { kind: 'shortcuts', items: [{ label: 'Alumni events', href: '/m/alumni/events' }, { label: 'Event registrations', href: '/m/alumni/registrations' }] },
      table('Alumni', 'profiles', [{ key: 'name', label: 'Name' }, { key: 'graduationYear', label: 'Graduated' }, { key: 'qualification', label: 'Qualification' }, { key: 'employer', label: 'Employer' }, { key: 'contactEmail', label: 'Consented contact' }]),
      ...(data.office ? [form('Maintain graduate profile', '/profiles', [pick('userId', 'Existing institution member', 'personOptions'), field('graduationYear', 'Graduation year', 'number'), field('qualification', 'Qualification'), field('employer', 'Employer', 'text', true), field('contactEmail', 'Contact email', 'text', true)])] : []),
      ...(data.own ? [form('Update my publication consent', '/profiles/consent', [hidden('profileId', data.own.id), { ...field('publishProfile', 'Publish my profile to institution members', 'checkbox', true), value: String(data.own.publishProfile) }, { ...field('publishContact', 'Also publish my contact email', 'checkbox', true), value: String(data.own.publishContact) }], MEMBERS)] : []),
    ],
  }),
  screen({
    path: '/events', title: 'Alumni events', menu: 'Events', roles: MEMBERS,
    load: async actor => {
      const [events, profiles] = await Promise.all([listEvents(actor), listProfiles(actor)])
      return {
        events, office: ADMIN.includes(actor.role), alumnus: profiles.some(row => row.userId === actor.id),
        eventOptions: events.filter(row => row.status !== 'cancelled').map(row => ({ value: row.id, label: `${row.title} · ${row.status}` })),
        openOptions: events.filter(row => row.status === 'open' && row.registrationDeadline >= new Date().toISOString().slice(0, 10)).map(row => ({ value: row.id, label: `${row.title} · ${row.startsOn}` })),
      }
    },
    sections: data => [
      table('Events', 'events', [{ key: 'title', label: 'Event' }, { key: 'startsOn', label: 'Date', kind: 'date' }, { key: 'registrationDeadline', label: 'Register by', kind: 'date' }, { key: 'venue', label: 'Venue' }, { key: 'capacity', label: 'Capacity' }, { key: 'status', label: 'Status', kind: 'status' }]),
      ...(data.office ? [
        form('Create event', '/events', [field('title', 'Event title'), field('startsOn', 'Event date', 'date'), field('registrationDeadline', 'Registration deadline', 'date'), field('venue', 'Venue'), field('capacity', 'Capacity', 'number')]),
        form('Change event availability', '/events/transition', [pick('eventId', 'Event', 'eventOptions'), { name: 'action', label: 'Action', kind: 'select', options: choice(['open', 'close', 'cancel']) }]),
      ] : []),
      ...(data.alumnus ? [form('Reserve my place', '/registrations', [pick('eventId', 'Open event', 'openOptions')], MEMBERS)] : [{ kind: 'note' as const, text: 'An alumni profile is required to reserve a place. Contact the alumni office.' }]),
    ],
  }),
  screen({
    path: '/registrations', title: 'Event registrations', menu: 'Registrations', roles: MEMBERS,
    load: async actor => {
      const registrations = await listRegistrations(actor)
      return { registrations, registrationOptions: registrations.filter(row => row.status === 'active').map(row => ({ value: row.id, label: `${row.event} · ${row.name}` })) }
    },
    sections: () => [
      table('Registrations', 'registrations', [{ key: 'event', label: 'Event' }, { key: 'name', label: 'Alumnus' }, { key: 'status', label: 'Status', kind: 'status' }]),
      form('Cancel registration', '/registrations/cancel', [pick('registrationId', 'Active reservation', 'registrationOptions')], MEMBERS),
    ],
  }),
]
