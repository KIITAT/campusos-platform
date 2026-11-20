import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { and, eq, isNull, like } from 'drizzle-orm'
import { authDb, institutions, users, withTenant } from '@campusos/db'
import * as academic from '@campusos/module-academic/api'
import { sql } from 'drizzle-orm'
import { FeeError, addBankAccount, createFeeItem, demandLetterPdf, issueDemandLetter, demandLetter, issueInvoices, recordPayment, type Actor } from './api'
import { feeInvoices } from './schema'

/**
 * Paying by UPI (P1-03c): the institution's UPI ID, the link a QR carries,
 * and the UPI ID on the demand letter.
 */

let n = 0
const SLUG = 'fees-upi-'
const importing = async (name: string) => ((await import('./api')) as Record<string, any>)[name]
const code = (e: unknown) => (e as FeeError).code

async function campus() {
  const tag = `${SLUG}${++n}`
  const [i] = await authDb
    .insert(institutions)
    .values({ slug: tag, name: 'UPI University', allowedEmailDomains: [`${tag}.test`] })
    .returning({ id: institutions.id })
  const id = i!.id
  const people = await authDb
    .insert(users)
    .values([
      { email: `adm@${tag}.test`, institutionId: id, role: 'institution_admin', name: 'Adm' },
      { email: `clerk@${tag}.test`, institutionId: id, role: 'accounts_staff', name: 'Clerk' },
      { email: `s1@${tag}.test`, institutionId: id, role: 'student', name: 'Asha Roy' },
      { email: `s2@${tag}.test`, institutionId: id, role: 'student', name: 'Bilal Khan' },
    ])
    .returning({ id: users.id })
  const admin: Actor = { id: people[0]!.id, email: `adm@${tag}.test`, role: 'institution_admin', institutionId: id }
  const clerk: Actor = { id: people[1]!.id, email: `clerk@${tag}.test`, role: 'accounts_staff', institutionId: id }
  const asha: Actor = { id: people[2]!.id, role: 'student', institutionId: id }
  const bilal: Actor = { id: people[3]!.id, role: 'student', institutionId: id }
  const a = admin as unknown as academic.Actor
  const dept = await academic.createDepartment(a, { code: 'cse', name: 'CSE' })
  const program = await academic.createProgram(a, { departmentId: dept.id, code: 'btech', name: 'BTech', level: 'undergraduate', durationTerms: 8 })
  const term = await academic.createTerm(a, { code: 't1', name: 'Autumn 2026', startsOn: '2026-07-01', endsOn: '2026-11-30' })
  const section = await academic.createSection(a, { programId: program.id, label: 'a', admissionYear: 2026 })
  await academic.addSectionMember(a, { sectionId: section.id, userId: asha.id })
  await academic.addSectionMember(a, { sectionId: section.id, userId: bilal.id })
  for (const s of [asha, bilal]) await academic.declareProgram(a, { studentId: s.id, programId: program.id, declaredOn: '2025-07-01' })
  await createFeeItem(admin, { programId: program.id, termId: term.id, label: 'Tuition', amount: '2,50,000' })
  await createFeeItem(admin, { programId: program.id, termId: term.id, label: 'Hostel', amount: '47,345' })
  const account = await addBankAccount(admin, {
    label: 'School of Computer Engineering',
    accountName: 'UPI University Fees',
    bankName: 'Indian Bank',
    branch: 'Patia',
    accountNumber: '50245763642',
    ifsc: 'idib000k717',
  })
  return { id, admin, clerk, asha, bilal, termId: term.id, accountId: account.id }
}

after(async () => {
  await authDb.delete(institutions).where(like(institutions.slug, `${SLUG}%`))
})

test('a UPI link carries the payee, and the amount and reference only when given', async () => {
  const upiLink = await importing('upiLink')
  const payReference = await importing('payReference')
  const base = { vpa: 'fees.kiit@sbi', payee: 'KIIT Fees & Hostel' }
  assert.equal(
    upiLink({ ...base, amountPaise: 4_500_050, reference: 'CF0123456789' }),
    'upi://pay?pa=fees.kiit@sbi&pn=KIIT%20Fees%20%26%20Hostel&am=45000.50&tr=CF0123456789&tn=Fees%20CF0123456789&cu=INR',
  )
  assert.equal(
    upiLink({ ...base, amountPaise: null, reference: 'CF0123456789' }),
    'upi://pay?pa=fees.kiit@sbi&pn=KIIT%20Fees%20%26%20Hostel&tn=Fees%20CF0123456789&cu=INR',
  )
  assert.equal(upiLink({ ...base }), 'upi://pay?pa=fees.kiit@sbi&pn=KIIT%20Fees%20%26%20Hostel&cu=INR')
  assert.equal(payReference('0a1b2c3d-4e5f-6789-abcd-ef0123456789'), 'CF0A1B2C3D4E')
})

