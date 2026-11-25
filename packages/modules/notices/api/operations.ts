import { and, asc, desc, eq, inArray, isNull, or, sql, type SQL } from 'drizzle-orm'
import { audit, enqueueJob, users, withTenant } from '@campusos/db'
import {
  ADMIN,
  cursorColumn,
  finishPage,
  keyset,
  orderKeys,
  readPage,
  readUpload,
  searchAny,
  UploadError,
  type Page,
  type PageRequest,
  type Role,
  type SortSpec,
} from '@campusos/module-framework'
import { departments } from '@campusos/module-academic/schema'
import { noticeAttachments, notices, notificationMandatory, notificationOptOuts, notifications } from '../schema'
import {
  attachSchema,
  createNoticeSchema,
  mandatorySchema,
  markReadSchema,
  preferenceSchema,
  removeAttachmentSchema,
  publishNoticeSchema,
  withdrawNoticeSchema,
  type Inbox,
  type NoticeRow,
} from './schemas'
import { departmentRecipientsSql, guardiansAvailable, memberDepartments, ownDepartments } from './department-audience'

const MODULE = 'notices'

export interface Actor {
  id: string
  email?: string | null
  role: Role
  institutionId: string | null
}

export class NoticeError extends Error {
  constructor(
    readonly status: 400 | 403 | 404 | 409,
    readonly code: string,
    message: string,
  ) {
    super(message)
  }
}

type Tx = Parameters<Parameters<typeof withTenant>[1]>[0]

const tenantOf = (actor: Actor): string => {
  if (!actor.institutionId) {
    throw new NoticeError(400, 'no_institution', 'no institution for this session')
  }
  return actor.institutionId
}

/** Who may put something on the board. A student may not. */
const canPost = (r: Role) =>
  r === 'super_admin' ||
  r === 'institution_admin' ||
  r === 'hod' ||
  r === 'faculty' ||
  r === 'accounts_staff' ||
  r === 'library_staff' ||
  r === 'hostel_staff'

type Authority = Pick<typeof notices.$inferSelect, 'authorId' | 'departmentId'>

/**
 * Whoever may post can manage an institution-wide notice as before. A
 * department's notice is managed by its author while that person may still
 * post, and by either administrator (FUNC-06).
 */
const canManageNotice = (actor: Actor, row: Authority) =>
  canPost(actor.role) && (row.departmentId === null || (ADMIN as readonly Role[]).includes(actor.role) || row.authorId === actor.id)

const requirePoster = (actor: Actor) => {
  const tenant = tenantOf(actor)
  if (!canPost(actor.role)) throw new NoticeError(403, 'forbidden', 'not permitted')
  return tenant
}

// --- the inbox other modules write into ------------------------------------

/**
 * A category is the raising module's id. Add one here when a module starts
 * notifying; `notify` refuses any other.
 */
export const NOTIFICATION_CATEGORIES: Record<string, string> = {
  notices: 'Notices',
  attendance: 'Attendance',
  examinations: 'Results',
  fees: 'Fees',
  hr: 'Staff leave',
  mentoring: 'Mentoring and student leave',
  placement: 'Placement',
  care: 'Student care',
  crm: 'Sales CRM',
  reports: 'Scheduled reports',
}

const unknownCategory = () => new NoticeError(400, 'unknown_category', 'no such notification category')

export interface Delivery {
  notificationId: string
  institutionId: string
  userId: string
  moduleId: string
  title: string
  body: string
  link: string | null
}

/**
 * Runs inside the caller's transaction. A channel only records what it will send (for example by enqueueing a job); it never calls the network here, and if it throws, the caller's write rolls back.
 */
export interface NotificationChannel {
  id: string
  deliver(tx: Tx, deliveries: Delivery[]): Promise<void>
}

const channels = new Map<string, NotificationChannel>()

/** Add a delivery channel beside the in-app inbox. Returns a function that removes it. */
export function registerNotificationChannel(channel: NotificationChannel): () => void {
  if (channels.has(channel.id)) throw new Error(`channel ${channel.id} is already registered`)
  channels.set(channel.id, channel)
  return () => {
    channels.delete(channel.id)
  }
}

async function dispatch(
  tx: Tx,
  institutionId: string,
  moduleId: string,
  title: string,
  body: string,
  link: string | null,
  inserted: { id: string; userId: string }[],
) {
  if (channels.size === 0 || inserted.length === 0) return
  const deliveries: Delivery[] = inserted.map((r) => ({ notificationId: r.id, institutionId, userId: r.userId, moduleId, title, body, link }))
  for (const c of channels.values()) await c.deliver(tx, deliveries)
}

