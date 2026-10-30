import 'regenerator-runtime/runtime.js' // @pdf-lib/fontkit's Indic shaper calls a global regeneratorRuntime
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import fontkit from '@pdf-lib/fontkit'
import {
  PDFDocument,
  PDFHexString,
  PDFName,
  PDFOperator,
  PDFOperatorNames,
  PDFArray,
  PDFRawStream,
  decodePDFRawStream,
  type PDFFont,
  type PDFPage,
  type RGB,
} from 'pdf-lib'
import { PluginError } from './plugin'

/**
 * Text for PDF documents of record, in Noto Sans for Latin and nine Indian
 * scripts (fonts/, SIL OFL 1.1). Drawn text is shaped by @pdf-lib/fontkit,
 * checked for glyphs (a missing one is refused, never printed as `?`), and
 * carries its typed form as /ActualText so copy, search and screen readers get
 * the logical order and not the visual glyph order.
 *
 * Imported only through `@campusos/module-framework/pdf`, never from the
 * package index, so the web host's own bundle does not carry the shaper.
 */

export type Script =
  | 'latin'
  | 'devanagari'
  | 'bengali'
  | 'gurmukhi'
  | 'gujarati'
  | 'oriya'
  | 'tamil'
  | 'telugu'
  | 'kannada'
  | 'malayalam'
export type Weight = 'regular' | 'bold'

export class MissingGlyphError extends PluginError {
  constructor(char: string) {
    const cp = (char.codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, '0')
    super(409, 'missing_glyph', `"${char}" (U+${cp}) cannot be printed in this document`)
  }
}

/** Where the font files are: set by the host (a plugin bundle has no fonts of its own). */
export function useFontDir(dir: string): void {
  ;(globalThis as { __campusosFontDir?: string }).__campusosFontDir = dir
}

// Positioning tables are off: GPOS anchors crash fontkit on Noto Malayalam and
// Gurmukhi, and pdf-lib draws no GPOS offsets anyway, so nothing it would have
// drawn is lost. Shaping (substitution, conjuncts, reordering) is unaffected.
const FEATURES = { mark: false, mkmk: false, abvm: false, blwm: false, dist: false, kern: false }

const RANGES: [number, number, Script][] = [
  [0x0900, 0x097f, 'devanagari'],
  [0x0980, 0x09ff, 'bengali'],
  [0x0a00, 0x0a7f, 'gurmukhi'],
  [0x0a80, 0x0aff, 'gujarati'],
  [0x0b00, 0x0b7f, 'oriya'],
  [0x0b80, 0x0bff, 'tamil'],
  [0x0c00, 0x0c7f, 'telugu'],
  [0x0c80, 0x0cff, 'kannada'],
  [0x0d00, 0x0d7f, 'malayalam'],
]

export function scriptOf(codePoint: number): Script {
  for (const [lo, hi, script] of RANGES) if (codePoint >= lo && codePoint <= hi) return script
  return 'latin'
}

const JOINS = new Set([0x20, 0xa0, 0x200c, 0x200d])

/** Runs of one script. Spaces and joiners stay with the run before them. */
export function runsOf(text: string): { script: Script; text: string }[] {
  const runs: { script: Script; text: string }[] = []
  for (const ch of text.normalize('NFC').replace(/[\t\r\n]/g, ' ')) {
    const cp = ch.codePointAt(0)!
    const last = runs[runs.length - 1]
    const script: Script = JOINS.has(cp) ? (last?.script ?? 'latin') : scriptOf(cp)
    if (last && last.script === script) last.text += ch
    else runs.push({ script, text: ch })
  }
  return runs
}

function fontDir(): string {
  return (
    (globalThis as { __campusosFontDir?: string }).__campusosFontDir ??
    fileURLToPath(new URL('../fonts/', import.meta.url))
  )
}

function fileOf(script: Script, weight: Weight): string {
  const name = script === 'latin' ? 'NotoSans' : `NotoSans${script[0]!.toUpperCase()}${script.slice(1)}`
  return `${name}-${weight === 'bold' ? 'Bold' : 'Regular'}.ttf`
}

const bytesCache = new Map<string, Buffer>()
function fontBytes(script: Script, weight: Weight): Buffer {
  const dir = fontDir()
  const path = join(dir, fileOf(script, weight))
  let bytes = bytesCache.get(path)
  if (!bytes) {
    if (!existsSync(path)) throw new Error(`fonts not found in ${dir}: the host sets globalThis.__campusosFontDir`)
    bytes = readFileSync(path)
    bytesCache.set(path, bytes)
  }
  return bytes
}

