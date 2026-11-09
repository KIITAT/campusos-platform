import { eq, inArray, sql } from 'drizzle-orm'
import { withTenant } from '@campusos/db'
import * as z from 'zod'
import { parties, tdsChallans, tdsDeductor, tdsSections } from '../schema'
import { FinanceError, requireConfigure, type Actor } from './core'
import { deductionsWithin, quarterOf, TDS_FORMS, type Deduction } from './tds-returns'
import { FORM_144_REMITTANCE } from './tds-statement-codes'
import { localToday, settingsWithin } from './years'

/**
 * The quarterly TDS statement file for the FVU (P1-05d, ACC-31): Form 140 (was
 * 26Q) and Form 144 (was 27Q), tax year 2026-27 onwards, in Protean's published
 * format (version 1.2, 22 July 2026). A `^`-delimited ASCII file: one file
 * header, one batch header, a challan record per challan with its deductee
 * records after it. CampusOS does not run the FVU: it needs the challan file
 * (.csi) of the deductor's real TAN.
 */

const FH_FIELDS = 18
const BH_FIELDS = 72
const CD_FIELDS = 30
const DD_FIELDS = 45

const extraSchema = z.object({
  earlierFiled: z.enum(['Y', 'N']).default('N'),
  previousToken: z.string().trim().optional(),
})

const ddmmyyyy = (iso: string) => `${iso.slice(8, 10)}${iso.slice(5, 7)}${iso.slice(0, 4)}`
const rupees = (paise: number) => (paise / 100).toFixed(2)
const rate = (bp: number) => (bp / 100).toFixed(4)

/** A record of exactly `size` fields, the rest empty. */
function record(size: number, values: Record<number, string | number | null | undefined>) {
  const out = Array.from({ length: size }, () => '')
  for (const [at, v] of Object.entries(values)) {
    const i = Number(at)
    if (i >= size) throw new Error(`field ${i} outside a record of ${size}`)
    out[i] = v === null || v === undefined ? '' : String(v)
  }
  return out
}

/** Text as the file carries it: no delimiter or line break, cut to the field's size, ASCII only. */
function text(value: string | null | undefined, size: number, what: string) {
  if (!value) return ''
  const flat = value.replace(/[\^\r\n]+/g, ' ').trim().slice(0, size)
  if (/[^\x20-\x7e]/.test(flat)) throw new FinanceError(409, 'not_ascii', `${what} has characters the file cannot carry.`)
  return flat
}

/** Whole rupees, written with two zero decimals, as the challan fields require. */
function wholeRupees(paise: number) {
  if (paise % 100 !== 0) throw new FinanceError(409, 'fractional_challan', 'Challan amounts must be whole rupees.')
  return rupees(paise)
}

