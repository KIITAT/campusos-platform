import * as z from 'zod'
import { modeEnum, outcomeEnum, topicEnum, urgencyEnum } from '../schema'

const uuid = z.uuid()
const blank = (v: unknown) => (typeof v === 'string' && v.trim() === '' ? undefined : v)
const optionalText = (max: number) => z.preprocess(blank, z.string().trim().max(max).optional())
/** A list from a form's ticked boxes, or one value, or nothing. */
const ids = z.preprocess((v) => (v === undefined || v === '' ? [] : Array.isArray(v) ? v : [v]), z.array(uuid).max(20))

export const takeCheckSchema = z
  .object({
    code: z.string().trim().min(2).max(20),
    /** The answer chosen for each question, by its place; `a0`, `a1`... from a form. */
    answers: z.array(z.union([z.coerce.number().int(), z.null()])).max(40),
  })
  .meta({ id: 'CareTakeCheck' })

export const deleteResultSchema = z.object({ resultId: uuid }).meta({ id: 'CareDeleteResult' })

export const askSchema = z
  .object({
    topic: z.enum(topicEnum.enumValues).default('not_said'),
    urgency: z.enum(urgencyEnum.enumValues).default('routine'),
    mode: z.enum(modeEnum.enumValues).default('in_person'),
    preferredTimes: optionalText(200),
    message: optionalText(2000),
    /** The student's own results to show the counsellors. */
    resultIds: ids,
  })
  .meta({ id: 'CareAsk' })

export const withdrawSchema = z
  .object({ requestId: uuid, reason: optionalText(300) })
  .meta({ id: 'CareWithdraw' })

export const acceptSchema = z.object({ requestId: uuid }).meta({ id: 'CareAccept' })

export const handoverSchema = z
  .object({ requestId: uuid, counsellorId: z.string().min(1), reason: z.string().trim().min(5).max(300) })
  .meta({ id: 'CareHandover' })

export const closeSchema = z
  .object({ requestId: uuid, outcome: z.enum(outcomeEnum.enumValues), note: optionalText(5000) })
  .meta({ id: 'CareClose' })

export const bookSchema = z
  .object({
    requestId: uuid,
    /** A wall-clock time in the institution's zone, as a datetime field sends it, or an instant with an offset. */
    startsAt: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/, 'a date and time'),
    minutes: z.coerce.number().int().min(15).max(240).default(45),
    mode: z.enum(modeEnum.enumValues),
    place: z.string().trim().min(2).max(300),
    noteToStudent: optionalText(500),
  })
  .meta({ id: 'CareBook' })

export const recordSchema = z
  .object({ appointmentId: uuid, status: z.enum(['held', 'missed']) })
  .meta({ id: 'CareRecordAppointment' })

export const cancelAppointmentSchema = z
  .object({ appointmentId: uuid, reason: z.string().trim().min(3).max(300) })
  .meta({ id: 'CareCancelAppointment' })

export const noteSchema = z
  .object({ requestId: uuid, body: z.string().trim().min(2).max(5000) })
  .meta({ id: 'CareNote' })

export const settingsSchema = z
  .object({
    crisisLine: z.preprocess((v) => v ?? '', z.string().trim().max(300)),
    contact: z.preprocess((v) => v ?? '', z.string().trim().max(500)),
    timeZone: z.string().trim().min(1).max(64).default('Asia/Kolkata'),
  })
  .meta({ id: 'CareSettings' })

export const counsellorSchema = z
  .object({ userId: z.string().min(1), title: z.string().trim().min(2).max(80) })
  .meta({ id: 'CareCounsellor' })

export const counsellorActiveSchema = z
  .object({ userId: z.string().min(1), active: z.preprocess((v) => v === true || v === 'true', z.boolean()) })
  .meta({ id: 'CareCounsellorActive' })

export const retireInstrumentSchema = z.object({ instrumentId: uuid }).meta({ id: 'CareRetireInstrument' })

export const periodSchema = z.enum(['30d', '12m', 'all']).default('12m')