const kitCache = new Map<Buffer, ReturnType<typeof fontkit.create>>()
function kitFont(script: Script) {
  const bytes = fontBytes(script, 'regular')
  let f = kitCache.get(bytes)
  if (!f) {
    f = fontkit.create(bytes)
    kitCache.set(bytes, f)
  }
  return f
}

/** The first character with no glyph in its run's Regular font, else null. */
export function unprintable(text: string): string | null {
  for (const run of runsOf(text)) {
    const f = kitFont(run.script)
    for (const ch of run.text) {
      const cp = ch.codePointAt(0)!
      if (cp === 0x200c || cp === 0x200d) continue
      if (!f.hasGlyphForCodePoint(cp)) return ch
    }
  }
  return null
}

export interface PdfText {
  width(text: string, size: number, weight?: Weight): number
  draw(page: PDFPage, text: string, at: { x: number; y: number; size: number; weight?: Weight; color?: RGB; opacity?: number }): void
}

/**
 * Embed Noto Sans Regular and Bold, and both weights of each script that occurs
 * in `content` (callers pass the JSON of every value they are about to draw).
 */
export async function pdfText(doc: PDFDocument, content: string): Promise<PdfText> {
  doc.registerFontkit(fontkit)
  const fonts = new Map<string, PDFFont>()
  const embed = async (script: Script) => {
    for (const weight of ['regular', 'bold'] as const) {
      fonts.set(`${script}/${weight}`, await doc.embedFont(fontBytes(script, weight), { subset: true, features: FEATURES }))
    }
  }
  await embed('latin')
  for (const script of new Set(runsOf(content).map((r) => r.script))) if (script !== 'latin') await embed(script)

  const fontFor = (script: Script, weight: Weight): PDFFont => {
    const f = fonts.get(`${script}/${weight}`)
    if (!f) throw new Error(`pdfText: ${script} text was drawn but was not in the content given to pdfText`)
    return f
  }

  return {
    width(text, size, weight = 'regular') {
      return runsOf(text).reduce((n, r) => n + fontFor(r.script, weight).widthOfTextAtSize(r.text, size), 0)
    },
    draw(page, text, { x, y, size, weight = 'regular', color, opacity }) {
      const bad = unprintable(text)
      if (bad) throw new MissingGlyphError(bad)
      let at = x
      for (const run of runsOf(text)) {
        const font = fontFor(run.script, weight)
        // A glyph id of 0 is .notdef, drawn as a box.
        const glyphs: string[] = font.encodeText(run.text).asString().match(/.{4}/g) ?? []
        if (glyphs.includes('0000')) throw new MissingGlyphError(run.text.trim()[0] ?? run.text)
        page.pushOperators(
          PDFOperator.of(PDFOperatorNames.BeginMarkedContentSequence, [
            PDFName.of('Span'),
            // pdf-lib types an operator argument without a dictionary, but writes one inline.
            doc.context.obj({ ActualText: PDFHexString.fromText(run.text) }) as never,
          ]),
        )
        page.drawText(run.text, { x: at, y, size, font, color, opacity })
        page.pushOperators(PDFOperator.of(PDFOperatorNames.EndMarkedContent))
        at += font.widthOfTextAtSize(run.text, size)
      }
    },
  }
}

/** The text of a PDF as typed: every /ActualText, page by page, in order. */
export async function printedText(bytes: Uint8Array): Promise<string[]> {
  const doc = await PDFDocument.load(bytes)
  const out: string[] = []
  for (const page of doc.getPages()) {
    const contents = page.node.Contents()
    const streams = contents instanceof PDFArray ? contents.asArray().map((r) => doc.context.lookup(r)) : [contents]
    for (const s of streams) {
      if (!(s instanceof PDFRawStream)) continue
      const body = Buffer.from(decodePDFRawStream(s).decode()).toString('latin1')
      for (const m of body.matchAll(/\/ActualText\s*<([0-9A-Fa-f]+)>/g)) {
        const raw = Buffer.from(m[1]!, 'hex')
        out.push(new TextDecoder('utf-16be').decode(raw.subarray(2)))
      }
    }
  }
  return out
}
