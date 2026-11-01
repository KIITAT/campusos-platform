import type { PluginField, PluginPage, PluginSection, Role } from '@campusos/module-framework'
import { ADMIN, MEMBERS } from './api/core'
import { applicationPage, applicationsPage, offerPage, offersPage, statistics, workspace } from './api/operations'

const staff: Role[] = [...ADMIN, 'faculty', 'hod']
const select = (name: string, label: string, options: string, optional = false): PluginField => ({ name, label, kind: 'select', options, optional })
const field = (name: string, label: string, kind: PluginField['kind'] = 'text'): PluginField => ({ name, label, kind })
const form = (title: string, path: string, fields: PluginField[], roles = staff): PluginSection => ({ kind: 'form', title, path, fields, roles, submit: title })
const choices = (rows: unknown, label: string): { value: string; label: string }[] => Array.isArray(rows)
  ? rows.map((row: Record<string, unknown>) => ({ value: String(row.id), label: String(row[label] ?? row.id) })) : []
const load: PluginPage['load'] = async (actor) => {
  const data = await workspace(actor)
  return {
    ...data, companyOptions: choices(data.companies, 'name'), driveOptions: choices(data.drives, 'title'),
    roundOptions: choices(data.rounds, 'name'),
  }
}
const menu = (path: string, title: string, sections: PluginPage['sections'], roles = MEMBERS, loader: PluginPage['load'] = load): PluginPage => ({ path, title, menu: title, roles, load: loader, sections })
/** The applications and offers lists are paged in SQL; the rest of the workspace loads as before. */
const applicationsLoad: PluginPage['load'] = async (actor, req) => {
  const p = await applicationsPage(actor, applicationPage(req, 'applications'))
  return { ...(await load(actor, req)), applications: p.rows, applicationsPage: { total: p.total, next: p.next }, results: p.results }
}
const offersLoad: PluginPage['load'] = async (actor, req) => {
  const p = await offersPage(actor, offerPage(req, 'offers'))
  return { ...(await load(actor, req)), offers: p.rows, offersPage: { total: p.total, next: p.next } }
}

