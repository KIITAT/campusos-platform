import { createHash } from 'node:crypto'

/**
 * A file, as a module receives it.
 *
 * Plugins are a JSON API -- the mobile client and integrations call them too --
 * so a file arrives as JSON: its name, its declared type, its size and its
 * bytes in base64. The host turns a form's file input into exactly this, and
 * caps the size before a module ever sees it.
 */
export interface Upload {
  name: string
  type: string
  size: number
  base64: string
}

/** The host refuses anything bigger, whatever a module would accept. */
export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024

export class UploadError extends Error {
  constructor(
    readonly code: 'no_file' | 'bad_file' | 'too_large' | 'wrong_type',
    message: string,
  ) {
    super(message)
  }
}

export interface ReadUpload {
  name: string
  type: string
  size: number
  bytes: Buffer
  /** Hex, for showing that the file kept is the file sent. */
  sha256: string
}

const SIGNATURES: Record<string, (b: Buffer) => boolean> = {
  'application/pdf': (b) => b.subarray(0, 5).toString('latin1') === '%PDF-',
  'image/png': (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
  'image/jpeg': (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
}

/**
 * Check and decode an upload. The declared type is the sender's claim, so a
 * type with a known signature is checked against the bytes: a renamed
 * executable is not a PDF because its name ends in .pdf.
 */
export function readUpload(
  value: unknown,
  opts: { maxBytes?: number; types?: string[]; what?: string } = {},
): ReadUpload {
  const what = opts.what ?? 'the file'
  if (value === undefined || value === null || value === '') throw new UploadError('no_file', `attach ${what}`)
  const v = value as Partial<Upload>
  if (typeof v !== 'object' || typeof v.base64 !== 'string' || typeof v.name !== 'string') {
    throw new UploadError('bad_file', `${what} did not arrive as a file`)
  }
  const bytes = Buffer.from(v.base64, 'base64')
  const max = Math.min(opts.maxBytes ?? MAX_UPLOAD_BYTES, MAX_UPLOAD_BYTES)
  if (bytes.length === 0) throw new UploadError('no_file', `${what} is empty`)
  if (bytes.length > max) {
    throw new UploadError('too_large', `${what} is ${(bytes.length / 1048576).toFixed(1)} MB; the limit is ${(max / 1048576).toFixed(0)} MB`)
  }
  const type = String(v.type ?? '').toLowerCase()
  if (opts.types && !opts.types.includes(type)) {
    throw new UploadError('wrong_type', `${what} must be ${opts.types.join(' or ')}`)
  }
  const sig = SIGNATURES[type]
  if (sig && !sig(bytes)) throw new UploadError('wrong_type', `${what} is not really ${type}`)
  return {
    name: v.name.replace(/[/\\\r\n]/g, '_').slice(0, 200),
    type,
    size: bytes.length,
    bytes,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  }
}