export interface NotifyInput {
  userIds: string[]
  moduleId: string
  title: string
  body: string
  link?: string | null
  noticeId?: string | null
  /** Also tell every current guardian of each person in `userIds`, with this link. */
  alsoGuardians?: { link: string }
}

// One array literal, not one parameter per element (see `fanOut`); user ids are
// Auth.js text ids with no commas or braces.
const literal = (ids: string[]) => `{${ids.join(',')}}`

/** Who of `userIds` has muted the category, unless the institution made it mandatory. */
async function mutedAmong(tx: Tx, institutionId: string, moduleId: string, userIds: string[]): Promise<Set<string>> {
  const rows = (await tx.execute(sql`
    select o.user_id from notification_opt_outs o
     where o.module_id = ${moduleId}
       and o.user_id = any(${literal(userIds)}::text[])
       and not exists (select 1 from notification_mandatory m where m.institution_id = ${institutionId} and m.module_id = ${moduleId})`)).rows as { user_id: string }[]
  return new Set(rows.map((r) => r.user_id))
}

async function deliverTo(tx: Tx, institutionId: string, input: NotifyInput, userIds: string[], link: string | null): Promise<number> {
  if (userIds.length === 0) return 0
  const muted = await mutedAmong(tx, institutionId, input.moduleId, userIds)
  const recipients = userIds.filter((u) => !muted.has(u))
  if (recipients.length === 0) return 0

  const inserted = await tx
    .insert(notifications)
    .values(
      recipients.map((userId) => ({
        institutionId,
        userId,
        moduleId: input.moduleId,
        title: input.title,
        body: input.body,
        link,
        noticeId: input.noticeId ?? null,
      })),
    )
    .returning({ id: notifications.id, userId: notifications.userId })
  await dispatch(tx, institutionId, input.moduleId, input.title, input.body, link, inserted)
  return inserted.length
}

/**
 * Raise a notification for a set of people, inside an existing transaction.
 *
 * Takes a `tx` rather than opening its own, so a module can notify in the same
 * transaction as the thing it is notifying about: either the fee is recorded
 * and the student is told, or neither happened. A notification about a write
 * that rolled back is worse than no notification.
 *
 * The one delivery path (P1-02): it applies each person's opt-outs and the
 * institution's mandatory categories, can also tell guardians, and hands every
 * row it wrote to the registered channels.
 */
export async function notify(tx: Tx, institutionId: string, input: NotifyInput): Promise<number> {
  if (!(input.moduleId in NOTIFICATION_CATEGORIES)) throw unknownCategory()
  const students = [...new Set(input.userIds)]
  let n = await deliverTo(tx, institutionId, input, students, input.link ?? null)
  if (input.alsoGuardians && students.length > 0) {
    // The parents module owns this function; without its migrations nobody is a guardian.
    const [ok] = (await tx.execute(sql`select to_regprocedure('public.campusos_guardians_of(text[])') is not null as ok`)).rows as { ok: boolean }[]
    if (ok?.ok) {
      const rows = (await tx.execute(sql`select distinct guardian_id from public.campusos_guardians_of(${literal(students)}::text[])`)).rows as { guardian_id: string }[]
      n += await deliverTo(tx, institutionId, input, rows.map((r) => r.guardian_id).filter((g) => !students.includes(g)), input.alsoGuardians.link)
    }
  }
  return n
}

// --- preferences -----------------------------------------------------------

export async function preferences(actor: Actor) {
  const tenant = tenantOf(actor)
  return withTenant(tenant, async (tx) => {
    const muted = new Set((await tx.select({ m: notificationOptOuts.moduleId }).from(notificationOptOuts).where(eq(notificationOptOuts.userId, actor.id))).map((r) => r.m))
    const mandatory = new Set((await tx.select({ m: notificationMandatory.moduleId }).from(notificationMandatory)).map((r) => r.m))
    return {
      categories: Object.entries(NOTIFICATION_CATEGORIES).map(([moduleId, label]) => ({
        moduleId,
        label,
        muted: muted.has(moduleId),
        mandatory: mandatory.has(moduleId),
      })),
    }
  })
}

/** A person mutes or unmutes a category for themselves. */
export async function setPreference(actor: Actor, input: unknown) {
  const tenant = tenantOf(actor)
  if (actor.role === 'pending') throw new NoticeError(403, 'forbidden', 'not permitted')
  const d = preferenceSchema.parse(input)
  const label = NOTIFICATION_CATEGORIES[d.moduleId]
  if (!label) throw unknownCategory()

  return withTenant(tenant, async (tx) => {
    if (d.muted) {
      const [m] = await tx.select().from(notificationMandatory).where(eq(notificationMandatory.moduleId, d.moduleId))
      if (m) throw new NoticeError(409, 'category_mandatory', 'the institution has made this category mandatory')
      await tx.insert(notificationOptOuts).values({ institutionId: tenant, userId: actor.id, moduleId: d.moduleId }).onConflictDoNothing()
    } else {
      await tx.delete(notificationOptOuts).where(and(eq(notificationOptOuts.userId, actor.id), eq(notificationOptOuts.moduleId, d.moduleId)))
    }
    return { notice: d.muted ? `${label} no longer reaches your inbox.` : `${label} reaches your inbox again.` }
  })
}

