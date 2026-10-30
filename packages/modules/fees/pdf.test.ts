import { test } from 'node:test'
import assert from 'node:assert/strict'
import { printedText } from '@campusos/module-framework/pdf'
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