export async function tdsStatementFile(actor: Actor, input: unknown): Promise<{ bytes: string; fileName: string; type: string }> {
  const tenant = requireConfigure(actor)
  const q = quarterOf(input)
  const extra = extraSchema.parse(input ?? {})
  if (q.fy < TDS_FORMS.cutOverYear) {
    throw new FinanceError(
      400,
      'old_form_statement',
      'Statements before tax year 2026-27 use the old 26Q and 27Q layouts, which CampusOS does not write. Use the working statement CSV.',
    )
  }
  if (extra.earlierFiled === 'Y' && !/^[0-9]{15}$/.test(extra.previousToken ?? '')) {
    throw new FinanceError(400, 'bad_token', 'Give the 15-digit token of the previous regular statement.')
  }
  const formNo = q.form === '26Q' ? '140' : '144'

  return withTenant(tenant, async (tx) => {
    const [who] = await tx.select().from(tdsDeductor).where(eq(tdsDeductor.institutionId, tenant))
    const settings = await settingsWithin(tx, tenant)
    if (!who || !settings.tan || !settings.pan || !settings.legalName) {
      throw new FinanceError(409, 'deductor_incomplete', "Fill in the deductor's details for TDS statements first.")
    }
    const deductions = await deductionsWithin(tx, { from: q.from, to: q.to, form: q.form })
    if (deductions.some((d) => d.tdsPaise < 0)) {
      throw new FinanceError(409, 'negative_deduction', 'A debit note reduces tax already reported; file it as a correction statement.')
    }
    const undeposited = deductions.filter((d) => !d.challanId).length
    if (undeposited) {
      throw new FinanceError(409, 'undeposited', `${undeposited} deductions of this quarter are not in a challan. Record the challans first.`)
    }
    const challans = await tx
      .select()
      .from(tdsChallans)
      .where(
        sql`${tdsChallans.form} = ${q.form} and ${tdsChallans.month} between ${q.from}::date and ${q.to}::date and ${tdsChallans.voidedAt} is null`,
      )
      .orderBy(tdsChallans.depositedOn, tdsChallans.challanSerial)
    const sectionIds = [...new Set(deductions.map((d) => d.sectionId).filter((s): s is string => !!s))]
    const sections = new Map(
      (sectionIds.length ? await tx.select().from(tdsSections).where(inArray(tdsSections.id, sectionIds)) : []).map((s) => [s.id, s]),
    )
    const partyIds = [...new Set(deductions.map((d) => d.partyId))]
    const payees = new Map(
      (partyIds.length ? await tx.select().from(parties).where(inArray(parties.id, partyIds)) : []).map((p) => [p.id, p]),
    )

    const codeOf = (d: Deduction) => {
      const s = d.sectionId ? sections.get(d.sectionId) : undefined
      const code = q.form === '26Q' ? s?.returnCode : s?.nrReturnCode
      if (!s || !code) throw new FinanceError(409, 'no_return_code', `${d.section ?? 'A deduction without a section'} has no Form ${formNo} section code.`)
      return { section: s, code }
    }
    for (const d of deductions) {
      const { code, section } = codeOf(d)
      if (q.form === '27Q') {
        const p = payees.get(d.partyId)!
        if (!p.tdsStatus || !p.countryCode) throw new FinanceError(409, 'party_incomplete', `${p.name} needs a status and a country for Form 144.`)
        if (FORM_144_REMITTANCE[code] && !section.nrRemittance) {
          throw new FinanceError(409, 'no_remittance_nature', `${section.code} needs a nature of remittance for Form 144.`)
        }
      }
    }

    const today = await localToday(tx, tenant)
    const lines: string[][] = []
    const at = () => lines.length + 1
    lines.push(
      record(FH_FIELDS, { 0: at(), 1: 'FH', 2: 'NS1', 3: 'R', 4: ddmmyyyy(today), 5: 1, 6: 'D', 7: settings.tan, 8: 1, 9: 'CampusOS' }),
    )
    const batchTotal = challans.reduce((n, c) => n + c.tdsPaise + c.interestPaise + c.feePaise, 0)
    lines.push(
      record(BH_FIELDS, {
        0: at(),
        1: 'BH',
        2: 1,
        3: challans.length,
        4: formNo,
        8: extra.earlierFiled === 'Y' ? extra.previousToken : '',
        12: settings.tan,
        14: settings.pan,
        15: `${q.fy + 1}${String(q.fy + 2).slice(2)}`,
        16: `${q.fy}${String(q.fy + 1).slice(2)}`,
        17: `Q${q.quarter}`,
        18: text(settings.legalName, 75, "The deductor's name"),
        19: text(who.country, 25, "The deductor's country"),
        20: text(who.address1, 25, "The deductor's address"),
        21: text(who.address2, 25, "The deductor's address"),
        22: text(who.address3, 25, "The deductor's address"),
        23: text(who.address4, 25, "The deductor's address"),
        24: text(who.address5, 25, "The deductor's address"),
        25: who.stateCode,
        26: who.pincode,
        27: text(who.email, 75, "The deductor's e-mail"),
        28: who.phoneCountry,
        29: who.phone,
        31: who.deductorType,
        32: text(who.responsibleName, 75, "The responsible person's name"),
        33: text(who.responsibleDesignation, 20, "The responsible person's designation"),
        34: text(who.responsibleAddress1, 25, "The responsible person's address"),
        35: text(who.responsibleAddress2, 25, "The responsible person's address"),
        36: text(who.responsibleAddress3, 25, "The responsible person's address"),
        37: text(who.responsibleAddress4, 25, "The responsible person's address"),
        38: text(who.responsibleAddress5, 25, "The responsible person's address"),
        39: who.responsibleStateCode,
        40: who.responsiblePincode,
        41: text(who.responsibleEmail, 75, "The responsible person's e-mail"),
        42: text(who.responsibleCountry, 25, "The responsible person's country"),
        43: who.responsiblePhoneCountry,
        44: who.responsiblePhone,
        46: wholeRupees(batchTotal),
        51: extra.earlierFiled,
        58: who.responsiblePan,
        68: settings.gstin ?? '',
      }),
    )

    let deducteeNo = 0
    challans.forEach((c, i) => {
      const mine = deductions
        .filter((d) => d.challanId === c.id)
        .sort((a, b) => a.postingDate.localeCompare(b.postingDate) || (a.number ?? '').localeCompare(b.number ?? ''))
      const deducted = mine.reduce((n, d) => n + d.tdsPaise, 0)
      lines.push(
        record(CD_FIELDS, {
          0: at(),
          1: 'CD',
          2: 1,
          3: i + 1,
          4: mine.length,
          5: 'N',
          7: wholeRupees(c.tdsPaise),
          8: wholeRupees(c.interestPaise),
          9: wholeRupees(c.feePaise),
          10: '0.00',
          11: wholeRupees(c.tdsPaise + c.interestPaise + c.feePaise),
          12: 'C',
          14: c.bsrCode,
          16: c.challanSerial,
          18: ddmmyyyy(c.depositedOn),
          20: rupees(deducted),
          21: rupees(deducted),
          22: '200',
          23: wholeRupees(c.interestPaise),
          24: wholeRupees(c.feePaise),
        }),
      )
      for (const d of mine) {
        const { section, code } = codeOf(d)
        const p = payees.get(d.partyId)!
        const common = {
          0: at(),
          1: 'DD',
          2: 1,
          3: ++deducteeNo,
          4: i + 1,
          5: 'O',
          7: d.pan ?? 'PANNOTAVBL',
          8: text(d.party, 75, `The name of ${d.party}`),
          14: code,
          17: 'Y',
          18: ddmmyyyy(d.postingDate),
          19: rupees(d.paidPaise),
          23: rupees(d.tdsPaise),
          24: rupees(d.tdsPaise),
          26: ddmmyyyy(d.postingDate),
          27: rate(d.pan ? section.rateBp : section.rateNoPanBp),
        }
        lines.push(
          record(
            DD_FIELDS,
            q.form === '26Q'
              ? common
              : {
                  ...common,
                  11: p.tdsStatus,
                  13: 'N',
                  15: FORM_144_REMITTANCE[code] ? section.nrRemittance : '',
                  16: p.countryCode,
                  20: 'N',
                  29: 'A',
                  36: text(p.foreignAddress, 150, `The address abroad of ${p.name}`),
                  37: text(p.email, 75, `The e-mail of ${p.name}`),
                  40: text(p.foreignTaxId, 25, `The tax id abroad of ${p.name}`),
                },
          ),
        )
      }
    })

    return {
      bytes: lines.map((l) => l.join('^')).join('\r\n') + '\r\n',
      fileName: `${settings.tan}_${formNo}_Q${q.quarter}_${q.fy}${String(q.fy + 1).slice(2)}.txt`,
      type: 'text/plain; charset=us-ascii',
    }
  })
}