/** An administrator makes a category mandatory for everybody, or optional again. */
export async function setMandatory(actor: Actor, input: unknown) {
  const tenant = tenantOf(actor)
  if (!(ADMIN as readonly Role[]).includes(actor.role)) throw new NoticeError(403, 'forbidden', 'not permitted')
  const d = mandatorySchema.parse(input)
  const label = NOTIFICATION_CATEGORIES[d.moduleId]
  if (!label) throw unknownCategory()

  return withTenant(tenant, async (tx) => {
    if (d.mandatory) {
      await tx.insert(notificationMandatory).values({ institutionId: tenant, moduleId: d.moduleId }).onConflictDoNothing()
    } else {
      await tx.delete(notificationMandatory).where(eq(notificationMandatory.moduleId, d.moduleId))
    }
    await audit(tx, {
      institutionId: tenant,
      actorId: actor.id,
      actorEmail: actor.email ?? null,
      moduleId: MODULE,
      action: d.mandatory ? 'notifications.mandatory_set' : 'notifications.mandatory_cleared',
      entity: 'notification_mandatory',
      entityId: d.moduleId,
      reason: d.reason,
      detail: { moduleId: d.moduleId },
    })
    return { notice: d.mandatory ? `${label} is mandatory for everybody.` : `${label} is optional again.` }
  })
}

// --- notices ---------------------------------------------------------------

export async function createNotice(actor: Actor, input: unknown) {
  const tenant = requirePoster(actor)
  const d = createNoticeSchema.parse(input)

  // A lecturer addresses their own people; only administration addresses staff.
  if (actor.role === 'faculty' && d.audienceRoles.some((r) => r !== 'student')) {
    throw new NoticeError(
      403,
      'audience_too_wide',
      'a lecturer may post to students; wider notices come from the office',
    )
  }
  // No audience named is everybody, which a lecturer may not address (NEW-160).
  const audienceRoles = actor.role === 'faculty' && d.audienceRoles.length === 0 ? ['student' as const] : d.audienceRoles

  // Read before anything is written: a file that is not what it says it is
  // refuses the notice, rather than leaving one posted without its document.
  const file = d.attachment ? readUploadOr(d.attachment) : null

  return attached(async () =>
    withTenant(tenant, async (tx) => {
      if (d.departmentId) {
        // The foreign key names the department by id alone; RLS makes another
        // institution's department invisible here.
        const [dept] = await tx.select({ id: departments.id }).from(departments).where(eq(departments.id, d.departmentId))
        if (!dept) throw new NoticeError(404, 'no_such_department', 'no such department')
        // A lecturer addresses their own departments; administration addresses any (NEW-163).
        if (actor.role === 'faculty' && !(await ownDepartments(tx, tenant, actor.id)).includes(dept.id))
          throw new NoticeError(403, 'department_not_yours', 'a lecturer may address only their own departments')
      }
      const now = new Date()
      // Written as a draft, given its document, then published: a document
      // goes on a notice only while nobody has been sent it.
      const [row] = await tx
        .insert(notices)
        .values({
          institutionId: tenant,
          title: d.title,
          body: d.body,
          kind: d.kind,
          audienceRoles,
          departmentId: d.departmentId ?? null,
          pinned: d.pinned ? now : null,
          publishedAt: null,
          expiresAt: d.expiresAt ? new Date(d.expiresAt) : null,
          authorId: actor.id,
        })
        .returning()
      await audit(tx, {
        institutionId: tenant,
        actorId: actor.id,
        actorEmail: actor.email ?? null,
        moduleId: MODULE,
        action: 'notice.created',
        entity: 'notices',
        entityId: row!.id,
        reason: 'Created notice',
        detail: { departmentId: row!.departmentId, kind: row!.kind, audienceRoles: row!.audienceRoles, pinned: row!.pinned !== null },
      })

      if (file) await attach(tx, tenant, actor, row!.id, file)
      if (!d.publish) return row!
      await publishRowWithin(tx, actor, row!, now)
      return { ...row!, publishedAt: now }
    }),
  )
}

// --- documents attached to a notice ----------------------------------------------

export const DOCUMENT_TYPES = ['application/pdf', 'image/png', 'image/jpeg']

