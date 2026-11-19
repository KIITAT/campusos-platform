import { listSections, listStructure } from '@campusos/module-academic/api'
import { CATEGORY_LABELS, STUDENT_CATEGORIES } from '@campusos/module-academic/schema'
import type { PluginPage } from '@campusos/module-framework'
import { ADMIN, listApplications, listEnquiries } from './api'
import { choice, field, form, people, pick, screen, table } from './ui'

export const pages: PluginPage[] = [
  screen({
    path: '/', title: 'Admissions enquiries', menu: 'Enquiries', roles: ADMIN,
    load: async actor => ({ enquiries: await listEnquiries(actor) }),
    sections: () => [
      { kind: 'note', text: 'Record an enquiry, submit its programme application, then record an offer. Accepting enrols the applicant: it creates their student account (or uses the one you pick), gives a roll number, seats them in the section and, when Fees is on, invoices the term.' },
      { kind: 'shortcuts', items: [{ label: 'Applications and offers', href: '/m/admissions/applications' }] },
      table('Enquiries', 'enquiries', [{ key: 'name', label: 'Applicant' }, { key: 'email', label: 'Email' }, { key: 'phone', label: 'Phone' }, { key: 'note', label: 'Enquiry' }]),
      form('Record enquiry', '/enquiries', [field('name', 'Applicant name'), field('email', 'Email', 'text'), field('phone', 'Phone', 'text', true), field('note', 'Enquiry notes', 'textarea', true)]),
    ],
  }),
  screen({
    path: '/applications', title: 'Applications and offers', menu: 'Applications', roles: ADMIN,
    load: async actor => {
      const [applications, enquiries, structure, identities, sections] = await Promise.all([listApplications(actor), listEnquiries(actor), listStructure(actor), people(actor), listSections(actor)])
      return {
        applications, enquiryOptions: enquiries.map(row => ({ value: row.id, label: `${row.name} · ${row.email}` })),
        programOptions: structure.programs.map(row => ({ value: row.id, label: `${row.code} · ${row.name}` })),
        termOptions: structure.terms.map(row => ({ value: row.id, label: row.name })),
        applicationOptions: applications.filter(row => ['submitted', 'offered'].includes(row.status)).map(row => ({ value: row.id, label: `${row.name} · ${row.program} · ${row.status}` })),
        offeredOptions: applications.filter(row => row.status === 'offered').map(row => ({ value: row.id, label: `${row.name} · ${row.program}` })),
        studentOptions: identities.filter(row => row.role === 'student').map(row => ({ value: row.id, label: `${row.name} · ${row.email}` })),
        sectionOptions: sections.map(s => ({ value: s.id, label: `${s.programCode} · ${s.admissionYear} · ${s.label}` })),
        categoryOptions: STUDENT_CATEGORIES.map(v => ({ value: v, label: CATEGORY_LABELS[v] })),
      }
    },
    sections: () => [
      table('Applications', 'applications', [{ key: 'name', label: 'Applicant' }, { key: 'program', label: 'Programme' }, { key: 'term', label: 'Intake' }, { key: 'status', label: 'Status', kind: 'status' }, { key: 'reason', label: 'Decision reason' }, { key: 'studentId', label: 'Linked student' }]),
      form('Submit application', '/applications', [pick('enquiryId', 'Enquiry', 'enquiryOptions'), pick('programId', 'Programme', 'programOptions'), pick('termId', 'Intake term', 'termOptions'), field('applicantName', 'Applicant name, if not the enquirer', 'text', true), field('applicantEmail', "Applicant's own email, if not the enquirer's", 'text', true), field('dateOfBirth', 'Date of birth', 'date', true), pick('category', 'Category', 'categoryOptions', true)]),
      form('Record decision', '/applications/decision', [pick('applicationId', 'Application', 'applicationOptions'), { name: 'decision', label: 'Decision', kind: 'select', options: choice(['offer', 'reject', 'withdraw']) }, field('reason', 'Reason', 'textarea')]),
      form('Accept and enrol', '/applications/accept', [pick('applicationId', 'Offered application', 'offeredOptions'), pick('sectionId', 'Section', 'sectionOptions'), pick('studentId', 'Existing student account (leave empty to create one)', 'studentOptions', true)]),
    ],
  }),
]
