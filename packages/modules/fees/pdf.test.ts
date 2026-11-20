import { test } from 'node:test'
import assert from 'node:assert/strict'
import { printedText } from '@campusos/module-framework/pdf'
import { plainPaise } from '@campusos/money'
import { receiptPdf, type ReceiptData } from './api/receipt-pdf'
import { demandLetterPdf } from './api/demand-letter-pdf'
import type { DemandLetterView } from './api/transfers'

const receipt = (over: Partial<ReceiptData>): ReceiptData => ({
  receiptNo: 'R-1',
  institutionName: 'Plain College',
  studentName: 'Plain Student',
  studentEmail: 'plain@example.test',
  termCode: 'T1',
  termName: 'Autumn',
  amountPaise: 120000,
  method: 'bank_transfer',
  reference: 'UTR1',
  receivedAt: new Date('2026-10-01T00:00:00Z'),
  reconciledAt: null,
  ...over,
})

test('a receipt prints an Odia and a Devanagari name (UX-01)', async () => {
  const bytes = await receiptPdf(receipt({ studentName: 'ଅଭିଷେକ ପଟ୍ଟନାୟକ', institutionName: 'कलिंग विश्वविद्यालय' }))
  const printed = await printedText(bytes)
  assert.ok(printed.includes('ଅଭିଷେକ ପଟ୍ଟନାୟକ'), printed.join('|'))
  assert.ok(printed.includes('कलिंग विश्वविद्यालय'), printed.join('|'))
})

test('a demand letter refuses a name it cannot print (UX-01)', async () => {
  const view: DemandLetterView = {
    number: 'DL-1',
    institution: 'Plain College',
    addressee: 'The Manager, Plain Bank',
    purpose: 'education loan',
    issuedAt: new Date('2026-10-01T00:00:00Z'),
    content: {
      student: { name: 'Asha 😀', rollNo: 'R1', registrationNo: 'G1', programme: 'B.Tech' },
      term: { code: 'T1', name: 'Autumn', startsOn: '2026-07-01', endsOn: '2026-12-15' },
      lines: [{ label: 'Tuition', amountPaise: 100000 }],
      deductions: [],
      payablePaise: 100000,
      paidPaise: 0,
      balancePaise: 100000,
      account: null,
    } as unknown as DemandLetterView['content'],
    signatory: { name: 'Accounts Officer', title: 'Accounts Office' },
    opening: 'Please find the fee particulars below.',
    closing: 'Yours faithfully.',
    payableWords: 'One thousand rupees only',
  }
  await assert.rejects(() => demandLetterPdf(view), (e: unknown) => (e as { code?: string }).code === 'missing_glyph')
})

test('a receipt says the amount in words, the PAN, the address and the fee heads (ACC-30)', async () => {
  const bytes = await receiptPdf(
    receipt({
      amountPaise: 120000,
      address: 'Plot 1, Campus Road\nBhubaneswar 751024',
      pan: 'AAATK1234F',
      breakup: {
        heads: [
          { label: 'Tuition', chargedPaise: 4_500_000, waivedPaise: 500_000 },
          { label: 'Library', chargedPaise: 200_000, waivedPaise: 0 },
        ],
      },
    }),
  )
  const printed = await printedText(bytes)
  for (const s of [
    'Rupees One Thousand Two Hundred Only',
    'PAN AAATK1234F',
    'Plot 1, Campus Road',
    'Bhubaneswar 751024',
    'Tuition',
    `INR ${plainPaise(4_000_000)}`,
    'Term total',
    `INR ${plainPaise(4_200_000)}`,
  ]) {
    assert.ok(printed.includes(s), `${s} | ${printed.join('|')}`)
  }
})

test('a void receipt says so and claims no clearance', async () => {
  const printed = await printedText(
    await receiptPdf(
      receipt({ status: 'voided', voidedAt: new Date('2026-10-05T06:00:00Z'), voidReason: 'entered against the wrong student' }),
    ),
  )
  assert.ok(printed.includes('VOID: cancelled on 2026-10-05. entered against the wrong student'), printed.join('|'))
  assert.ok(!printed.includes('Pending reconciliation — subject to clearance of funds'), printed.join('|'))
})

test("a returned cheque's receipt says so", async () => {
  const printed = await printedText(
    await receiptPdf(receipt({ method: 'cheque', status: 'bounced', bouncedOn: '2026-10-07', voidReason: 'funds insufficient' })),
  )
  assert.ok(printed.includes('CHEQUE RETURNED UNPAID on 2026-10-07. funds insufficient'), printed.join('|'))
})