const ATTACHMENT_REFUSALS: Record<string, [400 | 409, string]> = {
  notice_attachment_published: [409, 'that notice is published; its documents stay as they were sent'],
  notice_attachments_count: [409, 'a notice carries five documents at most'],
  notice_attachment_fixed: [409, 'an attached document is kept as it was sent'],
  notice_attachments_name: [400, 'the document needs a name'],
}

async function attached<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn()
  } catch (e) {
    if (e instanceof UploadError) throw new NoticeError(400, e.code, e.message)
    const c = (e as { cause?: { constraint?: string } }).cause?.constraint
    const known = c ? ATTACHMENT_REFUSALS[c] : undefined
    if (known) throw new NoticeError(known[0], c!, known[1])
    throw e
  }
}

async function attach(tx: Tx, tenant: string, actor: Actor, noticeId: string, file: ReturnType<typeof readUpload>) {
  const [row] = await tx
    .insert(noticeAttachments)
    .values({
      institutionId: tenant,
      noticeId,
      name: file.name,
      type: file.type,
      size: file.size,
      sha256: file.sha256,
      content: file.bytes,
      addedBy: actor.id,
    })
    .returning({ id: noticeAttachments.id })
  await audit(tx, {
    institutionId: tenant,
    actorId: actor.id,
    actorEmail: actor.email ?? null,
    moduleId: MODULE,
    action: 'notice.attachment_added',
    entity: 'notice_attachments',
    entityId: row!.id,
    reason: 'Attached notice document',
    detail: { noticeId, type: file.type, size: file.size },
  })
  return row!.id
}

/** Attach a document to a draft. A lecturer, to their own. */
export async function addAttachment(actor: Actor, input: unknown) {
  const tenant = requirePoster(actor)
  const d = attachSchema.parse(input)
  const file = readUploadOr(d.file)
  return attached(() =>
    withTenant(tenant, async (tx) => {
      const [n] = await tx.select().from(notices).where(eq(notices.id, d.noticeId))
      if (!n || !canManageNotice(actor, n)) throw new NoticeError(404, 'no_such_notice', 'no such notice')
      if (actor.role === 'faculty' && n.authorId !== actor.id) {
        throw new NoticeError(403, 'not_yours', 'that notice is not yours')
      }
      const id = await attach(tx, tenant, actor, n.id, file)
      return { id, notice: `${file.name} is attached. It goes out with the notice when it is published.` }
    }),
  )
}

const readUploadOr = (value: unknown) => {
  try {
    return readUpload(value, { types: DOCUMENT_TYPES, what: 'the document' })
  } catch (e) {
    if (e instanceof UploadError) throw new NoticeError(400, e.code, e.message)
    throw e
  }
}

/** Take a document off a draft. */
export async function removeAttachment(actor: Actor, input: unknown) {
  const tenant = requirePoster(actor)
  const d = removeAttachmentSchema.parse(input)
  return attached(() =>
    withTenant(tenant, async (tx) => {
      const [a] = await tx
        .select({
          id: noticeAttachments.id,
          name: noticeAttachments.name,
          type: noticeAttachments.type,
          size: noticeAttachments.size,
          noticeId: noticeAttachments.noticeId,
          authorId: notices.authorId,
          departmentId: notices.departmentId,
        })
        .from(noticeAttachments)
        .innerJoin(notices, eq(notices.id, noticeAttachments.noticeId))
        .where(eq(noticeAttachments.id, d.attachmentId))
      if (!a || !canManageNotice(actor, a)) throw new NoticeError(404, 'no_such_document', 'no such document')
      if (actor.role === 'faculty' && a.authorId !== actor.id) {
        throw new NoticeError(403, 'not_yours', 'that notice is not yours')
      }
      const [gone] = await tx.delete(noticeAttachments).where(eq(noticeAttachments.id, a.id)).returning({ id: noticeAttachments.id })
      if (gone) {
        await audit(tx, {
          institutionId: tenant,
          actorId: actor.id,
          actorEmail: actor.email ?? null,
          moduleId: MODULE,
          action: 'notice.attachment_removed',
          entity: 'notice_attachments',
          entityId: gone.id,
          reason: 'Removed notice document',
          detail: { noticeId: a.noticeId, type: a.type, size: a.size },
        })
      }
      return { notice: `${a.name} is taken off.` }
    }),
  )
}

/** The documents of a notice, without their bytes. */
async function documentsOf(tx: Tx, noticeId: string) {
  return tx
    .select({
      id: noticeAttachments.id,
      name: noticeAttachments.name,
      type: noticeAttachments.type,
      size: noticeAttachments.size,
      sha256: noticeAttachments.sha256,
    })
    .from(noticeAttachments)
    .where(eq(noticeAttachments.noticeId, noticeId))
    .orderBy(asc(noticeAttachments.createdAt))
}

