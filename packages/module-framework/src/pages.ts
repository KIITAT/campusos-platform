import type { Role } from './types'
import type { PluginActor } from './plugin'

/**
 * How a plugin describes its screens.
 *
 * The obvious approach -- a plugin ships React components and the host renders
 * them -- does not survive contact with the problem. React would have to be
 * shared across a runtime `import()` of a file the bundler never saw, and
 * Tailwind generates CSS by scanning source at build time, so any class name
 * that existed only inside a plugin would have no styles. Both are solvable
 * with enough machinery, and the machinery would be the largest thing in this
 * codebase.
 *
 * So a plugin declares *what* its screens contain and the host decides how they
 * look. Tables, forms and notes, over data the plugin loaded. The host renders
 * them with its own components, which means a plugin nobody has seen yet gets a
 * usable interface for free, every screen in the product looks the same, and a
 * design change lands everywhere at once.
 *
 * The cost is honest and worth naming: a plugin cannot draw something the host
 * has no vocabulary for. When one genuinely needs to, the answer is to add a
 * section kind here -- a deliberate, reviewed widening of the contract -- rather
 * than to hand plugins a blank canvas.
 */

export type CellKind =
  | 'text'
  | 'code'   // monospace: an accession number, a receipt number, a short id
  | 'money'  // integer paise, formatted by the host in the reader's locale
  | 'date'   // an ISO string, shown as a date
  | 'when'   // an ISO string, shown as a date and time
  | 'days'   // a whole number of days
  | 'bool'

export interface PluginColumn {
  key: string
  label: string
  kind?: CellKind
  /**
   * A row template for a link, `{key}` substituted from the row:
   * `/m/fees/student?studentId={studentId}`. Absent means plain text.
   */
  href?: string
  /** Rendered in a warning colour when this row's named field is truthy. */
  alertWhen?: string
}

export interface PluginTable {
  kind: 'table'
  title?: string
  note?: string
  /** Key into the page's loaded data; must be an array. */
  rows: string
  columns: PluginColumn[]
  empty?: string
}

export type FieldKind =
  | 'text'
  | 'number'
  | 'date'
  | 'money'
  | 'textarea'
  | 'select'
  | 'checkbox'
  | 'hidden'

export interface PluginField {
  name: string
  label: string
  kind?: FieldKind
  hint?: string
  optional?: boolean
  value?: string
  /**
   * For a select: either fixed options, or a key into the loaded data holding
   * `{ value, label }` objects. The latter is the common case -- a list of
   * terms, rooms or students the plugin just fetched.
   */
  options?: { value: string; label: string }[] | string
  rows?: number
}

export interface PluginForm {
  kind: 'form'
  title?: string
  note?: string
  submit: string
  /** Relative to the module's apiBasePath, exactly as a route declares it. */
  path: string
  method?: 'POST' | 'PUT'
  fields: PluginField[]
  /** Hidden from a reader who lacks all of these. */
  roles?: Role[]
}

export interface PluginNote {
  kind: 'note'
  tone?: 'info' | 'warn' | 'danger'
  text: string
}

export interface PluginFigures {
  kind: 'figures'
  title?: string
  figures: { label: string; value: string; tone?: 'due' | 'clear' }[]
}

export interface PluginLinks {
  kind: 'links'
  title?: string
  links: { label: string; href: string; active?: boolean }[]
}

export type PluginSection =
  | PluginTable
  | PluginForm
  | PluginNote
  | PluginFigures
  | PluginLinks

export interface PluginPage {
  /** Relative to `/m/<moduleId>`; `/` is the module's own landing screen. */
  path: string
  title: string
  /** Who sees it at all. The operations behind it still check for themselves. */
  roles: Role[]
  /** Shown in the module's own sub-navigation. Absent means "not in the menu". */
  menu?: string
  load: (actor: PluginActor, req: Request) => Promise<Record<string, unknown>>
  sections: (data: Record<string, unknown>) => PluginSection[]
}

/** Substitute `{key}` placeholders in a template from a row. */
export function fillTemplate(template: string, row: Record<string, unknown>): string {
  return template.replace(/\{(\w+)\}/g, (_, key: string) =>
    encodeURIComponent(String(row[key] ?? '')),
  )
}

export function matchPage(pages: PluginPage[], path: string): PluginPage | null {
  const wanted = path === '' ? '/' : path.startsWith('/') ? path : `/${path}`
  return pages.find((p) => p.path === wanted) ?? null
}

/** Pages this reader may open, for the module's sub-navigation. */
export const pagesFor = (pages: PluginPage[], role: Role): PluginPage[] =>
  pages.filter((p) => p.menu && p.roles.includes(role))