export const pages: PluginPage[] = [
  menu('/', 'Placement workspace', (data) => [
    { kind: 'note', text: 'Apply only to open drives. Eligibility comes from academic programme declarations and published course completions; selection results are retained with their reasons.' },
    { kind: 'shortcuts', items: [
      { label: 'Recruitment drives', href: '/m/placement/drives', description: 'Deadlines, programmes and selection rounds' },
      { label: 'Applications', href: '/m/placement/applications', description: 'Applications and recorded selection results' },
      { label: 'Offers', href: '/m/placement/offers', description: 'Pending offers and student decisions' },
      ...(data.staff ? [{ label: 'Companies', href: '/m/placement/companies' }, { label: 'Statistics', href: '/m/placement/statistics' }] : []),
    ] },
  ]),
  menu('/companies', 'Companies', () => [
    { kind: 'table', rows: 'companies', columns: [{ key: 'name', label: 'Company' }, { key: 'website', label: 'Website' }], empty: 'No employers added yet.' },
    form('Add company', '/companies', [field('name', 'Company name'), { ...field('website', 'HTTPS website'), optional: true }]),
  ], staff),
  menu('/drives', 'Recruitment drives', (data) => [
    { kind: 'table', rows: 'drives', columns: [{ key: 'title', label: 'Position' }, { key: 'company', label: 'Company' }, { key: 'closesAt', label: 'Deadline', kind: 'when' }, { key: 'minCgpa', label: 'Minimum CGPA' }, { key: 'maxBacklogs', label: 'Maximum backlogs' }, { key: 'status', label: 'Status', kind: 'status' }], empty: 'No visible drives.' },
    ...(data.staff ? [
      form('Draft drive', '/drives', [select('companyId', 'Company', 'companyOptions'), select('programId', 'Programme (blank means any)', 'programs', true), field('title', 'Position'), { ...field('closesAt', 'Deadline (ISO timestamp with timezone)'), hint: 'Example: 2026-12-01T17:00:00+05:30' }, { ...field('minCgpa', 'Minimum CGPA', 'number'), value: '0', step: '0.01' }, { ...field('maxBacklogs', 'Maximum uncleared backlogs', 'number'), value: '0' }]),
      form('Change drive status', '/drives/state', [select('driveId', 'Drive', 'driveOptions'), { name: 'status', label: 'Next state', kind: 'select', options: [{ value: 'open', label: 'Open draft' }, { value: 'closed', label: 'Close permanently' }] }]),
      form('Add selection round', '/rounds', [select('driveId', 'Drive', 'driveOptions'), field('name', 'Round name')]),
    ] : [form('Apply to drive', '/apply', [select('driveId', 'Drive', 'driveOptions')], ['student'])]),
    { kind: 'table', title: 'Selection rounds', rows: 'rounds', columns: [{ key: 'driveId', label: 'Drive', kind: 'code' }, { key: 'position', label: 'Order' }, { key: 'name', label: 'Round' }], fixedOrder: true },
  ]),
  menu('/applications', 'Applications', (data) => [
    { kind: 'table', rows: 'applications', paging: { data: 'applicationsPage', sorts: [] }, columns: [{ key: 'student', label: 'Student' }, { key: 'drive', label: 'Drive' }, { key: 'status', label: 'Status', kind: 'status' }] },
    { kind: 'table', title: 'Selection results', rows: 'results', columns: [{ key: 'applicationId', label: 'Application', kind: 'code' }, { key: 'roundId', label: 'Round', kind: 'code' }, { key: 'outcome', label: 'Decision', kind: 'status' }, { key: 'note', label: 'Reason' }] },
    ...(data.staff ? [form('Record result', '/results', [select('applicationId', 'Application', 'applicationOptions'), select('roundId', 'Round', 'roundOptions'), { name: 'outcome', label: 'Decision', kind: 'select', options: [{ value: 'passed', label: 'Passed' }, { value: 'failed', label: 'Failed' }] }, field('note', 'Panel reason', 'textarea')])] : [form('Withdraw application', '/withdraw', [select('applicationId', 'Application', 'applicationOptions')], ['student'])]),
  ], MEMBERS, applicationsLoad),
  menu('/offers', 'Offers', (data) => [
    { kind: 'note', text: 'Annual compensation is recorded in integer paise. A student can accept one placement offer; issued compensation and selection results cannot be silently rewritten.' },
    { kind: 'table', rows: 'offers', paging: { data: 'offersPage', sorts: [] }, columns: [{ key: 'student', label: 'Student' }, { key: 'drive', label: 'Drive' }, { key: 'annualPaise', label: 'Annual compensation', kind: 'money' }, { key: 'status', label: 'Decision', kind: 'status' }] },
    ...(data.staff ? [form('Issue offer', '/offers', [select('applicationId', 'Application', 'applicationOptions'), field('annualPaise', 'Annual compensation (integer paise)', 'number')])] : [form('Respond to offer', '/offers/respond', [select('offerId', 'Offer', 'offerOptions'), { name: 'decision', label: 'Decision', kind: 'select', options: [{ value: 'accepted', label: 'Accept' }, { value: 'declined', label: 'Decline' }] }], ['student'])]),
  ], MEMBERS, offersLoad),
  { path: '/statistics', title: 'Placement statistics', menu: 'Statistics', roles: staff, load: (actor) => statistics(actor), sections: (data) => [{ kind: 'figures', figures: ['applications', 'offered', 'accepted', 'rejected'].map((key) => ({ label: key, value: String(data[key] ?? 0) })) }] },
  menu('/officers', 'Placement officers', () => [
    { kind: 'table', rows: 'officers', columns: [{ key: 'userId', label: 'Staff member', kind: 'code' }, { key: 'active', label: 'Appointed', kind: 'bool' }] },
    form('Update appointment', '/officers', [select('userId', 'Staff member', 'people'), { name: 'active', label: 'Active placement officer', kind: 'checkbox', value: 'true' }], ADMIN),
  ], ADMIN),
]
