import { test } from 'node:test'
import assert from 'node:assert/strict'
import { printedText } from '@campusos/module-framework/pdf'
import { transcriptPdf } from './api/transcript-pdf'
import { admitCardPdf, gradeReportPdf } from './api/cycle-pdf'
import type { Transcript } from './api/schemas'
import type { AdmitCard, GradeReport } from './api/cycle'
import { reportCardPdf } from './api/report-card-pdf'
import type { IssuedReportCard } from './api/report-card'

const NAME = 'অভিষেক চট্টোপাধ্যায়'

test('a transcript prints a Bengali name (UX-01)', async () => {
  const t: Transcript = {
    studentName: NAME,
    studentEmail: 'student@example.test',
    institutionName: 'Plain College',
    programCode: 'BT',
    schemeName: 'Default 10-point scale',
    schemeKind: 'gpa',
    terms: [
      {
        termCode: 'T1',
        termName: 'Autumn',
        grades: [{ courseCode: 'DS1', courseTitle: 'Data Structures', credits: 4, percent: 91, complete: true, label: 'O', points: 10, passed: true }],
        gpa: 10,
        credits: 4,
      },
    ],
    cumulativeGpa: 10,
    totalCredits: 4,
    provisional: false,
  }
  assert.ok((await printedText(await transcriptPdf(t))).includes(NAME))
})

test('a grade report prints a Bengali name (UX-01)', async () => {
  const g: GradeReport = {
    institution: 'Plain College',
    term: { code: 'T1', name: 'Autumn' },
    student: { name: NAME, rollNo: 'R1', registrationNo: 'G1', programme: 'B.Tech' },
    courses: [{ code: 'DS1', title: 'Data Structures', credits: 4, grade: 'O', points: 10, passed: true }],
    sgpa: 10,
    cgpa: 10,
    creditsEarned: 4,
    creditsEarnedTotal: 4,
  }
  assert.ok((await printedText(await gradeReportPdf(g))).includes(NAME))
})

test('an admit card prints a Bengali name (UX-01)', async () => {
  const a: AdmitCard = {
    institution: 'Plain College',
    term: { code: 'T1', name: 'Autumn' },
    ticketNo: 'HT-1',
    student: { name: NAME, rollNo: 'R1', registrationNo: 'G1', programme: 'B.Tech' },
    enrolledOn: '2026-07-01',
    timeZone: 'Asia/Kolkata',
    instructions: null,
    papers: [{ code: 'DS1', title: 'Data Structures', exam: 'Final', when: '2026-12-01 10:00', room: 'R1' }],
  }
  assert.ok((await printedText(await admitCardPdf(a))).includes(NAME))
})

test('a school term report prints a Bengali name (UX-01)', async () => {
  const r: IssuedReportCard = {
    institution: 'Plain School',
    term: { code: 'T1', name: 'Term 1' },
    classNumber: 2,
    sectionLabel: 'A',
    name: NAME,
    rollNo: 'R1',
    templateName: 'Foundational progress',
    mode: 'observations',
    subjects: [],
    areas: [{ key: 'language', label: 'Language and literacy', group: 'scholastic', grade: 'Proficient' }],
    remark: null,
    legend: [],
    attendance: { state: 'recorded', present: 40, held: 42 },
    version: 2,
    issuedAt: '2026-10-02T04:30:00.000000Z',
  }
  const text = (await printedText(await reportCardPdf(r))).join(' | ')
  assert.ok(text.includes(NAME))
  assert.ok(text.includes('Issue version 2') && text.includes('Daily attendance: 40 present out of 42 recorded days'))
  for (const [attendance, line] of [[{ state: 'recorded', present: 0, held: 0 }, 'Daily attendance: No register entries'], [{ state: 'unavailable' }, 'Daily attendance: Unavailable']] as const)
    assert.ok((await printedText(await reportCardPdf({ ...r, attendance }))).join(' | ').includes(line), line)
})
