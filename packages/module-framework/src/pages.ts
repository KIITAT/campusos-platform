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
  | 'status' // a lifecycle word -- draft, open, paid, cancelled -- shown as a coloured badge

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
  /**
   * Rows shown before "more". The host pages, searches and sorts a table
   * itself, over the rows the page loaded -- every list view gets a filter bar
   * and a sort for nothing -- so this is only the first screenful. Default 20.
   */
  pageSize?: number
  /**
   * Row checkboxes, and what to do with the ticked ones. Posts `{ [field]:
   * [ids...] }` plus any extra fields to a route of the module, like a form.
   * Absent means no checkboxes: a box that does nothing is clutter.
   */
  bulk?: PluginBulkAction[]
}

export interface PluginBulkAction {
  label: string
  path: string
  /** The row key holding each row's id. */
  idKey: string
  /** The body field the ids are sent as. Default `ids`. */
  field?: string
  /** Asked for alongside, e.g. a reason. Rendered inline beside the button. */
  fields?: PluginField[]
  roles?: Role[]
  tone?: 'danger'
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
  /**
   * Where it goes. `action` puts a button in the page head that opens the
   * form in a sheet -- the "+ New" of a list view -- and `inline` renders it
   * in the flow of the page. Default: `action` on a page that has a table,
   * `inline` on one that does not, which is usually right: a list with a
   * create form is a list first, and a page that is only a form is the form.
   */
  placement?: 'action' | 'inline'
}

/**
 * What an operation behind a form may say back.
 *
 * Any JSON answer carrying `notice` has it shown to the person who submitted
 * the form, once, on the page they return to; `link` (a path on the
 * institution's own host) is shown beside it as a full address to copy. The
 * API is unchanged for every other caller -- these are ordinary fields.
 */
export interface FormOutcome {
  notice?: string
  link?: string | null
}

export interface PluginNote {
  kind: 'note'
  tone?: 'info' | 'warn' | 'danger'
  text: string
}

export interface PluginFigures {
  kind: 'figures'
  title?: string
  figures: { label: string; value: string; tone?: 'due' | 'clear'; hint?: string; href?: string }[]
}

export interface PluginLinks {
  kind: 'links'
  title?: string
  links: { label: string; href: string; active?: boolean }[]
}

/**
 * Records as cards in columns by status: an applicant pipeline, an admissions
 * funnel, a queue of requests. The columns are declared, in order, so an empty
 * stage still shows as a place things can be.
 */
export interface PluginKanban {
  kind: 'kanban'
  title?: string
  note?: string
  rows: string
  /** The row key whose value picks the column. */
  groupBy: string
  lanes: { value: string; label: string; tone?: Tone }[]
  card: {
    title: string
    subtitle?: string
    /** Small facts along the bottom of the card. */
    meta?: PluginColumn[]
    href?: string
  }
  empty?: string
}

/** A workspace's way in: a card per place worth going, optionally with a count. */
export interface PluginShortcuts {
  kind: 'shortcuts'
  title?: string
  items: { label: string; href: string; description?: string; count?: string; tone?: Tone }[]
}

/**
 * A chart over rows the page loaded, drawn by the host as SVG -- no script, so
 * it renders wherever the rest of the page does.
 */
export interface PluginChart {
  kind: 'chart'
  title?: string
  note?: string
  type: 'bar' | 'line'
  rows: string
  /** The row key along the bottom. */
  x: string
  series: { key: string; label: string }[]
  /** How values read: integer paise, or plain numbers. */
  unit?: 'money' | 'number'
  empty?: string
}

export type Tone = 'gray' | 'blue' | 'green' | 'orange' | 'red' | 'violet'

export type PluginSection =
  | PluginTable
  | PluginForm
  | PluginNote
  | PluginFigures
  | PluginLinks
  | PluginKanban
  | PluginShortcuts
  | PluginChart

/**
 * The lifecycle a record can opt into: draft, then submitted, then possibly
 * cancelled -- and a cancelled record amended into a new draft rather than
 * edited. The database enforces it (see docstatus in @campusos/db); this is
 * how a page shows it and offers the next step.
 */
export type DocStatus = 'draft' | 'submitted' | 'cancelled'

/**
 * One record, shown as a form view: its facts in the main column, and a
 * sidebar with who made it, when it last changed, and its history.
 *
 * `audit` names the record in the shared audit log; the host reads that
 * record's trail itself and shows it as the timeline, so no module writes a
 * history screen of its own.
 */
export interface PluginRecord {
  title: string
  subtitle?: string
  status?: { label: string; tone?: Tone }
  fields?: { label: string; value: unknown; kind?: CellKind }[]
  createdAt?: string | null
  createdBy?: string | null
  modifiedAt?: string | null
  modifiedBy?: string | null
  audit?: { entity: string; entityId: string }
  /** Anything else worth a line in the timeline, merged with the audit trail. */
  timeline?: { at: string; who?: string | null; text: string }[]
  docStatus?: {
    value: DocStatus
    /** Posted with `{ [idField]: id }`. Each is offered only in the state it applies to. */
    id: string
    idField?: string
    submit?: string
    cancel?: string
    amend?: string
    roles?: Role[]
  }
}

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
  /**
   * Present, and returning a record, makes this a form view: the sections
   * render in the main column beside the record's sidebar. Returning null
   * (nothing chosen yet) renders the page as usual.
   */
  record?: (data: Record<string, unknown>) => PluginRecord | null
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
