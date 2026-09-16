import type { Grade, Transcript } from '../api/schemas'

/** Presentational only, as with the other modules. */

export function ProvisionalNotice() {
  return (
    <p className="rounded border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-800">
      Provisional. Some enrolled courses have no published results yet, so the
      averages below cover only what has been published.
    </p>
  )
}

export function GradeTable({ grades, showPoints }: { grades: Grade[]; showPoints: boolean }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-md text-left text-sm">
        <thead className="border-b border-neutral-300 text-xs uppercase text-neutral-500">
          <tr>
            <th className="py-2 pr-4 font-medium">Course</th>
            <th className="py-2 pr-4 font-medium">Title</th>
            <th className="py-2 pr-4 font-medium">Credits</th>
            <th className="py-2 pr-4 font-medium">%</th>
            <th className="py-2 pr-4 font-medium">Grade</th>
            {showPoints && <th className="py-2 pr-4 font-medium">Points</th>}
          </tr>
        </thead>
        <tbody>
          {grades.map((g) => (
            <tr key={g.courseCode} className="border-b border-neutral-200">
              <td className="py-2 pr-4 font-mono text-xs">{g.courseCode}</td>
              <td className="py-2 pr-4">{g.courseTitle}</td>
              <td className="py-2 pr-4">{g.credits}</td>
              <td className="py-2 pr-4">{g.percent.toFixed(2)}</td>
              <td className="py-2 pr-4">
                <span className={g.passed ? '' : 'font-medium text-red-700'}>
                  {g.label ?? '—'}
                </span>
                {!g.complete && (
                  <span className="ml-2 text-xs text-amber-700">incomplete</span>
                )}
              </td>
              {showPoints && (
                <td className="py-2 pr-4">{g.points === null ? '—' : g.points.toFixed(2)}</td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

export function TranscriptView({ transcript: t }: { transcript: Transcript }) {
  const showPoints = t.schemeKind !== 'percentage'

  return (
    <div className="space-y-8">
      <div className="space-y-1">
        <p className="text-sm text-neutral-600">
          {t.institutionName}
          {t.programCode && ` · ${t.programCode}`}
        </p>
        <p className="text-xs text-neutral-500">
          Graded on {t.schemeName} ({t.schemeKind})
        </p>
      </div>

      {t.provisional && <ProvisionalNotice />}

      {t.terms.length === 0 ? (
        <p className="text-sm text-neutral-600">No published results yet.</p>
      ) : (
        t.terms.map((term) => (
          <section key={term.termCode} className="space-y-3">
            <h3 className="font-medium">
              {term.termCode} — {term.termName}
            </h3>
            <GradeTable grades={term.grades} showPoints={showPoints} />
            <p className="text-sm text-neutral-600">
              Credits {term.credits}
              {showPoints && ` · GPA ${term.gpa === null ? '—' : term.gpa.toFixed(2)}`}
            </p>
          </section>
        ))
      )}

      {t.terms.length > 0 && (
        <p className="border-t border-neutral-200 pt-4 text-sm font-medium">
          Cumulative: {t.totalCredits} credits
          {showPoints &&
            ` · CGPA ${t.cumulativeGpa === null ? '—' : t.cumulativeGpa.toFixed(2)}`}
        </p>
      )}
    </div>
  )
}
