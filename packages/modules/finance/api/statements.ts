import { inflateRawSync } from 'node:zlib'
import { parseDecimal } from './numbers'

/**
 * Reading what a bank sends: CSV and XLSX downloads from net banking, MT940
 * and CAMT.053 files from a corporate account. No library and no service --
 * each format is read here, small enough to check by reading it.
 *
 * Every parser gives the same thing back: lines with a date, a narration, a
 * reference, money out or money in, and the balance where the bank gave one;
 * and the statement's opening and closing balances where the format has them.
 */

export interface StatementLine {
  txnDate: string
  valueDate?: string | null
  description: string
  reference?: string | null
  withdrawalPaise: number
  depositPaise: number
  balancePaise?: number | null
}

export interface ParsedStatement {
  format: 'csv' | 'xlsx' | 'mt940' | 'camt053'
  lines: StatementLine[]
  openingPaise?: number | null
  closingPaise?: number | null
  fromDate?: string | null
  toDate?: string | null
  /** The columns a CSV or a sheet was read by, to keep for the next file from that bank. */
  mapping?: ColumnMapping
}

export class StatementError extends Error {}

// --- amounts and dates --------------------------------------------------------------

/**
 * An amount as banks write it: "1,23,456.78", "(500.00)", "500.00 Dr",
 * "-500", "1.234,56" from a European bank. Paise, signed; null for an empty cell.
 */
export function bankAmount(raw: unknown): number | null {
  if (raw === null || raw === undefined) return null
  let s = String(raw).trim()
  if (s === '' || s === '-' || s === '--') return null
  let sign = 1
  if (/^\(.*\)$/.test(s)) {
    sign = -1
    s = s.slice(1, -1)
  }
  if (/\s*(dr|d)\.?$/i.test(s)) {
    sign = -sign
    s = s.replace(/\s*(dr|d)\.?$/i, '')
  } else s = s.replace(/\s*(cr|c)\.?$/i, '')
  s = s.replace(/[₹$€£\s]|INR|USD|EUR|GBP/gi, '')
  if (s.startsWith('-')) {
    sign = -sign
    s = s.slice(1)
  }
  // "1.234,56": a comma for the decimal point, as SWIFT and much of Europe write.
  if (/^\d{1,3}(\.\d{3})+(,\d{1,2})?$/.test(s) || /^\d+,\d{1,2}$/.test(s)) s = s.replace(/\./g, '').replace(',', '.')
  s = s.replace(/,/g, '')
  const v = parseDecimal(s, 2)
  return v === null ? null : sign * v
}

const MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12,
}

export type DateOrder = 'dmy' | 'mdy' | 'ymd'

const iso = (y: number, m: number, d: number): string | null => {
  if (y < 100) y += y >= 70 ? 1900 : 2000
  if (m < 1 || m > 12 || d < 1 || d > 31) return null
  const dt = new Date(Date.UTC(y, m - 1, d))
  if (dt.getUTCMonth() !== m - 1) return null
  return dt.toISOString().slice(0, 10)
}

/** A date as banks write it, day first unless told otherwise. A spreadsheet's serial number too. */
export function bankDate(raw: unknown, order: DateOrder = 'dmy'): string | null {
  if (raw === null || raw === undefined) return null
  if (typeof raw === 'number' || /^\d{5}(\.\d+)?$/.test(String(raw).trim())) {
    const serial = Number(raw)
    // Days since 1899-12-30, the way Excel counts.
    if (serial > 20_000 && serial < 80_000) {
      return new Date(Date.UTC(1899, 11, 30) + Math.floor(serial) * 86_400_000).toISOString().slice(0, 10)
    }
  }
  const s = String(raw).trim().replace(/\s+\d{1,2}:\d{2}(:\d{2})?(\s*[AP]M)?$/i, '')
  let m = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/.exec(s)
  if (m) return iso(+m[1]!, +m[2]!, +m[3]!)
  m = /^(\d{1,2})[-/. ]([A-Za-z]{3,4})[-/. ,]*(\d{2,4})$/.exec(s)
  if (m && MONTHS[m[2]!.toLowerCase()]) return iso(+m[3]!, MONTHS[m[2]!.toLowerCase()]!, +m[1]!)
  m = /^([A-Za-z]{3,4})[-/. ](\d{1,2}),?[-/. ](\d{2,4})$/.exec(s)
  if (m && MONTHS[m[1]!.toLowerCase()]) return iso(+m[3]!, MONTHS[m[1]!.toLowerCase()]!, +m[2]!)
  m = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})$/.exec(s)
  if (m) return order === 'mdy' ? iso(+m[3]!, +m[1]!, +m[2]!) : iso(+m[3]!, +m[2]!, +m[1]!)
  m = /^(\d{4})(\d{2})(\d{2})$/.exec(s)
  if (m) return iso(+m[1]!, +m[2]!, +m[3]!)
  return null
}

