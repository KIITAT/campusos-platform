import * as z from 'zod'
import { and, asc, eq, ne, or } from 'drizzle-orm'
import { users, withTenant } from '@campusos/db'
import { ticked } from '@campusos/module-framework'
import { events, profiles, registrations } from '../schema'
import { ADMIN, DomainError, log, person, tenant, type Actor } from './core'
export * from './core'

export const profileSchema = z.object({ userId: z.string().min(1), graduationYear: z.coerce.number().int().min(1900).max(2200), qualification: z.string().trim().min(2).max(200), employer: z.string().trim().max(200).optional(), contactEmail: z.email().optional() })
export const consentSchema = z.object({ profileId: z.uuid(), publishProfile: z.preprocess(ticked, z.boolean()), publishContact: z.preprocess(ticked, z.boolean()) }).refine(data => !data.publishContact || data.publishProfile, 'Contact publication requires profile publication.')
export const eventSchema = z.object({ title: z.string().trim().min(3).max(200), startsOn: z.iso.date(), registrationDeadline: z.iso.date(), capacity: z.coerce.number().int().min(1).max(100000), venue: z.string().trim().min(2).max(200) }).refine(data => data.registrationDeadline <= data.startsOn, 'Registration must close no later than the event.')
export const transitionSchema = z.object({ eventId: z.uuid(), action: z.enum(['open', 'close', 'cancel']) })
export const registrationSchema = z.object({ eventId: z.uuid() })
export const cancelSchema = z.object({ registrationId: z.uuid() })

