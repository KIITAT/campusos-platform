/**
 * A CSV reader, RFC 4180: quoted fields, doubled quotes inside them, commas and
 * newlines inside quotes, CRLF or LF line endings, and the byte-order mark a
 * Windows spreadsheet writes. Splitting on commas is wrong the first time a
 * roster holds "Rao, Priya", which is the file somebody uploads on day one.
 *
 * Each record keeps the line it started on, so a refusal can say "line 14" and
 * mean the line the person sees in their editor, header included.
 */

export interface CsvRecord {
  line: number
  cells: string[]
}

export function parseCsvRecords(text: string): CsvRecord[] {
  const records: CsvRecord[] = []
  let cells: string[] = []
  let field = ''
  let quoted = false
  let line = 1
  let start = 1
  let i = text.charCodeAt(0) === 0xfeff ? 1 : 0

  const endField = () => {
    cells.push(field)
    field = ''
  }
  const endRecord = () => {
    endField()
    // A blank line, or the newline at the end of the file, is not a record.
    if (cells.length > 1 || cells[0]!.trim() !== '') records.push({ line: start, cells })
    cells = []
  }

  while (i < text.length) {
    const c = text[i]!
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"'
          i += 2
          continue
        }
        quoted = false
      } else {
        if (c === '\n') line++
        field += c
      }
      i++
      continue
    }
    if (c === '"' && field.trim() === '') {
      quoted = true
      field = ''
    } else if (c === ',') {
      endField()
    } else if (c === '\n') {
      endRecord()
      line++
      start = line
    } else if (c !== '\r') {
      field += c
    }
    i++
  }
  if (field !== '' || cells.length > 0) endRecord()
  return records
}

/**
 * Header names compared loosely: "Course Code", "course_code" and
 * "COURSE-CODE" are one column, which is what a file assembled by three
 * offices looks like.
 */
export const normaliseHeader = (h: string) => h.trim().toLowerCase().replace(/[\s_-]+/g, '')

/** A cell for a CSV file: quoted when it holds a comma, a quote or a line break. */
export const csvCell = (value: string) => (/[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value)
