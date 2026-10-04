import * as z from 'zod'
import type { PluginActor, PluginColumn, PluginField, PluginForm, PluginPage, PluginSection, PluginTable } from '@campusos/module-framework'
import { FinanceError, getSettings, listAccounts, listCostCenters, listFunds, listParties } from '../api'
import { ADMIN, OFFICE, as } from './kit'

export const ROOT = '/m/finance'
export const reportLinks = [
  { label: 'Trial balance', href: `${ROOT}/reports/trial-balance`, description: 'Opening balances and period movements' },
  { label: 'Income and expenditure', href: `${ROOT}/reports/income-expenditure`, description: 'The period result, with prior-year comparison' },
  { label: 'Balance sheet', href: `${ROOT}/reports/balance-sheet`, description: 'Assets, liabilities and funds on a date' },
  { label: 'Receipts, payments and cash flow', href: `${ROOT}/reports/cash`, description: 'Cash movements by head or activity' },
  { label: 'General ledger', href: `${ROOT}/reports/general-ledger`, description: 'Each posting and its running balance' },
  { label: 'Day book', href: `${ROOT}/reports/day-book`, description: 'Journal entries and their lines' },
]
export const money = (key: string, label: string): PluginColumn => ({ key, label, kind: 'money' })
export const pick = (name: string, label: string, options: PluginField['options'], value?: string, optional = true): PluginField => ({ name, label, kind: 'select', options, value, optional })
export const values = (items: readonly string[]) => items.map(value => ({ value, label: value.replaceAll('_', ' ') }))
export const reportTable = (title: string, rows: string, columns: PluginColumn[], extra: Partial<PluginTable> = {}): PluginTable => ({ kind: 'table', title, rows, columns, fixedOrder: true, pageSize: 100, empty: 'No postings for these filters.', ...extra })
export const action = (title: string, path: string, fields: PluginField[]): PluginForm => ({ kind: 'form', title, submit: title, path, fields, roles: ADMIN })

export function screen<Data extends Record<string, unknown>>(definition: Omit<PluginPage, 'load' | 'sections'> & {
  load: (actor: PluginActor, request: Request) => Promise<Data>
  sections: (data: Data) => PluginSection[]
}): PluginPage {
  return { ...definition, sections: data => definition.sections(data as Data) }
}

export async function reportContext(actor: PluginActor, request: Request) {
  const query = Object.fromEntries(new URL(request.url).searchParams)
  const [settings, accounts, funds, costCenters] = await Promise.all([getSettings(as(actor)), listAccounts(as(actor)), listFunds(as(actor)), listCostCenters(as(actor))])
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: settings.timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date())
  const date = Object.fromEntries(parts.map(part => [part.type, part.value]))
  const today = `${date.year}-${date.month}-${date.day}`
  const from = z.iso.date().parse(query.from || `${today.slice(0, 8)}01`)
  const to = z.iso.date().parse(query.to || today)
  const on = z.iso.date().parse(query.on || today)
  if (from > to) throw new FinanceError(400, 'date_order', 'The start date must not be after the end date.')
  return { query, from, to, on, settings, admin: ADMIN.includes(actor.role),
    accountOptions: accounts.map(account => ({ value: account.id, label: `${account.code} · ${account.name}${account.isGroup ? ' (group)' : ''}` })),
    fundOptions: funds.map(fund => ({ value: fund.id, label: `${fund.code} · ${fund.name}` })),
    costCenterOptions: costCenters.map(center => ({ value: center.code, label: `${center.code} · ${center.name}` })),
  }
}

export async function partyChoices(actor: PluginActor) {
  return (await listParties(as(actor), {})).map(party => ({ value: party.id, label: `${party.code} · ${party.name}` }))
}

type Period = { from: string; to: string; on: string; query: Record<string, string> }
export const filters = (path: string, data: Period, extra: PluginField[] = [], point = false): PluginForm => ({
  kind: 'form', title: 'Report filters', submit: 'Update report', path, method: 'GET', roles: OFFICE,
  fields: [...(point ? [{ name: 'on', label: 'As of', kind: 'date' as const, value: data.on }] : [{ name: 'from', label: 'From', kind: 'date' as const, value: data.from }, { name: 'to', label: 'To', kind: 'date' as const, value: data.to }]), ...extra],
})
export const fundFilter = (data: Period) => pick('fundId', 'Fund', 'fundOptions', data.query.fundId)
export const costFilter = (data: Period) => pick('costCenter', 'Cost centre', 'costCenterOptions', data.query.costCenter)
export const csv = (report: string, query: Record<string, string>): PluginSection => ({ kind: 'links', links: [{ label: 'Download CSV', href: `/api/v1/modules/finance/reports/export.csv?${new URLSearchParams({ ...query, report })}` }] })
export const treeColumns: PluginColumn[] = [{ key: 'code', label: 'Code', kind: 'code', indent: 'depth' }, { key: 'name', label: 'Account' }]
export const withLedger = <Row extends { isGroup: boolean }>(rows: Row[]) => rows.map(row => ({ ...row, ledgerLabel: row.isGroup ? '' : 'View ledger' }))
export const ledgerColumn = (data: Period): PluginColumn => ({ key: 'ledgerLabel', label: 'Ledger', href: `${ROOT}/reports/general-ledger?accountId={id}&from=${data.from}&to=${data.to}${data.query.costCenter ? `&costCenter=${encodeURIComponent(data.query.costCenter)}` : ''}` })