// --- CSV ----------------------------------------------------------------------------

/** Rows of cells. Quotes, doubled quotes, and commas, semicolons or tabs as the separator. */
export function parseCsv(text: string): string[][] {
  text = text.replace(/^\uFEFF/, '')
  const firstLines = text.split(/\r?\n/).slice(0, 20).join('\n')
  const count = (c: string) => (firstLines.match(new RegExp(c === '\t' ? '\t' : `\\${c}`, 'g')) ?? []).length
  const sep = [',', ';', '\t', '|'].sort((a, b) => count(b) - count(a))[0]!
  const rows: string[][] = []
  let row: string[] = []
  let cell = ''
  let quoted = false
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        cell += '"'
        i++
      } else if (ch === '"') quoted = false
      else cell += ch
    } else if (ch === '"' && cell.trim() === '') {
      quoted = true
      cell = ''
    } else if (ch === sep) {
      row.push(cell.trim())
      cell = ''
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++
      row.push(cell.trim())
      if (row.some((c) => c !== '')) rows.push(row)
      row = []
      cell = ''
    } else cell += ch
  }
  row.push(cell.trim())
  if (row.some((c) => c !== '')) rows.push(row)
  return rows
}

/** Which column holds what. Header names as the bank wrote them. */
export interface ColumnMapping {
  date: string
  valueDate?: string
  description: string
  reference?: string
  withdrawal?: string
  deposit?: string
  /** One signed amount column, instead of two. */
  amount?: string
  /** A column saying Dr or Cr, beside an unsigned amount. */
  drCr?: string
  balance?: string
  dateOrder?: DateOrder
}

const GUESS: [keyof ColumnMapping, RegExp][] = [
  ['valueDate', /^value\s*d(a)?te?$/i],
  ['date', /^(txn|tran|transaction|posting|post|book(ing)?)?\s*\.?\s*date$|^date$/i],
  ['description', /narration|description|particulars|details|remarks|transaction\s*details/i],
  ['reference', /ref|chq|cheque|check|utr|instrument/i],
  ['withdrawal', /withdraw|debit|^dr\.?$|paid\s*out|money\s*out/i],
  ['deposit', /deposit|credit|^cr\.?$|paid\s*in|money\s*in/i],
  ['drCr', /^(dr\s*\/\s*cr|cr\s*\/\s*dr|type|d\/c)$/i],
  ['balance', /balance/i],
  ['amount', /^(txn\s*|transaction\s*)?amount(\s*\(.*\))?$/i],
]

/**
 * Find the header row -- net banking downloads put the account holder's name
 * and address above it -- and guess which column is which from its names.
 */
export function guessMapping(rows: string[][]): { headerAt: number; mapping: ColumnMapping } | null {
  for (let r = 0; r < Math.min(rows.length, 40); r++) {
    const header = rows[r]!
    const mapping: Partial<ColumnMapping> = {}
    for (const cell of header) {
      const name = cell.trim()
      if (!name) continue
      for (const [key, re] of GUESS) {
        if (mapping[key] === undefined && re.test(name)) {
          ;(mapping as Record<string, string>)[key] = name
          break
        }
      }
    }
    if (mapping.date && mapping.description && (mapping.amount || mapping.withdrawal || mapping.deposit)) {
      return { headerAt: r, mapping: mapping as ColumnMapping }
    }
  }
  return null
}