test('only an administrator sets an account’s UPI ID; it is checked and audited', async () => {
  const setAccountUpi = await importing('setAccountUpi')
  const c = await campus()
  await assert.rejects(setAccountUpi(c.clerk, { accountId: c.accountId, vpa: 'fees@sbi' }), (e) => code(e) === 'forbidden')
  await assert.rejects(setAccountUpi(c.admin, { accountId: c.accountId, vpa: 'not a vpa' }), (e) => code(e) === 'fee_bank_accounts_vpa')
  await assert.rejects(setAccountUpi(c.admin, { accountId: c.accountId, vpa: '', merchant: 'on' }), (e) => code(e) === 'fee_bank_accounts_merchant')
  await setAccountUpi(c.admin, { accountId: c.accountId, vpa: ' Fees.KIIT@SBI ', merchant: 'on' })
  const rows = await withTenant(c.id, (tx) =>
    tx.execute(sql`select upi_vpa as vpa, upi_merchant as merchant from fee_bank_accounts where id = ${c.accountId}`),
  )
  assert.deepEqual(rows.rows[0], { vpa: 'fees.kiit@sbi', merchant: true })
  const logged = await withTenant(c.id, (tx) =>
    tx.execute(sql`select reason from audit_log where action = 'fee.bank_account_upi' and entity_id = ${c.accountId}`),
  )
  assert.equal((logged.rows[0] as { reason: string }).reason, 'none -> fees.kiit@sbi (merchant)')
})

test('a merchant VPA gets the exact amount due and the reference; a personal one gets neither amount nor tr', async () => {
  const setAccountUpi = await importing('setAccountUpi')
  const upiFor = await importing('upiFor')
  const payReference = await importing('payReference')
  const c = await campus()
  assert.equal(await upiFor(c.asha, c.asha.id, c.termId), null, 'no UPI ID, no QR')
  await setAccountUpi(c.admin, { accountId: c.accountId, vpa: 'fees.kiit@sbi', merchant: 'on' })
  await issueInvoices(c.admin, { termId: c.termId })
  const [inv] = await withTenant(c.id, (tx) =>
    tx
      .select({ id: feeInvoices.id })
      .from(feeInvoices)
      .where(and(eq(feeInvoices.studentId, c.asha.id), eq(feeInvoices.termId, c.termId), isNull(feeInvoices.voidedAt))),
  )
  const ref = payReference(inv!.id)
  const dyn = await upiFor(c.asha, c.asha.id, c.termId)
  assert.equal(dyn.dynamic, true)
  assert.equal(dyn.amountPaise, 29_734_500)
  assert.equal(dyn.reference, ref)
  assert.ok(dyn.link.includes('am=297345.00') && dyn.link.includes(`tr=${ref}`))

  await recordPayment(c.clerk, { studentId: c.asha.id, termId: c.termId, amount: '2,97,345', method: 'cash', allowAdvance: true })
  const paid = await upiFor(c.asha, c.asha.id, c.termId)
  assert.equal(paid.dynamic, false)
  assert.equal(paid.amountPaise, null)

  await setAccountUpi(c.admin, { accountId: c.accountId, vpa: 'fees.kiit@sbi' })
  const stat = await upiFor(c.asha, c.asha.id, c.termId)
  assert.ok(!stat.link.includes('am=') && !stat.link.includes('tr='))
  assert.ok(stat.link.includes(`tn=Fees%20${ref}`))
  await assert.rejects(upiFor(c.bilal, c.asha.id, c.termId), (e) => code(e) === 'not_your_student')
})

test('a demand letter names the UPI ID', async () => {
  const setAccountUpi = await importing('setAccountUpi')
  const c = await campus()
  await setAccountUpi(c.admin, { accountId: c.accountId, vpa: 'fees.kiit@sbi' })
  const letter = await issueDemandLetter(c.asha, { termId: c.termId, addressee: 'The Branch Manager', purpose: 'education_loan' })
  assert.equal(letter.content.account!.upiVpa, 'fees.kiit@sbi')
  const pdf = await demandLetterPdf(await demandLetter(c.asha, letter.id))
  assert.equal(Buffer.from(pdf).subarray(0, 5).toString(), '%PDF-')
})
