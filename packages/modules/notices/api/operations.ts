import { and, asc, desc, eq, isNull, sql } from 'drizzle-orm'
import { audit, users, withTenant } from '@campusos/db'
import type { Role } from '@campusos/module-framework'
import { departments } from '@campusos/module-academic/schema'
import { notices, notifications } from '../schema'
import { mailConfigured, sendMail } from './channels'
import {
  createNoticeSchema,
  markReadSchema,
  publishNoticeSchema,
  withdrawNoticeSchema,
  type Inbox,
  type NoticeRow,
} from './schemas'

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

const requirePoster = (actor: Actor) => {
  const tenant = tenantOf(actor)
  if (!canPost(actor.role)) throw new NoticeError(403, 'forbidden', 'not permitted')
  return tenant
}

// --- the inbox other modules write into ------------------------------------

export interface NotifyInput {
  userIds: string[]
  moduleId: string
  title: string
  body: string
  link?: string | null
  noticeId?: string | null
}

/**
 * Raise a notification for a set of people, inside an existing transaction.
 *
 * Takes a `tx` rather than opening its own, so a module can notify in the same
 * transaction as the thing it is notifying about: either the fee is recorded
 * and the student is told, or neither happened. A notification about a write
 * that rolled back is worse than no notification.
 */
export async function notify(
  tx: Tx,
  institutionId: string,
  input: NotifyInput,
): Promise<number> {
  const recipients = [...new Set(input.userIds)]
  if (recipients.length === 0) return 0

  const rows = await tx
    .insert(notifications)
    .values(
      recipients.map((userId) => ({
        institutionId,
        userId,
        moduleId: input.moduleId,
        title: input.title,
        body: input.body,
        link: input.link ?? null,
        noticeId: input.noticeId ?? null,
      })),
    )
    .returning({ id: notifications.id })
  return rows.length
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

  return withTenant(tenant, async (tx) => {
    const now = new Date()
    const [row] = await tx
      .insert(notices)
      .values({
        institutionId: tenant,
        title: d.title,
        body: d.body,
        kind: d.kind,
        audienceRoles: d.audienceRoles,
        departmentId: d.departmentId ?? null,
        pinned: d.pinned ? now : null,
        publishedAt: d.publish ? now : null,
        expiresAt: d.expiresAt ? new Date(d.expiresAt) : null,
        authorId: actor.id,
      })
      .returning()

    if (d.publish) await fanOut(tx, tenant, row!.id)
    return row!
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

  const link = `/notices/${notice.id}`
  // One array literal, not one parameter per element: a JS array interpolated
  // into a tagged template is flattened into separate placeholders, and
  // Postgres then reads the first of them as a malformed array.
  const audience = `{${notice.audienceRoles.join(',')}}`

  const inserted = await tx.execute(sql`
    insert into notifications
      (institution_id, user_id, module_id, title, body, link, notice_id)
    select ${tenant}, u.id, ${MODULE}, ${notice.title}, ${notice.body}, ${link}, ${notice.id}
      from users u
     where u.institution_id = ${tenant}
       and u.role <> 'pending'
       and (cardinality(${audience}::role[]) = 0
            or u.role = any(${audience}::role[]))
    on conflict do nothing
    returning id
  `)
  return inserted.rowCount ?? 0
}

export async function publishNotice(actor: Actor, input: unknown) {
  const tenant = requirePoster(actor)
  const d = publishNoticeSchema.parse(input)

  return withTenant(tenant, async (tx) => {
    const [row] = await tx.select().from(notices).where(eq(notices.id, d.noticeId))
    if (!row) throw new NoticeError(404, 'no_such_notice', 'no such notice')
    if (row.publishedAt) throw new NoticeError(409, 'already_published', 'already published')

    await tx
      .update(notices)
      .set({ publishedAt: new Date() })
      .where(eq(notices.id, d.noticeId))
    const reach = await fanOut(tx, tenant, d.noticeId)
    return { id: d.noticeId, reach }
  })
}

/**
 * Take a notice down. Audited: a circular that was on the board and then was
 * not is a thing people remember and ask about.
 */
export async function withdrawNotice(actor: Actor, input: unknown) {
  const tenant = requirePoster(actor)
  const d = withdrawNoticeSchema.parse(input)

  return withTenant(tenant, async (tx) => {
    const [row] = await tx.select().from(notices).where(eq(notices.id, d.noticeId))
    if (!row) throw new NoticeError(404, 'no_such_notice', 'no such notice')
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
 * The board, as this actor sees it. Drafts are visible to whoever may post;
 * everybody else sees what is published, current, and addressed to them.
 */
export async function board(actor: Actor, includeDrafts = false): Promise<NoticeRow[]> {
  const tenant = tenantOf(actor)
  const poster = canPost(actor.role)

  return withTenant(tenant, async (tx): Promise<NoticeRow[]> => {
    const rows = await tx
      .select({
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
        reach: sql<number>`(select count(*) from ${notifications} n where n.notice_id = notices.id)`.mapWith(
          Number,
        ),
        readCount: sql<number>`(select count(*) from ${notifications} n
                                 where n.notice_id = notices.id and n.read_at is not null)`.mapWith(
          Number,
        ),
      })
      .from(notices)
      .leftJoin(departments, eq(departments.id, notices.departmentId))
      .leftJoin(users, eq(users.id, notices.authorId))
      .where(
        poster && includeDrafts
          ? undefined
          : and(
              sql`${notices.publishedAt} is not null`,
              sql`(${notices.expiresAt} is null or ${notices.expiresAt} > now())`,
              poster
                ? undefined
                : sql`(cardinality(${notices.audienceRoles}) = 0
                       or ${actor.role}::role = any(${notices.audienceRoles}))`,
            ),
      )
      // `nulls last` explicitly: Postgres sorts NULLs first under DESC, which
      // would put every unpinned notice above the pinned ones.
      .orderBy(
        sql`${notices.pinned} desc nulls last`,
        sql`${notices.publishedAt} desc nulls last`,
        desc(notices.createdAt),
      )
      .limit(200)

    return rows.map((r) => ({
      ...r,
      pinned: r.pinned !== null,
      publishedAt: r.publishedAt?.toISOString() ?? null,
      expiresAt: r.expiresAt?.toISOString() ?? null,
    }))
  })
}

export async function readNotice(actor: Actor, noticeId: string): Promise<NoticeRow> {
  const all = await board(actor, canPost(actor.role))
  const one = all.find((n) => n.id === noticeId)
  if (!one) throw new NoticeError(404, 'no_such_notice', 'no such notice')
  return one
}

// --- the notification centre -----------------------------------------------

export async function inbox(actor: Actor, unreadOnly = false): Promise<Inbox> {
  const tenant = tenantOf(actor)

  return withTenant(tenant, async (tx): Promise<Inbox> => {
    const items = await tx
      .select()
      .from(notifications)
      .where(
        and(
          eq(notifications.userId, actor.id),
          unreadOnly ? isNull(notifications.readAt) : undefined,
        ),
      )
      .orderBy(desc(notifications.createdAt))
      .limit(100)

    const [counted] = await tx
      .select({ n: sql<number>`count(*)`.mapWith(Number) })
      .from(notifications)
      .where(and(eq(notifications.userId, actor.id), isNull(notifications.readAt)))

    return {
      unread: counted?.n ?? 0,
      emailConfigured: mailConfigured(),
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
        ),
      )
      .returning({ id: notifications.id })
    return { marked: rows.length }
  })
}

/**
 * Send an email copy of everything unsent for a notice.
 *
 * Separate from publishing on purpose: publishing must not fail because a mail
 * provider is down, and the inbox is the delivery that matters. Without a
 * provider configured this reports that it sent nothing and changes nothing.
 */
export async function emailNotice(actor: Actor, noticeId: string) {
  const tenant = requirePoster(actor)

  return withTenant(tenant, async (tx) => {
    const pending = await tx
      .select({
        id: notifications.id,
        title: notifications.title,
        body: notifications.body,
        email: users.email,
      })
      .from(notifications)
      .innerJoin(users, eq(users.id, notifications.userId))
      .where(and(eq(notifications.noticeId, noticeId), isNull(notifications.emailedAt)))
      .orderBy(asc(notifications.createdAt))
      .limit(100)

    const deliverable = pending.filter((p) => p.email)
    const result = await sendMail(
      deliverable.map((p) => ({ to: p.email!, subject: p.title, text: p.body })),
    )

    if (result.sent > 0) {
      const sentIds = deliverable.slice(0, result.sent).map((p) => p.id)
      await tx
        .update(notifications)
        .set({ emailedAt: new Date() })
        .where(sql`${notifications.id} = any(${sentIds}::uuid[])`)
    }

    return { queued: deliverable.length, ...result }
  })
}
