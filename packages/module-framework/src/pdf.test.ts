import { test } from 'node:test'
import assert from 'node:assert/strict'
import { PDFDocument } from 'pdf-lib'
import { MissingGlyphError, pdfText, printedText, runsOf, unprintable } from './pdf'

const NAMES = [
  'अभिषेक कुमार',
  'ଅଭିଷେକ ପଟ୍ଟନାୟକ',
  'அபிஷேக் கிருஷ்ணன்',
  'অভিষেক চট্টোপাধ্যায়',
  'అభిషేక్',
  'ಅಭಿಷೇಕ್',
  'അഭിഷേക് ശ്രീകുമാർ',
  'અભિષેક',
  'ਅਭਿਸ਼ੇਕ ਸਿੰਘ',
  'Zoë Ñúñez ₹1,200',
]

test('names in nine scripts and accented Latin survive a round trip (UX-01)', async () => {
  const doc = await PDFDocument.create()
  const page = doc.addPage()
  const t = await pdfText(doc, JSON.stringify(NAMES))
  NAMES.forEach((name, i) => {
    t.draw(page, name, { x: 40, y: 800 - i * 30, size: 14 })
    t.draw(page, name, { x: 300, y: 800 - i * 30, size: 14, weight: 'bold' })
  })
  const printed = await printedText(await doc.save())
  for (const name of NAMES) {
    assert.equal(printed.filter((p) => p === name.normalize('NFC')).length, 2, name)
  }
})

test('a mixed line splits into runs by script (UX-01)', () => {
  assert.deepEqual(runsOf('Name: अभिषेक कुमार (B.Tech)'), [
    { script: 'latin', text: 'Name: ' },
    { script: 'devanagari', text: 'अभिषेक कुमार ' },
    { script: 'latin', text: '(B.Tech)' },
  ])
})

test('a character no font has is refused, not folded (UX-01)', async () => {
  assert.equal(unprintable('Asha 😀'), '😀')
  const doc = await PDFDocument.create()
  const page = doc.addPage()
  const t = await pdfText(doc, 'Asha')
  assert.throws(
    () => t.draw(page, 'Asha 😀', { x: 0, y: 0, size: 12 }),
    (e: unknown) =>
      e instanceof MissingGlyphError &&
      e.status === 409 &&
      e.code === 'missing_glyph' &&
      e.message.includes('U+1F600'),
  )
})

test('drawing a script left out of the content is a programming error (UX-01)', async () => {
  const doc = await PDFDocument.create()
  const page = doc.addPage()
  const t = await pdfText(doc, 'latin only')
  assert.throws(() => t.draw(page, 'अभिषेक', { x: 0, y: 0, size: 12 }), /devanagari/)
})

test('width is the sum of the runs (UX-01)', async () => {
  const doc = await PDFDocument.create()
  const t = await pdfText(doc, 'Ab अभि')
  assert.ok(t.width('Ab अभि', 12) > t.width('Ab', 12))
  const sum = runsOf('Ab अभि').reduce((n, r) => n + t.width(r.text, 12), 0)
  assert.ok(Math.abs(t.width('Ab अभि', 12) - sum) < 1e-9)
})