/** Rows read by a mapping into statement lines. Rows that are not transactions (totals, notes) are skipped. */
export function linesFromGrid(rows: string[][], mapping: ColumnMapping): StatementLine[] {
  const norm = (s: string) => s.trim().toLowerCase()
  const headerAt = rows.findIndex((r) => r.some((c) => norm(c) === norm(mapping.date)))
  if (headerAt < 0) throw new StatementError(`no column called "${mapping.date}" in that file`)
  const header = rows[headerAt]!.map(norm)
  const col = (name?: string) => (name ? header.indexOf(norm(name)) : -1)
  const at = {
    date: col(mapping.date),
    valueDate: col(mapping.valueDate),
    description: col(mapping.description),
    reference: col(mapping.reference),
    withdrawal: col(mapping.withdrawal),
    deposit: col(mapping.deposit),
    amount: col(mapping.amount),
    drCr: col(mapping.drCr),
    balance: col(mapping.balance),
  }
  if (at.description < 0) throw new StatementError(`no column called "${mapping.description}" in that file`)
  const out: StatementLine[] = []
  for (const row of rows.slice(headerAt + 1)) {
    const date = bankDate(row[at.date], mapping.dateOrder)
    if (!date) continue
    let out_ = 0
    let in_ = 0
    if (at.amount >= 0) {
      const v = bankAmount(row[at.amount]) ?? 0
      const dc = at.drCr >= 0 ? norm(row[at.drCr] ?? '') : ''
      const signed = dc.startsWith('d') ? -Math.abs(v) : dc.startsWith('c') ? Math.abs(v) : v
      if (signed < 0) out_ = -signed
      else in_ = signed
    } else {
      out_ = Math.abs(bankAmount(row[at.withdrawal]) ?? 0)
      in_ = Math.abs(bankAmount(row[at.deposit]) ?? 0)
    }
    if (out_ === 0 && in_ === 0) continue
    // A row with both is two lines' worth of money in one; keep the net.
    if (out_ && in_) {
      const net = in_ - out_
      out_ = net < 0 ? -net : 0
      in_ = net > 0 ? net : 0
      if (!out_ && !in_) continue
    }
    out.push({
      txnDate: date,
      valueDate: at.valueDate >= 0 ? bankDate(row[at.valueDate], mapping.dateOrder) : null,
      description: (row[at.description] ?? '').replace(/\s+/g, ' ').trim() || '(no narration)',
      reference: at.reference >= 0 ? (row[at.reference] ?? '').trim() || null : null,
      withdrawalPaise: out_,
      depositPaise: in_,
      balancePaise: at.balance >= 0 ? bankAmount(row[at.balance]) : null,
    })
  }
  return out
}

// --- XLSX ---------------------------------------------------------------------------

/** The files inside a zip, by name: enough of the format to open a spreadsheet. */
export function unzip(buf: Buffer): Map<string, Buffer> {
  let eocd = -1
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65_557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i
      break
    }
  }
  if (eocd < 0) throw new StatementError('that is not a spreadsheet (.xlsx) file')
  const entries = buf.readUInt16LE(eocd + 10)
  let p = buf.readUInt32LE(eocd + 16)
  const out = new Map<string, Buffer>()
  for (let e = 0; e < entries; e++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new StatementError('that spreadsheet is damaged')
    const method = buf.readUInt16LE(p + 10)
    const compressed = buf.readUInt32LE(p + 20)
    const nameLen = buf.readUInt16LE(p + 28)
    const extraLen = buf.readUInt16LE(p + 30)
    const commentLen = buf.readUInt16LE(p + 32)
    const local = buf.readUInt32LE(p + 42)
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString('utf8')
    const lNameLen = buf.readUInt16LE(local + 26)
    const lExtraLen = buf.readUInt16LE(local + 28)
    const start = local + 30 + lNameLen + lExtraLen
    const data = buf.subarray(start, start + compressed)
    if (method === 0) out.set(name, Buffer.from(data))
    else if (method === 8) out.set(name, inflateRawSync(data))
    p += 46 + nameLen + extraLen + commentLen
  }
  return out
}

const unescapeXml = (s: string) =>
  s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/&amp;/g, '&')

const colIndex = (ref: string) => {
  const letters = /^[A-Z]+/.exec(ref)?.[0] ?? 'A'
  let n = 0
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64)
  return n - 1
}