export async function saveProfile(actor: Actor, input: unknown) {
  const institutionId = tenant(actor, ADMIN)
  const data = profileSchema.parse(input)
  return withTenant(institutionId, async transaction => {
    await person(transaction, data.userId)
    const [row] = await transaction.insert(profiles).values({ institutionId, ...data }).onConflictDoUpdate({ target: [profiles.institutionId, profiles.userId], set: { graduationYear: data.graduationYear, qualification: data.qualification, employer: data.employer ?? null, contactEmail: data.contactEmail ?? null } }).returning()
    await log(transaction, actor, 'profile.saved', row!.id, 'Alumni office maintained the graduate profile')
    return row!
  })
}
export async function setConsent(actor: Actor, input: unknown) {
  const institutionId = tenant(actor)
  const data = consentSchema.parse(input)
  return withTenant(institutionId, async transaction => {
    const [row] = await transaction.update(profiles).set({ publishProfile: data.publishProfile, publishContact: data.publishContact }).where(and(eq(profiles.id, data.profileId), eq(profiles.userId, actor.id))).returning()
    if (!row) throw new DomainError(404, 'not_owner', 'Only the alumnus can give or withdraw this consent.')
    await log(transaction, actor, 'profile.consent', row.id, 'Profile owner updated publication consent')
    return row
  })
}
export async function listProfiles(actor: Actor) {
  return withTenant(tenant(actor), async transaction => {
    const rows = await transaction.select({ id: profiles.id, userId: profiles.userId, name: users.name, graduationYear: profiles.graduationYear, qualification: profiles.qualification, employer: profiles.employer, contactEmail: profiles.contactEmail, publishProfile: profiles.publishProfile, publishContact: profiles.publishContact }).from(profiles).innerJoin(users, eq(users.id, profiles.userId)).where(ADMIN.includes(actor.role) ? undefined : or(eq(profiles.userId, actor.id), eq(profiles.publishProfile, true))).orderBy(asc(users.name)).limit(1000)
    return rows.map(row => ({ ...row, contactEmail: ADMIN.includes(actor.role) || row.userId === actor.id || row.publishContact ? row.contactEmail : null }))
  })
}
export const listEvents = (actor: Actor) => withTenant(tenant(actor), transaction => transaction.select().from(events).where(ADMIN.includes(actor.role) ? undefined : ne(events.status, 'draft')).orderBy(asc(events.startsOn)).limit(1000))
export const listRegistrations = (actor: Actor) => withTenant(tenant(actor), transaction => transaction.select({ id: registrations.id, event: events.title, eventId: events.id, profileId: profiles.id, name: users.name, status: registrations.status }).from(registrations).innerJoin(events, eq(events.id, registrations.eventId)).innerJoin(profiles, eq(profiles.id, registrations.profileId)).innerJoin(users, eq(users.id, profiles.userId)).where(ADMIN.includes(actor.role) ? undefined : eq(profiles.userId, actor.id)).limit(1000))
export async function createEvent(actor: Actor, input: unknown) {
  const institutionId = tenant(actor, ADMIN)
  const data = eventSchema.parse(input)
  return withTenant(institutionId, async transaction => {
    const [row] = await transaction.insert(events).values({ institutionId, ...data }).returning()
    await log(transaction, actor, 'event.created', row!.id, 'Draft alumni event created')
    return row!
  })
}
export async function transitionEvent(actor: Actor, input: unknown) {
  const institutionId = tenant(actor, ADMIN)
  const data = transitionSchema.parse(input)
  return withTenant(institutionId, async transaction => {
    const [row] = await transaction.select().from(events).where(eq(events.id, data.eventId)).for('update')
    if (!row) throw new DomainError(404, 'not_found', 'No such event.')
    if (data.action === 'open' && row.registrationDeadline < new Date().toISOString().slice(0, 10)) throw new DomainError(409, 'registration_closed', 'An event cannot open after its registration deadline.')
    if ((data.action === 'open' && row.status !== 'draft') || (data.action === 'close' && row.status !== 'open') || row.status === 'cancelled') throw new DomainError(409, 'invalid_transition', 'This event transition is not available.')
    const status = { open: 'open', close: 'closed', cancel: 'cancelled' }[data.action]
    const [updated] = await transaction.update(events).set({ status }).where(eq(events.id, row.id)).returning()
    if (status === 'cancelled') await transaction.update(registrations).set({ status: 'cancelled' }).where(eq(registrations.eventId, row.id))
    await log(transaction, actor, `event.${status}`, row.id, 'Alumni office changed event availability')
    return updated!
  })
}
export async function register(actor: Actor, input: unknown) {
  const institutionId = tenant(actor)
  const data = registrationSchema.parse(input)
  return withTenant(institutionId, async transaction => {
    const [event] = await transaction.select().from(events).where(eq(events.id, data.eventId)).for('update')
    if (!event) throw new DomainError(404, 'not_found', 'No event in this institution.')
    if (event.status !== 'open' || event.registrationDeadline < new Date().toISOString().slice(0, 10)) throw new DomainError(409, 'registration_closed', 'Registration is not open.')
    const [profile] = await transaction.select().from(profiles).where(eq(profiles.userId, actor.id))
    if (!profile) throw new DomainError(403, 'not_alumnus', 'The alumni office must register your profile first.')
    const active = await transaction.select().from(registrations).where(and(eq(registrations.eventId, event.id), eq(registrations.status, 'active')))
    if (active.some(row => row.profileId === profile.id)) throw new DomainError(409, 'already_registered', 'You are already registered.')
    if (active.length >= event.capacity) throw new DomainError(409, 'event_full', 'This event is full.')
    const [row] = await transaction.insert(registrations).values({ institutionId, eventId: event.id, profileId: profile.id }).onConflictDoUpdate({ target: [registrations.eventId, registrations.profileId], set: { status: 'active', createdAt: new Date() } }).returning()
    await log(transaction, actor, 'event.registered', row!.id, 'Alumnus reserved a place')
    return row!
  })
}
export async function cancelRegistration(actor: Actor, input: unknown) {
  const institutionId = tenant(actor)
  const data = cancelSchema.parse(input)
  return withTenant(institutionId, async transaction => {
    const [current] = await transaction.select({ id: registrations.id, eventId: registrations.eventId, userId: profiles.userId }).from(registrations).innerJoin(profiles, eq(profiles.id, registrations.profileId)).where(eq(registrations.id, data.registrationId))
    if (!current || (!ADMIN.includes(actor.role) && current.userId !== actor.id)) throw new DomainError(404, 'not_found', 'No accessible registration.')
    await transaction.select().from(events).where(eq(events.id, current.eventId)).for('update')
    const [row] = await transaction.update(registrations).set({ status: 'cancelled' }).where(and(eq(registrations.id, current.id), eq(registrations.status, 'active'))).returning()
    if (!row) throw new DomainError(409, 'already_cancelled', 'Registration already cancelled.')
    await log(transaction, actor, 'event.registration_cancelled', row.id, 'Event registration cancelled and seat released')
    return row
  })
}