/** One notice, whole: its text and its documents, for whoever may read it. */
export async function noticeView(actor: Actor, noticeId: string) {
  const tenant = tenantOf(actor)
  return withTenant(tenant, async (tx) => {
    const { notice, authority } = await readNoticeWithin(tx, actor, tenant, noticeId)
    const documents = await documentsOf(tx, noticeId)
    return { notice, documents, canPost: canManageNotice(actor, authority) }
  })
}

/** A document's bytes, for whoever may read the notice it is on. */
export async function attachmentFile(actor: Actor, attachmentId: string) {
  const tenant = tenantOf(actor)
  return withTenant(tenant, async (tx) => {
    const [a] = await tx.select().from(noticeAttachments).where(eq(noticeAttachments.id, attachmentId))
    if (!a) throw new NoticeError(404, 'no_such_document', 'no such document')
    // The same answer as for a notice this reader may not see: not found.
    await readNoticeWithin(tx, actor, tenant, a.noticeId).catch(() => {
      throw new NoticeError(404, 'no_such_document', 'no such document')
    })
    return a
  })
}

/**
 * Deliver a published notice to everybody it addresses.
 *
 * One `insert ... select`, not a loop: the audience is a query over `users`,
 * and pulling a roster into the application to push it back one row at a time
 * is how a notice to two thousand students becomes a timeout.
 */
async function fanOut(tx: Tx, tenant: string, noticeId: string): Promise<number> {
  const [notice] = await tx.select().from(notices).where(eq(notices.id, noticeId))
  if (!notice?.publishedAt) return 0

  const link = `/m/notices/notice?id=${notice.id}`
  // One array literal, not one parameter per element: a JS array interpolated
  // into a tagged template is flattened into separate placeholders, and
  // Postgres then reads the first of them as a malformed array.
  const audience = `{${notice.audienceRoles.join(',')}}`

  // A department's notice reaches its current members, computed once in this statement (D927, D928).
  const scoped = notice.departmentId !== null
  const members = scoped
    ? sql`with department_recipients as materialized (${departmentRecipientsSql(tenant, sql`${notice.departmentId}::uuid`, await guardiansAvailable(tx))})`
    : sql``
  const inScope = scoped ? sql`and u.erased_at is null and u.id in (select user_id from department_recipients)` : sql``

  const inserted = await tx.execute(sql`
    ${members}
    insert into notifications
      (institution_id, user_id, module_id, title, body, link, notice_id)
    select ${tenant}, u.id, ${MODULE}, ${notice.title}, ${notice.body}, ${link}, ${notice.id}
      from users u
     where u.institution_id = ${tenant}
       and u.role <> 'pending'
       and not exists (select 1 from notification_opt_outs o where o.user_id = u.id and o.module_id = ${MODULE}
                         and not exists (select 1 from notification_mandatory m where m.institution_id = ${tenant} and m.module_id = ${MODULE}))
       and (cardinality(${audience}::role[]) = 0
            or u.role = any(${audience}::role[]))
       ${inScope}
    on conflict do nothing
    returning id, user_id
  `)
  const rows = (inserted.rows as { id: string; user_id: string }[]).map((r) => ({ id: r.id, userId: r.user_id }))
  await dispatch(tx, tenant, MODULE, notice.title, notice.body, link, rows)
  return rows.length
}

export async function publishNotice(actor: Actor, input: unknown) {
  const tenant = requirePoster(actor)
  const d = publishNoticeSchema.parse(input)

  return withTenant(tenant, async (tx) => {
    if (d.queued) {
      const [notice] = await tx.select().from(notices).where(eq(notices.id, d.noticeId)).for('update')
      if (notice && !canManageNotice(actor, notice)) throw new NoticeError(404, 'no_such_notice', 'no such notice')
      if (!notice || notice.publishedAt) throw new NoticeError(409, 'not_a_draft', 'select an unpublished draft')
      await ownsDepartmentOf(tx, actor, notice)
      const job = await enqueueJob(tx, { institutionId: tenant, actorId: actor.id, kind: 'notices.publish', dedupeKey: `notice:${d.noticeId}`, payload: { noticeId: d.noticeId } })
      return { id: d.noticeId, queued: true, jobId: job.id, reach: 0 }
    }
    return publishWithin(tx, actor, d.noticeId)
  })
}

/** A lecturer's department draft goes out only while the department is still theirs (NEW-163); office staff address any. */
async function ownsDepartmentOf(tx: Tx, actor: Actor, notice: { departmentId: string | null; institutionId: string }) {
  if (actor.role !== 'faculty' || !notice.departmentId) return
  if (!(await ownDepartments(tx, notice.institutionId, actor.id)).includes(notice.departmentId))
    throw new NoticeError(403, 'department_not_yours', 'a lecturer may address only their own departments')
}

