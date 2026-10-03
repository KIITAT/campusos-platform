import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { eq, like } from 'drizzle-orm'
import { authDb, institutions, users, withTenant } from '@campusos/db'
import * as academic from '@campusos/module-academic/api'
import { trialBalance, type Actor as Books } from '@campusos/module-finance/api'
import {
  FeeError,
  addBankAccount,
  claimQueue,
  claimTransfer,
  createFeeItem,
  demandLetter,
  demandLetterPdf,
  issueDemandLetter,
  issueInvoices,
  listDemandLetters,
  myClaims,
  rejectClaim,
  retireBankAccount,
  rupeesInWords,
  studentLedger,
  verifyClaim,
  verifyDemandLetter,
  type Actor,
} from './api'
import { demandLetters, transferClaims } from './schema'

/**
 * KIIT's "RTGS Submit Application" and "Download Demand Letter": a transfer
 * the student reports and the office verifies into a receipt, and a numbered
 * letter of what is due.
 */

let n = 0
const SLUG = 'fees-transfer-'
const today = () => new Date().toISOString().slice(0, 10)

async function campus() {
  const tag = `${SLUG}${++n}`
  const [i] = await authDb
    .insert(institutions)
    .values({ slug: tag, name: 'Transfer University', allowedEmailDomains: [`${tag}.test`] })
    .returning({ id: institutions.id })
  const id = i!.id
  const people = await authDb
    .insert(users)
    .values([
      { email: `adm@${tag}.test`, institutionId: id, role: 'institution_admin', name: 'Adm' },
      { email: `clerk@${tag}.test`, institutionId: id, role: 'accounts_staff', name: 'Clerk' },
      { email: `s1@${tag}.test`, institutionId: id, role: 'student', name: 'Asha Roy' },
      { email: `s2@${tag}.test`, institutionId: id, role: 'student', name: 'Bilal Khan' },
      { email: `f@${tag}.test`, institutionId: id, role: 'faculty', name: 'Fac' },
    ])
    .returning({ id: users.id })
  const admin: Actor = { id: people[0]!.id, email: `adm@${tag}.test`, role: 'institution_admin', institutionId: id }
  const clerk: Actor = { id: people[1]!.id, email: `clerk@${tag}.test`, role: 'accounts_staff', institutionId: id }
  const asha: Actor = { id: people[2]!.id, role: 'student', institutionId: id }
  const bilal: Actor = { id: people[3]!.id, role: 'student', institutionId: id }
  const faculty: Actor = { id: people[4]!.id, role: 'faculty', institutionId: id }
  const a = admin as unknown as academic.Actor
  const dept = await academic.createDepartment(a, { code: 'cse', name: 'CSE' })
  const program = await academic.createProgram(a, { departmentId: dept.id, code: 'btech', name: 'BTech', level: 'undergraduate', durationTerms: 8 })
  const term = await academic.createTerm(a, { code: 't1', name: 'Autumn 2026', startsOn: '2026-07-01', endsOn: '2026-11-30' })
  const other = await academic.createTerm(a, { code: 't0', name: 'Spring 2026', startsOn: '2026-01-05', endsOn: '2026-05-30' })
  const section = await academic.createSection(a, { programId: program.id, label: 'a', admissionYear: 2026 })
  await academic.addSectionMember(a, { sectionId: section.id, userId: asha.id })
  await academic.addSectionMember(a, { sectionId: section.id, userId: bilal.id })
  await academic.setStudentProfile(a, { studentId: asha.id, rollNo: '2505101', registrationNo: '25168010101' })
  await createFeeItem(admin, { programId: program.id, termId: term.id, label: 'Tuition', amount: '2,50,000' })
  await createFeeItem(admin, { programId: program.id, termId: term.id, label: 'Hostel', amount: '47,345' })
  const account = await addBankAccount(admin, {
    label: 'School of Computer Engineering',
    accountName: 'Transfer University Fees',
    bankName: 'Indian Bank',
    branch: 'Patia',
    accountNumber: '50245763642',
    ifsc: 'idib000k717',
  })
  return { id, admin, clerk, asha, bilal, faculty, termId: term.id, otherTermId: other.id, accountId: account.id }
}

const code = (e: unknown) => (e as FeeError).code
const claim = (c: Awaited<ReturnType<typeof campus>>, over: Record<string, unknown> = {}) =>
  claimTransfer(c.asha, {
    termId: c.termId,
    accountId: c.accountId,
    mode: 'neft',
    remitterBank: 'State Bank of India',
    remitterBranch: 'Guwahati',
    remitterIfsc: 'sbin0000078',
    accountHolder: 'Asha Roy',
    contactPhone: '+91 98765 43210',
    transferredOn: today(),
    amount: '2,97,345',
    utr: 'SBINN52026010224179441',
    ...over,
  })

after(async () => {
  await authDb.delete(institutions).where(like(institutions.slug, `${SLUG}%`))
})

test('an amount in words is written the Indian way', () => {
  assert.equal(rupeesInWords(29_734_500), 'Rupees Two Lakh Ninety Seven Thousand Three Hundred Forty Five Only')
  assert.equal(rupeesInWords(2_131_050), 'Rupees Twenty One Thousand Three Hundred Ten and Fifty Paise Only')
  assert.equal(rupeesInWords(1_000_000_000), 'Rupees One Crore Only')
  assert.equal(rupeesInWords(12_345_678_900), 'Rupees Twelve Crore Thirty Four Lakh Fifty Six Thousand Seven Hundred Eighty Nine Only')
  assert.equal(rupeesInWords(0), 'Rupees Zero Only')
})

