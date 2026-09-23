import { param, type PluginPage } from '@campusos/module-framework'
import {
  applicantFile,
  listApplicants,
  listOnboardingTemplates,
  listOpenings,
  listRequisitions,
  myInterviews,
  type Actor,
} from './api'

const OFFICE = ['institution_admin', 'super_admin', 'accounts_staff'] as const
const ADMIN = ['institution_admin', 'super_admin'] as const

export const recruitmentPages: PluginPage[] = [
  {
    path: '/recruitment',
    title: 'Recruitment',
    menu: 'Recruitment',
    roles: [...OFFICE],
    async load(actor, req) {
      const a = actor as Actor
      const openingId = param(req, 'openingId')
      const applicantId = param(req, 'applicantId')
      const [requisitions, openings, templates] = await Promise.all([
        listRequisitions(a),
        listOpenings(a),
        listOnboardingTemplates(a),
      ])
      const applicants = openingId ? await listApplicants(a, openingId) : []
      const file = applicantId ? await applicantFile(a, applicantId) : null
      const rounds = file?.rounds ?? []
      return {
        requisitions: requisitions.map((r) => ({
          ...r,
          filled: `${r.hired} of ${r.positions}`,
          waiting: r.status === 'pending',
        })),
        openings: openings.map((o) => ({
          ...o,
          pipeline: `${o.applied} applied, ${o.shortlisted} shortlisted, ${o.interviewing} interviewing, ${o.offered} offered, ${o.hired} hired`,
        })),
        applicants,
        openingTitle: openings.find((o) => o.id === openingId)?.title ?? '',
        feedback: rounds.flatMap((r) =>
          r.feedback.map((f) => ({ round: r.round, ...f })),
        ),
        offers: file?.offers ?? [],
        fileName: file?.applicant.name ?? '',
        pendingReqOptions: requisitions
          .filter((r) => r.status === 'pending')
          .map((r) => ({ value: r.id, label: `${r.designation} x${r.positions} - ${r.department ?? ''}` })),
        approvedReqOptions: requisitions
          .filter((r) => r.status === 'approved')
          .map((r) => ({ value: r.id, label: `${r.designation} x${r.positions} - ${r.department ?? ''}` })),
        liveOpeningOptions: openings
          .filter((o) => o.live)
          .map((o) => ({ value: o.id, label: o.title })),
        applicantOptions: applicants.map((p) => ({ value: p.id, label: `${p.name} (${p.status})` })),
        offerOptions: (file?.offers ?? [])
          .filter((o) => o.status === 'issued' || o.status === 'accepted')
          .map((o) => ({ value: o.id, label: `${o.designation}, ${o.status}` })),
        templateOptions: templates.map((t) => ({ value: t.id, label: t.name })),
        openingId: openingId ?? '',
      }
    },
    sections: (data) => [
      {
        kind: 'table',
        title: 'Openings',
        rows: 'openings',
        empty: 'Nothing advertised.',
        columns: [
          { key: 'title', label: 'Opening', href: '/m/hr/recruitment?openingId={id}' },
          { key: 'department', label: 'Department' },
          { key: 'positions', label: 'Posts' },
          { key: 'pipeline', label: 'Pipeline' },
          { key: 'closesOn', label: 'Closes', kind: 'date' },
          { key: 'live', label: 'Live', kind: 'bool' },
        ],
      },
      {
        kind: 'table',
        title: data.openingTitle ? `Applicants: ${data.openingTitle}` : 'Applicants',
        rows: 'applicants',
        empty: 'Pick an opening above.',
        columns: [
          {
            key: 'name',
            label: 'Name',
            href: `/m/hr/recruitment?openingId=${data.openingId}&applicantId={id}`,
          },
          { key: 'email', label: 'Email' },
          { key: 'source', label: 'Source' },
          { key: 'status', label: 'Status' },
        ],
      },
      {
        kind: 'table',
        title: data.fileName ? `Feedback on ${data.fileName}` : 'Feedback',
        rows: 'feedback',
        empty: 'Pick an applicant to read their file.',
        columns: [
          { key: 'round', label: 'Round' },
          { key: 'interviewer', label: 'Interviewer' },
          { key: 'rating', label: 'Rating' },
          { key: 'recommendation', label: 'Recommends' },
          { key: 'notes', label: 'Notes' },
        ],
      },
      {
        kind: 'table',
        title: 'Offers',
        rows: 'offers',
        empty: '',
        columns: [
          { key: 'designation', label: 'Post' },
          { key: 'monthlyPaise', label: 'Monthly', kind: 'money' },
          { key: 'joiningOn', label: 'Joining', kind: 'date' },
          { key: 'expiresOn', label: 'Expires', kind: 'date' },
          { key: 'status', label: 'Status' },
        ],
      },
      {
        kind: 'form',
        title: 'Record an application',
        submit: 'Add',
        path: '/recruitment/applicants',
        fields: [
          { name: 'openingId', label: 'Opening', kind: 'select', options: 'liveOpeningOptions' },
          { name: 'name', label: 'Name' },
          { name: 'email', label: 'Email' },
          { name: 'phone', label: 'Phone', optional: true },
          { name: 'source', label: 'Source', optional: true },
        ],
      },
      {
        kind: 'form',
        title: 'Move an applicant',
        submit: 'Move',
        path: '/recruitment/applicants/move',
        fields: [
          { name: 'applicantId', label: 'Applicant', kind: 'select', options: 'applicantOptions' },
          {
            name: 'to',
            label: 'To',
            kind: 'select',
            options: [
              { value: 'shortlisted', label: 'shortlisted' },
              { value: 'rejected', label: 'rejected' },
              { value: 'withdrawn', label: 'withdrawn' },
            ],
          },
          { name: 'note', label: 'Note', optional: true },
        ],
      },
      {
        kind: 'form',
        title: 'Make an offer',
        note: 'Only to somebody a panel has given feedback on.',
        submit: 'Offer',
        path: '/recruitment/offers',
        roles: [...ADMIN],
        fields: [
          { name: 'applicantId', label: 'Applicant', kind: 'select', options: 'applicantOptions' },
          { name: 'monthly', label: 'Monthly gross', kind: 'money' },
          { name: 'joiningOn', label: 'Joining on', kind: 'date' },
          { name: 'expiresOn', label: 'Offer expires', kind: 'date' },
        ],
      },
      {
        kind: 'form',
        title: 'Record the answer',
        submit: 'Record',
        path: '/recruitment/offers/respond',
        fields: [
          { name: 'offerId', label: 'Offer', kind: 'select', options: 'offerOptions' },
          { name: 'accept', label: 'Accepted', kind: 'checkbox', optional: true },
        ],
      },
      {
        kind: 'form',
        title: 'Hire',
        note: 'Creates the staff record from the accepted offer. Pay is set separately.',
        submit: 'Hire',
        path: '/recruitment/hire',
        roles: [...ADMIN],
        fields: [
          { name: 'offerId', label: 'Offer', kind: 'select', options: 'offerOptions' },
          { name: 'employeeCode', label: 'Employee code' },
          {
            name: 'onboardingTemplateId',
            label: 'Start onboarding',
            kind: 'select',
            options: 'templateOptions',
            optional: true,
          },
        ],
      },
      {
        kind: 'table',
        title: 'Requisitions',
        rows: 'requisitions',
        empty: 'No posts requested.',
        columns: [
          { key: 'designation', label: 'Post' },
          { key: 'department', label: 'Department' },
          { key: 'filled', label: 'Filled' },
          { key: 'reason', label: 'Why' },
          { key: 'status', label: 'Status', alertWhen: 'waiting' },
        ],
      },
      {
        kind: 'form',
        title: 'Decide a requisition',
        note: 'Not by whoever raised it.',
        submit: 'Decide',
        path: '/recruitment/requisitions/decide',
        roles: [...ADMIN],
        fields: [
          { name: 'requisitionId', label: 'Requisition', kind: 'select', options: 'pendingReqOptions' },
          { name: 'approve', label: 'Approve', kind: 'checkbox', optional: true },
          { name: 'note', label: 'Note', optional: true },
        ],
      },
      {
        kind: 'form',
        title: 'Advertise',
        submit: 'Open',
        path: '/recruitment/openings',
        fields: [
          { name: 'requisitionId', label: 'Requisition', kind: 'select', options: 'approvedReqOptions' },
          { name: 'title', label: 'Title' },
          { name: 'description', label: 'Description', kind: 'textarea', optional: true },
          { name: 'closesOn', label: 'Closes on', kind: 'date', optional: true },
        ],
      },
    ],
  },
  {
    path: '/interviews',
    title: 'My interviews',
    menu: 'My interviews',
    roles: ['faculty', 'hod', 'institution_admin', 'super_admin', 'accounts_staff'],
    async load(actor) {
      const rows = await myInterviews(actor as Actor)
      return {
        rows,
        owedOptions: rows
          .filter((r) => r.owed)
          .map((r) => ({ value: r.id, label: `${r.applicant} - ${r.opening}, round ${r.round}` })),
      }
    },
    sections: () => [
      {
        kind: 'table',
        rows: 'rows',
        empty: 'You are not on any interview panel.',
        columns: [
          { key: 'scheduledAt', label: 'When', kind: 'when' },
          { key: 'applicant', label: 'Candidate' },
          { key: 'opening', label: 'For' },
          { key: 'round', label: 'Round' },
          { key: 'owed', label: 'Feedback owed', kind: 'bool', alertWhen: 'owed' },
        ],
      },
      {
        kind: 'form',
        title: 'Give feedback',
        note: 'Once, and it is not edited afterwards.',
        submit: 'Submit',
        path: '/recruitment/interviews/feedback',
        fields: [
          { name: 'interviewId', label: 'Round', kind: 'select', options: 'owedOptions' },
          { name: 'rating', label: 'Rating, 1 to 5', kind: 'number' },
          {
            name: 'recommendation',
            label: 'Recommendation',
            kind: 'select',
            options: [
              { value: 'strong_hire', label: 'strong hire' },
              { value: 'hire', label: 'hire' },
              { value: 'no_hire', label: 'no hire' },
              { value: 'strong_no_hire', label: 'strong no hire' },
            ],
          },
          { name: 'notes', label: 'Notes', kind: 'textarea', rows: 4 },
        ],
      },
    ],
  },
]