export async function publishWithin(tx: Tx, actor: Actor, noticeId: string) {
    requirePoster(actor)
    const [row] = await tx.select().from(notices).where(eq(notices.id, noticeId)).for('update')
    if (!row || !canManageNotice(actor, row)) throw new NoticeError(404, 'no_such_notice', 'no such notice')
    if (row.publishedAt) throw new NoticeError(409, 'already_published', 'already published')
    if (row.expiresAt && row.expiresAt <= new Date()) throw new NoticeError(409, 'notice_expired', 'the notice has expired')
    if (actor.role === 'faculty' && row.audienceRoles.some((role) => role !== 'student')) throw new NoticeError(403, 'audience_too_wide', 'a lecturer may post to students')
    await ownsDepartmentOf(tx, actor, row)

    const reach = await publishRowWithin(tx, actor, row, new Date())
    return { id: noticeId, reach }
}

/**
 * The one publication path, for an immediate post, an explicit publish and the
 * worker: write the publication and the effective audience together, deliver,
 * and record the actual reach. A failure anywhere rolls all of it back.
 */
async function publishRowWithin(tx: Tx, actor: Actor, row: typeof notices.$inferSelect, publishedAt: Date): Promise<number> {
  const audienceRoles = actor.role === 'faculty' && row.audienceRoles.length === 0 ? ['student' as const] : row.audienceRoles
  await tx.update(notices).set({ publishedAt, audienceRoles }).where(eq(notices.id, row.id))
  const reach = await fanOut(tx, row.institutionId, row.id)
  await audit(tx, {
    institutionId: row.institutionId,
    actorId: actor.id,
    actorEmail: actor.email ?? null,
    moduleId: MODULE,
    action: 'publish',
    entity: 'notice',
    entityId: row.id,
    reason: 'Publish notice',
    detail: { reach, departmentId: row.departmentId, audienceRoles },
  })
  return reach
}

/**
 * Take a notice down. Audited: a circular that was on the board and then was
 * not is a thing people remember and ask about.
 */
export async function withdrawNotice(actor: Actor, input: unknown) {
  const tenant = requirePoster(actor)
  const d = withdrawNoticeSchema.parse(input)

  return withTenant(tenant, async (tx) => {
    const [row] = await tx.select().from(notices).where(eq(notices.id, d.noticeId)).for('update')
    if (!row || !canManageNotice(actor, row)) throw new NoticeError(404, 'no_such_notice', 'no such notice')
    if (actor.role === 'faculty' && row.authorId !== actor.id) {
      throw new NoticeError(403, 'not_yours', 'that notice is not yours to withdraw')
    }

    await audit(tx, {
      institutionId: tenant,
      actorId: actor.id,
      actorEmail: actor.email ?? null,
      moduleId: MODULE,
      action: 'notice.withdrawn',
      entity: 'notices',
      entityId: row.id,
      reason: d.reason,
      detail: { title: row.title, publishedAt: row.publishedAt },
    })

    await tx.update(notices).set({ expiresAt: new Date() }).where(eq(notices.id, d.noticeId))
    // The inbox copies go with it: an inbox item linking to a withdrawn notice
    // is a dead end the reader cannot resolve.
    await tx.delete(notifications).where(eq(notifications.noticeId, d.noticeId))
  })
}

/**
 * What the reader may see. Institution-wide notices: drafts for a poster who
 * asks, else published, current and addressed to their role. A department's
 * notice: its managers (author, administrators) see it, drafts included on
 * request; everybody else sees it only while published, current, addressed to
 * their role and while they belong to the department (D929).
 */
function boardWhere(actor: Actor, includeDrafts: boolean, mine: string[]): SQL {
  const poster = canPost(actor.role)
  const current = sql`(${notices.publishedAt} is not null and (${notices.expiresAt} is null or ${notices.expiresAt} > now()))`
  const roleOk = sql`(cardinality(${notices.audienceRoles}) = 0 or ${actor.role}::role = any(${notices.audienceRoles}))`
  const unscoped = and(isNull(notices.departmentId), poster && includeDrafts ? undefined : and(current, poster ? undefined : roleOk))
  const manager = !poster
    ? sql`false`
    : (ADMIN as readonly Role[]).includes(actor.role)
      ? sql`true`
      : sql`${notices.authorId} = ${actor.id}`
  const member = sql`${notices.departmentId} = any(${literal(mine)}::uuid[])`
  const scoped = and(
    sql`${notices.departmentId} is not null`,
    or(and(manager, includeDrafts ? sql`true` : current), and(current, roleOk, member)),
  )
  return or(unscoped, scoped)!
}

