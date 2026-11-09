import { eq } from 'drizzle-orm'
import { audit, withTenant } from '@campusos/db'
import * as z from 'zod'
import { tdsDeductor as deductorTable, tdsSections } from '../schema'
import { FinanceError, requireConfigure, requireRead, type Actor } from './core'
import { FORM_140_SECTION_CODES, FORM_144_REMITTANCE, FORM_144_SECTION_CODES, TDS_DEDUCTOR_TYPES, TDS_STATE_CODES } from './tds-statement-codes'

/**
 * What a TDS statement file needs that the books do not hold (P1-05d, ACC-31):
 * the deductor's address and contacts, the person responsible, and each
 * section's code in the return.
 */

const line = (max: number) => z.string().trim().min(1).max(max)
const optionalLine = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .optional()
    .transform((v) => (v ? v : null))
const state = z.string().trim().refine((v) => TDS_STATE_CODES.includes(v))
const pin = z.string().trim().regex(/^[1-9][0-9]{5}$/)
const email = z.string().trim().max(75).regex(/^[^@\s]+@[^@\s]+\.[^@\s]+$/)
const phone = z.string().trim().regex(/^[0-9]{6,10}$/)
const countryCode = z.string().trim().regex(/^[0-9]{1,5}$/).default('91')
const country = z.string().trim().min(1).max(25).default('INDIA')

export const tdsDeductorSchema = z
  .object({
    deductorType: z.enum(TDS_DEDUCTOR_TYPES),
    address1: line(25),
    address2: optionalLine(25),
    address3: optionalLine(25),
    address4: optionalLine(25),
    address5: optionalLine(25),
    country,
    stateCode: state,
    pincode: pin,
    email,
    phoneCountry: countryCode,
    phone,
    responsibleName: line(75),
    responsibleDesignation: line(20),
    responsiblePan: z.string().trim().toUpperCase().regex(/^[A-Z]{5}[0-9]{4}[A-Z]$/),
    responsibleAddress1: line(25),
    responsibleAddress2: optionalLine(25),
    responsibleAddress3: optionalLine(25),
    responsibleAddress4: optionalLine(25),
    responsibleAddress5: optionalLine(25),
    responsibleCountry: country,
    responsibleStateCode: state,
    responsiblePincode: pin,
    responsibleEmail: email,
    responsiblePhoneCountry: countryCode,
    responsiblePhone: phone,
  })
  .meta({ id: 'FinanceTdsDeductor' })

/** Save the deductor's details for TDS statements (administrators). */
export async function saveTdsDeductor(actor: Actor, input: unknown) {
  const tenant = requireConfigure(actor)
  const parsed = tdsDeductorSchema.safeParse(input)
  if (!parsed.success) {
    const field = String(parsed.error.issues[0]?.path[0] ?? 'details')
    throw new FinanceError(400, 'bad_deductor', `The deductor's ${field} is not valid.`)
  }
  const data = parsed.data
  return withTenant(tenant, async (tx) => {
    await tx
      .insert(deductorTable)
      .values({ institutionId: tenant, ...data })
      .onConflictDoUpdate({ target: deductorTable.institutionId, set: { ...data, updatedAt: new Date() } })
    await audit(tx, {
      institutionId: tenant,
      actorId: actor.id,
      actorEmail: actor.email ?? null,
      moduleId: 'finance',
      action: 'tds_deductor.updated',
      entity: 'finance_tds_deductor',
      entityId: tenant,
      reason: "Deductor's details for TDS statements saved",
    })
    return { notice: "The deductor's details are saved." }
  })
}

/** The deductor's details, or null before they are filled in. */
export async function tdsDeductor(actor: Actor) {
  const tenant = requireRead(actor)
  return withTenant(tenant, async (tx) => {
    const [row] = await tx.select().from(deductorTable).where(eq(deductorTable.institutionId, tenant))
    return row ?? null
  })
}

const code = z.string().trim().optional()

export const returnCodesSchema = z
  .object({ sectionId: z.uuid(), returnCode: code, nrReturnCode: code, nrRemittance: code })
  .meta({ id: 'FinanceTdsReturnCodes' })

/**
 * Set a section's code in Form 140, in Form 144, and Form 144's nature of
 * remittance (administrators). An empty value clears it; an absent one is kept.
 */
export async function setReturnCodes(actor: Actor, input: unknown) {
  const tenant = requireConfigure(actor)
  const data = returnCodesSchema.parse(input)
  const check = (value: string | undefined, list: readonly string[], form: string) => {
    if (value && !list.includes(value)) throw new FinanceError(400, 'bad_return_code', `${value} is not a section code of Form ${form}`)
  }
  check(data.returnCode, FORM_140_SECTION_CODES, '140')
  check(data.nrReturnCode, FORM_144_SECTION_CODES, '144')
  return withTenant(tenant, async (tx) => {
    const [section] = await tx.select().from(tdsSections).where(eq(tdsSections.id, data.sectionId))
    if (!section) throw new FinanceError(404, 'not_found', 'no such TDS section')
    const nrCode = data.nrReturnCode === undefined ? section.nrReturnCode : data.nrReturnCode || null
    const remittance = data.nrRemittance === undefined ? section.nrRemittance : data.nrRemittance || null
    if (remittance && !(nrCode && FORM_144_REMITTANCE[nrCode]?.includes(remittance))) {
      throw new FinanceError(400, 'bad_remittance', `${remittance} is not a nature of remittance for Form 144 section ${nrCode ?? '(none)'}`)
    }
    const set = {
      ...(data.returnCode !== undefined && { returnCode: data.returnCode || null }),
      ...(data.nrReturnCode !== undefined && { nrReturnCode: nrCode }),
      ...(data.nrRemittance !== undefined && { nrRemittance: remittance }),
    }
    if (Object.keys(set).length) await tx.update(tdsSections).set(set).where(eq(tdsSections.id, section.id))
    await audit(tx, {
      institutionId: tenant,
      actorId: actor.id,
      actorEmail: actor.email ?? null,
      moduleId: 'finance',
      action: 'tds_section.return_code_set',
      entity: 'finance_tds_sections',
      entityId: section.id,
      reason: `Return codes of ${section.code} set`,
    })
    return { notice: `${section.code}: return codes saved.` }
  })
}
