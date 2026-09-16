import type { listOfferings, listSections, listStructure } from '../api/operations'

type Structure = Awaited<ReturnType<typeof listStructure>>
type Sections = Awaited<ReturnType<typeof listSections>>
type Offerings = Awaited<ReturnType<typeof listOfferings>>

/** Presentational tables for the academic structure. See timetable-grid.tsx. */

export function Table({
  head,
  rows,
  empty,
}: {
  head: string[]
  rows: (string | number | null)[][]
  empty: string
}) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-md text-left text-sm">
        <thead className="border-b border-neutral-300 text-xs uppercase text-neutral-500">
          <tr>
            {head.map((h) => (
              <th key={h} className="py-2 pr-4 font-medium">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i} className="border-b border-neutral-200">
              {r.map((c, j) => (
                <td key={j} className="py-2 pr-4">
                  {c ?? <span className="text-neutral-400">—</span>}
                </td>
              ))}
            </tr>
          ))}
          {rows.length === 0 && (
            <tr>
              <td colSpan={head.length} className="py-3 text-neutral-500">
                {empty}
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  )
}

export const DepartmentsTable = ({ rows }: { rows: Structure['departments'] }) => (
  <Table
    head={['Code', 'Name']}
    rows={rows.map((d) => [d.code, d.name])}
    empty="No departments yet."
  />
)

export const ProgramsTable = ({
  rows,
  departments,
}: {
  rows: Structure['programs']
  departments: Structure['departments']
}) => (
  <Table
    head={['Code', 'Name', 'Department', 'Level', 'Terms']}
    rows={rows.map((p) => [
      p.code,
      p.name,
      departments.find((d) => d.id === p.departmentId)?.code ?? null,
      p.level,
      p.durationTerms,
    ])}
    empty="No programmes yet."
  />
)

export const CoursesTable = ({
  rows,
  departments,
}: {
  rows: Structure['courses']
  departments: Structure['departments']
}) => (
  <Table
    head={['Code', 'Title', 'Department', 'Credits']}
    rows={rows.map((c) => [
      c.code,
      c.title,
      departments.find((d) => d.id === c.departmentId)?.code ?? null,
      c.credits,
    ])}
    empty="No courses yet."
  />
)

export const RoomsTable = ({ rows }: { rows: Structure['rooms'] }) => (
  <Table
    head={['Code', 'Building', 'Capacity']}
    rows={rows.map((r) => [r.code, r.building, r.capacity])}
    empty="No rooms yet."
  />
)

export const TermsTable = ({ rows }: { rows: Structure['terms'] }) => (
  <Table
    head={['Code', 'Name', 'Starts', 'Ends', 'Current']}
    rows={rows.map((t) => [t.code, t.name, t.startsOn, t.endsOn, t.isCurrent ? 'yes' : ''])}
    empty="No terms yet."
  />
)

export const SectionsTable = ({ rows }: { rows: Sections }) => (
  <Table
    head={['Programme', 'Cohort', 'Admitted', 'Students']}
    rows={rows.map((s) => [s.programName, `${s.programCode}-${s.label}`, s.admissionYear, s.members])}
    empty="No cohorts yet."
  />
)

export const OfferingsTable = ({ rows }: { rows: Offerings }) => (
  <Table
    head={['Term', 'Course', 'Title', 'Cohort', 'Lecturer']}
    rows={rows.map((o) => [
      o.termCode,
      o.courseCode,
      o.courseTitle,
      `${o.programCode}-${o.sectionLabel}`,
      o.facultyName,
    ])}
    empty="Nothing offered yet."
  />
)