// -infinity sorts last under desc: an unpinned notice is never above a pinned one.
const NOTICE_SORTS: SortSpec = {
  when: {
    dir: 'desc',
    keys: [
      { sql: sql`coalesce(${notices.pinned}, '-infinity'::timestamptz)`, type: 'timestamptz' },
      { sql: sql`coalesce(${notices.publishedAt}, '-infinity'::timestamptz)`, type: 'timestamptz' },
      { sql: sql`${notices.createdAt}`, type: 'timestamptz' },
      { sql: sql`${notices.id}`, type: 'uuid' },
    ],
  },
  title: { dir: 'asc', keys: [{ sql: sql`${notices.title}`, type: 'text' }, { sql: sql`${notices.id}`, type: 'uuid' }] },
}
export const noticePage = (req: Request, prefix: string) => readPage(req, prefix, NOTICE_SORTS, 'when')

const noticeColumns = {
  id: notices.id,
  title: notices.title,
  body: notices.body,
  kind: notices.kind,
  audienceRoles: notices.audienceRoles,
  departmentCode: departments.code,
  pinned: notices.pinned,
  publishedAt: notices.publishedAt,
  expiresAt: notices.expiresAt,
  authorName: users.name,
  reach: sql<number>`(select count(*) from ${notifications} n where n.notice_id = notices.id)`.mapWith(Number),
  readCount: sql<number>`(select count(*) from ${notifications} n
                           where n.notice_id = notices.id and n.read_at is not null)`.mapWith(Number),
  files: sql<number>`(select count(*) from notice_attachments a where a.notice_id = notices.id)`.mapWith(Number),
}

const toRow = <R extends { pinned: Date | null; publishedAt: Date | null; expiresAt: Date | null }>(r: R) => ({
  ...r,
  pinned: r.pinned !== null,
  publishedAt: r.publishedAt?.toISOString() ?? null,
  expiresAt: r.expiresAt?.toISOString() ?? null,
})

/**
 * The board, as this actor sees it, one page at a time. Drafts are visible to
 * whoever may post; everybody else sees what is published, current, and
 * addressed to them.
 */
export async function board(
  actor: Actor,
  includeDrafts = false,
  page: PageRequest = noticePage(new Request('https://x/'), ''),
): Promise<Page<NoticeRow>> {
  const tenant = tenantOf(actor)
  const keys = NOTICE_SORTS[page.sort]!.keys

  return withTenant(tenant, async (tx): Promise<Page<NoticeRow>> => {
    const visible = and(
      boardWhere(actor, includeDrafts, await memberDepartments(tx, tenant, actor.id)),
      searchAny(page.q, [sql`${notices.title}`, sql`${notices.body}`]),
    )
    const rows = await tx
      .select({ ...noticeColumns, _cursor: cursorColumn(keys) })
      .from(notices)
      .leftJoin(departments, eq(departments.id, notices.departmentId))
      .leftJoin(users, eq(users.id, notices.authorId))
      .where(and(visible, keyset(keys, page)))
      .orderBy(...orderKeys(keys, page.dir))
      .limit(page.limit + 1)
    const [counted] = await tx
      .select({ total: sql<number>`count(*)::int` })
      .from(notices)
      .where(visible)
    return finishPage(rows.map(toRow), page, counted!.total)
  })
}

/** The drafts this poster may work on, for the "attach to a draft" picker. */
export async function draftChoices(actor: Actor): Promise<{ value: string; label: string }[]> {
  const tenant = tenantOf(actor)
  const admin = (ADMIN as readonly Role[]).includes(actor.role)
  // ponytail: unbounded; drafts are few. Page it if an office keeps hundreds.
  const rows = await withTenant(tenant, (tx) =>
    tx
      .select({ value: notices.id, label: notices.title })
      .from(notices)
      .where(and(isNull(notices.publishedAt), admin ? undefined : or(isNull(notices.departmentId), eq(notices.authorId, actor.id))))
      .orderBy(desc(notices.createdAt)),
  )
  return rows
}

/** The departments a poster may address, by code then id. */
export async function departmentChoices(actor: Actor): Promise<{ value: string; label: string }[]> {
  const tenant = requirePoster(actor)
  const rows = await withTenant(tenant, async (tx) => {
    const own = actor.role === 'faculty' ? await ownDepartments(tx, tenant, actor.id) : null
    const all = await tx.select({ id: departments.id, code: departments.code, name: departments.name }).from(departments).orderBy(asc(departments.code), asc(departments.id))
    return own ? all.filter((d) => own.includes(d.id)) : all
  })
  return rows.map((r) => ({ value: r.id, label: `${r.code} — ${r.name}` }))
}

/**
 * Of the notices on the board page, the ones this poster may withdraw, in the
 * page's order: a department's notice by its manager, an institution-wide one
 * by whoever may withdraw it (a lecturer, only their own).
 */