/** The first sheet of a workbook, as rows of cells. */
export function xlsxRows(buf: Buffer): string[][] {
  const files = unzip(buf)
  const shared: string[] = []
  const ss = files.get('xl/sharedStrings.xml')?.toString('utf8')
  if (ss) {
    for (const si of ss.match(/<si>[\s\S]*?<\/si>/g) ?? []) {
      shared.push(unescapeXml((si.match(/<t[^>]*>([\s\S]*?)<\/t>/g) ?? []).map((t) => t.replace(/<[^>]+>/g, '')).join('')))
    }
  }
  const sheetName = [...files.keys()].filter((k) => /^xl\/worksheets\/sheet\d+\.xml$/.test(k)).sort()[0]
  if (!sheetName) throw new StatementError('that workbook has no sheet')
  const sheet = files.get(sheetName)!.toString('utf8')
  const rows: string[][] = []
  for (const r of sheet.match(/<row[^>]*>[\s\S]*?<\/row>/g) ?? []) {
    const row: string[] = []
    for (const c of r.match(/<c [^>]*?(?:\/>|>[\s\S]*?<\/c>)/g) ?? []) {
      const ref = /r="([A-Z]+\d+)"/.exec(c)?.[1] ?? ''
      const type = /t="(\w+)"/.exec(c)?.[1]
      const v = /<v>([\s\S]*?)<\/v>/.exec(c)?.[1]
      let value = ''
      if (type === 's' && v !== undefined) value = shared[Number(v)] ?? ''
      else if (type === 'inlineStr') value = unescapeXml((/<t[^>]*>([\s\S]*?)<\/t>/.exec(c)?.[1] ?? '').replace(/<[^>]+>/g, ''))
      else if (v !== undefined) value = unescapeXml(v)
      row[colIndex(ref)] = value.trim()
    }
    for (let i = 0; i < row.length; i++) row[i] ??= ''
    if (row.some((x) => x !== '')) rows.push(row)
  }
  return rows
}

// --- MT940 --------------------------------------------------------------------------

/**
 * SWIFT MT940: tagged fields, a statement line in :61: and its narration in
 * the :86: that follows it. Balances in :60F:/:60M: and :62F:/:62M:.
 */
export function parseMt940(text: string): ParsedStatement {
  const fields: [string, string][] = []
  for (const raw of text.replace(/\r/g, '').split('\n')) {
    const m = /^:(\d{2}[A-Z]?):(.*)$/.exec(raw)
    if (m) fields.push([m[1]!, m[2]!])
    else if (fields.length && raw.trim() !== '-' && !raw.startsWith('{') && raw.trim() !== '') {
      fields[fields.length - 1]![1] += `\n${raw}`
    }
  }
  if (!fields.some(([t]) => t === '61')) throw new StatementError('no statement lines (:61:) in that MT940 file')
  const balance = (v: string) => {
    const m = /^([CD])(\d{6})([A-Z]{3})([\d,]+)/.exec(v.trim())
    if (!m) return null
    const amount = bankAmount(m[4]!) ?? 0
    return { date: bankDate(m[2]!.replace(/^(\d{2})(\d{2})(\d{2})$/, '20$1-$2-$3')), paise: m[1] === 'D' ? -amount : amount }
  }
  const lines: StatementLine[] = []
  let opening: number | null = null
  let closing: number | null = null
  for (let i = 0; i < fields.length; i++) {
    const [tag, value] = fields[i]!
    if ((tag === '60F' || tag === '60M') && opening === null) opening = balance(value)?.paise ?? null
    if (tag === '62F' || tag === '62M') closing = balance(value)?.paise ?? null
    if (tag !== '61') continue
    const first = value.split('\n')[0]!
    const m = /^(\d{6})(\d{4})?(R?[CD])([A-Z])?([\d,]+)([A-Z][A-Z0-9]{3})?(.*)$/.exec(first)
    if (!m) throw new StatementError(`a statement line could not be read: ${first}`)
    const [, yymmdd, , mark, , amount, , rest] = m
    const date = bankDate(yymmdd!.replace(/^(\d{2})(\d{2})(\d{2})$/, '20$1-$2-$3'))!
    const v = bankAmount(amount!) ?? 0
    // RC and RD are reversals: a reversed credit takes money out.
    const out = mark === 'D' || mark === 'RC'
    const [customerRef, bankRef] = (rest ?? '').split('//')
    const narration = fields[i + 1]?.[0] === '86' ? fields[i + 1]![1] : value.split('\n').slice(1).join(' ')
    lines.push({
      txnDate: date,
      valueDate: date,
      description: narration.replace(/\n/g, ' ').replace(/\?\d{2}/g, ' ').replace(/\s+/g, ' ').trim() || '(no narration)',
      reference: (customerRef && customerRef !== 'NONREF' ? customerRef : bankRef)?.trim() || null,
      withdrawalPaise: out ? v : 0,
      depositPaise: out ? 0 : v,
      balancePaise: null,
    })
  }
  return { format: 'mt940', lines, openingPaise: opening, closingPaise: closing }
}

// --- CAMT.053 -----------------------------------------------------------------------