test('a reported transfer is verified into a receipted, reconciled payment, once', async () => {
  const c = await campus()
  await issueInvoices(c.admin, { termId: c.termId })
  const before = (await trialBalance(c.admin as unknown as Books)).rows.find((r) => r.code === '1100')?.balancePaise

  const cl = await claim(c)
  assert.equal(cl.status, 'pending')
  assert.equal(cl.utr, 'SBINN52026010224179441')
  assert.match(cl.notice, /Two Lakh Ninety Seven Thousand Three Hundred Forty Five/)
  assert.equal((await studentLedger(c.asha, c.asha.id, c.termId)).paidPaise, 0, 'a claim is not money until it is verified')

  // The same UTR cannot be claimed twice, whatever its case.
  await assert.rejects(claim(c, { utr: 'sbinn52026010224179441' }), (e) => code(e) === 'fee_transfer_claims_utr')
  await assert.rejects(claimTransfer(c.faculty, { termId: c.termId }), (e) => code(e) === 'forbidden')
  await assert.rejects(
    claim(c, { utr: 'FUTURE123456', transferredOn: '2099-01-01' }),
    (e) => code(e) === 'fee_claim_future',
  )

  const v = await verifyClaim(c.clerk, { claimId: cl.id, note: 'statement of today, line 12' })
  assert.match(v.receiptNo, /^R/)
  const l = await studentLedger(c.asha, c.asha.id, c.termId)
  assert.equal(l.paidPaise, 29_734_500)
  assert.equal(l.unreconciledPaise, 0, 'found on the statement is reconciled')
  assert.equal(l.payments[0]!.method, 'bank_transfer')
  assert.equal(l.payments[0]!.reference, 'SBINN52026010224179441')
  const after = (await trialBalance(c.admin as unknown as Books)).rows.find((r) => r.code === '1100')?.balancePaise
  assert.equal((before ?? 0) - (after ?? 0), 29_734_500, 'the books have it')

  const mine = await myClaims(c.asha)
  assert.equal(mine[0]!.status, 'verified')
  assert.equal(mine[0]!.receiptNo, v.receiptNo)
  await assert.rejects(verifyClaim(c.clerk, { claimId: cl.id }), (e) => code(e) === 'fee_claim_decided')
  await assert.rejects(
    withTenant(c.id, (tx) => tx.update(transferClaims).set({ amountPaise: 1 }).where(eq(transferClaims.id, cl.id))),
    (e) => String((e as { cause?: { constraint?: string } }).cause?.constraint) === 'fee_claim_decided',
  )
})

test('a transfer not on the statement is rejected with a reason, and can be claimed again correctly', async () => {
  const c = await campus()
  const wrong = await claim(c, { utr: 'TYPO000000001', amount: '21,310' })
  await assert.rejects(rejectClaim(c.clerk, { claimId: wrong.id, reason: 'no' }), /too_small|>=5/)
  await assert.rejects(rejectClaim(c.asha, { claimId: wrong.id, reason: 'I changed my mind' }), (e) => code(e) === 'forbidden')
  await rejectClaim(c.clerk, { claimId: wrong.id, reason: 'no transfer with this UTR on the statement of 2 to 4 Oct' })
  assert.equal((await myClaims(c.asha))[0]!.decisionNote, 'no transfer with this UTR on the statement of 2 to 4 Oct')
  // A rejected UTR is free again.
  const again = await claim(c, { utr: 'TYPO000000001', amount: '21,310' })
  assert.equal(again.status, 'pending')
  const queue = await claimQueue(c.clerk)
  assert.deepEqual(queue.map((q) => q.status), ['pending', 'rejected'], 'pending first')

  await retireBankAccount(c.admin, { accountId: c.accountId })
  await assert.rejects(claim(c, { utr: 'LATE00000001' }), (e) => code(e) === 'fee_claim_account')
})

test('a demand letter states the term’s fees and what is due, numbered and kept', async () => {
  const c = await campus()
  const first = await issueDemandLetter(c.asha, {
    termId: c.termId,
    addressee: 'The Branch Manager, State Bank of India, Patia, Bhubaneswar',
    purpose: 'education_loan',
  })
  assert.match(first.number, new RegExp(`^DL/${new Date().getFullYear()}/00001$`))
  assert.equal(first.content.payablePaise, 29_734_500)
  assert.deepEqual(first.content.lines.map((x) => x.label), ['Hostel', 'Tuition'])
  assert.equal(first.content.student.rollNo, '2505101')
  assert.equal(first.content.account!.ifsc, 'IDIB000K717')

  const v = await demandLetter(c.asha, first.id)
  assert.match(v.payableWords, /^Rupees Two Lakh Ninety Seven Thousand/)
  assert.equal(Buffer.from(await demandLetterPdf(v)).subarray(0, 5).toString(), '%PDF-')

  const second = await issueDemandLetter(c.clerk, { studentId: c.bilal.id, termId: c.termId, addressee: 'Odisha Scholarship Board', purpose: 'scholarship' })
  assert.match(second.number, /00002$/)
  await assert.rejects(demandLetter(c.asha, second.id), (e) => code(e) === 'forbidden')
  assert.equal((await listDemandLetters(c.asha)).length, 1)
  assert.equal((await verifyDemandLetter(c.clerk, first.number.toLowerCase())).found, true)
  assert.equal((await verifyDemandLetter(c.clerk, 'DL/1999/00042')).found, false)
  await assert.rejects(issueDemandLetter(c.asha, { termId: c.otherTermId, addressee: 'A bank', purpose: 'other' }), (e) => code(e) === 'nothing_charged')
  await assert.rejects(
    withTenant(c.id, (tx) => tx.update(demandLetters).set({ addressee: 'Somebody else' }).where(eq(demandLetters.id, first.id))),
    (e) => String((e as { cause?: { constraint?: string } }).cause?.constraint) === 'fee_demand_letter_kept',
  )
})