export async function withdrawChoices(actor: Actor, visibleIds: string[]): Promise<{ value: string; label: string }[]> {
  const tenant = requirePoster(actor)
  if (visibleIds.length === 0) return []
  const rows = await withTenant(tenant, (tx) =>
    tx
      .select({ id: notices.id, title: notices.title, authorId: notices.authorId, departmentId: notices.departmentId })
      .from(notices)
      .where(inArray(notices.id, visibleIds)),
  )
  const byId = new Map(rows.map((r) => [r.id, r]))
  return visibleIds.flatMap((id) => {
    const r = byId.get(id)
    if (!r || !canManageNotice(actor, r)) return []
    if (r.departmentId === null && actor.role === 'faculty' && r.authorId !== actor.id) return []
    return [{ value: r.id, label: r.title }]
  })
}

/**
 * One notice for this reader, inside the caller's transaction, with the columns
 * that decide who manages it. Not found whenever the reader may not see it.
 */
async function readNoticeWithin(tx: Tx, actor: Actor, tenant: string, noticeId: string) {
  const [row] = await tx
    .select({ ...noticeColumns, _authorId: notices.authorId, _departmentId: notices.departmentId })
    .from(notices)
    .leftJoin(departments, eq(departments.id, notices.departmentId))
    .leftJoin(users, eq(users.id, notices.authorId))
    .where(and(boardWhere(actor, canPost(actor.role), await memberDepartments(tx, tenant, actor.id)), eq(notices.id, noticeId)))
    .limit(1)
  if (!row) throw new NoticeError(404, 'no_such_notice', 'no such notice')
  const { _authorId, _departmentId, ...visible } = row
  return { notice: toRow(visible) as NoticeRow, authority: { authorId: _authorId, departmentId: _departmentId } satisfies Authority }
}

export async function readNotice(actor: Actor, noticeId: string): Promise<NoticeRow> {
  const tenant = tenantOf(actor)
  return withTenant(tenant, async (tx) => (await readNoticeWithin(tx, actor, tenant, noticeId)).notice)
}

// --- the notification centre -----------------------------------------------

/**
 * A copy is shown only while its notice still addresses this person (D930). An
 * institution-wide notice, or a copy with no notice, is as before. A
 * department's notice must be published, current, addressed to their role, and
 * they must belong to the department now, so a transfer hides the old copy.
 * The copy stays in storage.
 */
function inboxVisible(actor: Actor, tenant: string, mine: string[]): SQL {
  return sql`(${notifications.noticeId} is null or exists (
    select 1 from notices n
     where n.institution_id = ${tenant} and n.id = ${notifications.noticeId}
       and (n.department_id is null
            or (n.published_at is not null and (n.expires_at is null or n.expires_at > now())
                and (cardinality(n.audience_roles) = 0 or ${actor.role}::role = any(n.audience_roles))
                and n.department_id = any(${literal(mine)}::uuid[]))))
  )`
}

export async function inbox(actor: Actor, unreadOnly = false): Promise<Inbox> {
  const tenant = tenantOf(actor)

  return withTenant(tenant, async (tx): Promise<Inbox> => {
    const visible = inboxVisible(actor, tenant, await memberDepartments(tx, tenant, actor.id))
    const items = await tx
      .select()
      .from(notifications)
      .where(
        and(
          eq(notifications.userId, actor.id),
          unreadOnly ? isNull(notifications.readAt) : undefined,
          visible,
        ),
      )
      .orderBy(desc(notifications.createdAt))
      .limit(100)

    const [counted] = await tx
      .select({ n: sql<number>`count(*)`.mapWith(Number) })
      .from(notifications)
      .where(and(eq(notifications.userId, actor.id), isNull(notifications.readAt), visible))

    return {
      unread: counted?.n ?? 0,
      items: items.map((i) => ({
        id: i.id,
        moduleId: i.moduleId,
        title: i.title,
        body: i.body,
        link: i.link,
        noticeId: i.noticeId,
        readAt: i.readAt?.toISOString() ?? null,
        createdAt: i.createdAt.toISOString(),
      })),
    }
  })
}

export async function markRead(actor: Actor, input: unknown) {
  const tenant = tenantOf(actor)
  const d = markReadSchema.parse(input)

  return withTenant(tenant, async (tx) => {
    const rows = await tx
      .update(notifications)
      .set({ readAt: new Date() })
      .where(
        and(
          eq(notifications.userId, actor.id),
          isNull(notifications.readAt),
          d.notificationId ? eq(notifications.id, d.notificationId) : undefined,
          inboxVisible(actor, tenant, await memberDepartments(tx, tenant, actor.id)),
        ),
      )
      .returning({ id: notifications.id })
    return { marked: rows.length }
  })
}