const tag = (xml: string, name: string): string | null => {
  const m = new RegExp(`<(?:\\w+:)?${name}(?:\\s[^>]*)?>([\\s\\S]*?)</(?:\\w+:)?${name}>`).exec(xml)
  return m ? m[1]!.trim() : null
}
const tags = (xml: string, name: string): string[] =>
  xml.match(new RegExp(`<(?:\\w+:)?${name}(?:\\s[^>]*)?>[\\s\\S]*?</(?:\\w+:)?${name}>`, 'g')) ?? []

/** ISO 20022 camt.053: a bank-to-customer statement, entries in <Ntry>, balances in <Bal>. */
export function parseCamt053(text: string): ParsedStatement {
  const stmt = tag(text, 'Stmt')
  if (!stmt) throw new StatementError('that is not a camt.053 statement')
  let opening: number | null = null
  let closing: number | null = null
  for (const bal of tags(stmt, 'Bal')) {
    const code = tag(tag(bal, 'Tp') ?? '', 'Cd')
    const amt = bankAmount(unescapeXml(tag(bal, 'Amt') ?? '')) ?? 0
    const signed = tag(bal, 'CdtDbtInd') === 'DBIT' ? -amt : amt
    if (code === 'OPBD' || code === 'PRCD') opening ??= signed
    if (code === 'CLBD') closing = signed
  }
  const lines: StatementLine[] = []
  for (const e of tags(stmt, 'Ntry')) {
    const amt = bankAmount(tag(e, 'Amt') ?? '') ?? 0
    const debit = tag(e, 'CdtDbtInd') === 'DBIT'
    const reversal = tag(e, 'RvslInd') === 'true'
    const out = debit !== reversal
    const booked = tag(tag(e, 'BookgDt') ?? '', 'Dt') ?? tag(tag(e, 'BookgDt') ?? '', 'DtTm')?.slice(0, 10)
    const value = tag(tag(e, 'ValDt') ?? '', 'Dt')
    const narration = [
      ...tags(e, 'Ustrd').map((u) => tag(u, 'Ustrd')),
      tag(e, 'AddtlNtryInf'),
      tag(tag(e, 'RltdPties') ?? '', 'Nm'),
    ]
      .filter(Boolean)
      .map((s) => unescapeXml(s!))
      .join(' ')
    const ref = tag(e, 'EndToEndId') ?? tag(e, 'AcctSvcrRef') ?? tag(e, 'InstrId')
    const date = bankDate(booked ?? value ?? '')
    if (!date) continue
    lines.push({
      txnDate: date,
      valueDate: value ? bankDate(value) : null,
      description: narration.replace(/\s+/g, ' ').trim() || '(no narration)',
      reference: ref && ref !== 'NOTPROVIDED' ? unescapeXml(ref) : null,
      withdrawalPaise: out ? amt : 0,
      depositPaise: out ? 0 : amt,
      balancePaise: null,
    })
  }
  return { format: 'camt053', lines, openingPaise: opening, closingPaise: closing }
}

// --- any of them --------------------------------------------------------------------

/** Read a statement file, working out its format from its contents. */
export function parseStatement(bytes: Buffer, fileName: string, mapping?: ColumnMapping | null): ParsedStatement {
  let parsed: ParsedStatement
  if (bytes.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04]))) {
    const rows = xlsxRows(bytes)
    const m = mapping ?? guessMapping(rows)?.mapping
    if (!m) throw new StatementError('could not find the date, narration and amount columns; set the columns for this bank first')
    parsed = { format: 'xlsx', lines: linesFromGrid(rows, m), mapping: m }
  } else if (bytes.subarray(0, 8).equals(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]))) {
    throw new StatementError('that is an old .xls workbook; save it as .xlsx or .csv and import that')
  } else {
    const text = bytes.toString('utf8')
    if (/<(\w+:)?BkToCstmrStmt/.test(text)) parsed = parseCamt053(text)
    else if (/^:20:/m.test(text) && /^:61:/m.test(text)) parsed = parseMt940(text)
    else {
      const rows = parseCsv(text)
      const m = mapping ?? guessMapping(rows)?.mapping
      if (!m) throw new StatementError('could not find the date, narration and amount columns; set the columns for this bank first')
      parsed = { format: 'csv', lines: linesFromGrid(rows, m), mapping: m }
    }
  }
  if (parsed.lines.length === 0) throw new StatementError(`no transactions found in ${fileName}`)
  const dates = parsed.lines.map((l) => l.txnDate).sort()
  parsed.fromDate = dates[0]
  parsed.toDate = dates[dates.length - 1]
  return parsed
}
