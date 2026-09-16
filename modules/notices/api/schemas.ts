import * as z from 'zod'
import { roleEnum } from '@campusos/db'
import { noticeKindEnum } from '../schema'

/**
 * Derived from the Postgres enum rather than imported from api-contracts:
 * api-contracts imports every module to compose the OpenAPI document, so a
 * module importing it back would be a cycle.
 */
const roleSchema = z.enum(roleEnum.enumValues)

const uuid = z.uuid()

export const createNoticeSchema = z
  .object({
    title: z.string().trim().min(1).max(200),
    body: z.string().trim().min(1).max(20_000),
    kind: z.enum(noticeKindEnum.enumValues).default('announcement'),
    /** Empty means everybody in the institution. */
    audienceRoles: z.array(roleSchema).default([]),
    departmentId: uuid.nullish(),
    expiresAt: z.iso.datetime().nullish(),
    pinned: z.coerce.boolean().default(false),
    /** Publish straight away, or leave it as a draft that notifies nobody. */
    publish: z.coerce.boolean().default(true),
  })
  .meta({ id: 'NoticeCreate' })

export const publishNoticeSchema = z
  .object({ noticeId: uuid })
  .meta({ id: 'NoticePublish' })

export const withdrawNoticeSchema = z
  .object({
    noticeId: uuid,
    reason: z.string().trim().min(5).max(500),
  })
  .meta({ id: 'NoticeWithdraw' })

export const markReadSchema = z
  .object({
    /** Omit to mark the whole inbox read. */
    notificationId: uuid.nullish(),
  })
  .meta({ id: 'NotificationMarkRead' })

// --- reads -----------------------------------------------------------------

export const noticeRowSchema = z
  .object({
    id: uuid,
    title: z.string(),
    body: z.string(),
    kind: z.enum(noticeKindEnum.enumValues),
    audienceRoles: z.array(z.string()),
    departmentCode: z.string().nullable(),
    pinned: z.boolean(),
    publishedAt: z.string().nullable(),
    expiresAt: z.string().nullable(),
    authorName: z.string().nullable(),
    /** How many people it was delivered to. Zero while it is a draft. */
    reach: z.number().int(),
    readCount: z.number().int(),
  })
  .meta({ id: 'Notice' })

export const notificationRowSchema = z
  .object({
    id: uuid,
    moduleId: z.string(),
    title: z.string(),
    body: z.string(),
    link: z.string().nullable(),
    noticeId: uuid.nullable(),
    readAt: z.string().nullable(),
    createdAt: z.string(),
  })
  .meta({ id: 'Notification' })

export const inboxSchema = z
  .object({
    unread: z.number().int(),
    items: z.array(notificationRowSchema),
    /** False when no mail provider is configured, so the UI can say so. */
    emailConfigured: z.boolean(),
  })
  .meta({ id: 'NotificationInbox' })

export type NoticeRow = z.infer<typeof noticeRowSchema>
export type NotificationRow = z.infer<typeof notificationRowSchema>
export type Inbox = z.infer<typeof inboxSchema>
