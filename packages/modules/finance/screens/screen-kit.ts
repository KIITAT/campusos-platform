import type { CellKind, PluginActor, PluginColumn, PluginField, PluginForm, PluginPage, PluginSection, PluginTable, Role } from '@campusos/module-framework'
import { FinanceError, formatDecimal, formatQty, requireStaff } from '../api'
import { specs } from '../routes'
import { ADMIN, OFFICE, as, choices, fc, monthStart, q, today } from './kit'

export type Data = Record<string, unknown>
export const object = (value: unknown): Data => value && typeof value === 'object' && !Array.isArray(value) ? value as Data : {}
export const rows = (value: unknown): Data[] => Array.isArray(value) ? value.map(object) : []
export const str = (value: unknown) => value === null || value === undefined ? '' : value instanceof Date ? value.toISOString() : Array.isArray(value) ? value.join(', ') : String(value)
export const label = (name: string) => name.replace(/([a-z])([A-Z])/g, '$1 $2').replaceAll('_', ' ').replace(/\b\w/g, letter => letter.toUpperCase())
export const options = (values: readonly string[]) => values.map(value => ({ value, label: label(value) }))
export const href = (path: string, query: Data = {}) => `/m/finance${path}?${new URLSearchParams(Object.entries(query).filter(([, value]) => value !== undefined && value !== null && value !== '').map(([key, value]) => [key, str(value)]))}`

export async function read(actor: PluginActor, path: string, query: Data = {}): Promise<unknown> {
  const route = specs.find(candidate => candidate.method === 'GET' && candidate.path === path)
  if (!route) throw new Error(`Missing finance read route: ${path}`)
  return route.handler(actor, new Request(`https://finance.internal${href(path, query)}`))
}

export async function context(actor: PluginActor, request: Request, scope: 'office' | 'request' | 'stock' = 'office'): Promise<Data> {
  requireStaff(as(actor))
  const query = q(request)
  const all = await choices(actor)
  const office = OFFICE.includes(actor.role)
  const selected = scope === 'request' && !office
    ? { items: all.items, stockItems: all.stockItems, warehouses: all.warehouses, costCenters: all.costCenters }
    : scope === 'stock' && !office
      ? { stockItems: all.stockItems, items: all.stockItems, warehouses: all.warehouses, costCenters: all.costCenters, accounts: all.expenseAccounts, funds: all.funds, baseCurrency: all.baseCurrency }
      : all
  const currencyRows = office ? rows(object(await read(actor, '/currencies')).currencies) : []
  return { ...selected, query, office, admin: ADMIN.includes(actor.role), actorId: actor.id,
    from: query.from || monthStart(), to: query.to || today(), on: query.on || today(),
    minorUnits: Object.fromEntries(currencyRows.map(currency => [str(currency.code), Number(currency.minorUnits)])),
  }
}

export function page(spec: PluginPage): PluginPage {
  return { ...spec, async load(actor, request) {
    if (!spec.roles.includes(actor.role)) throw new FinanceError(403, 'forbidden', 'This screen is not available to your role.')
    return spec.load(actor, request)
  } }
}

export const field = (name: string, kind: PluginField['kind'] = 'text', extra: Partial<PluginField> = {}): PluginField => ({ name, label: label(name.replace(/Id$/, '')), kind, optional: true, ...extra })
export const select = (name: string, choices: string | readonly string[], extra: Partial<PluginField> = {}): PluginField => field(name, 'select', { options: typeof choices === 'string' ? choices : options(choices), ...extra })
export const hidden = (name: string, value: unknown): PluginField => field(name, 'hidden', { value: str(value) })
export const textFields = (...names: string[]) => names.map(name => field(name))
export const dateFields = (...names: string[]) => names.map(name => field(name, 'date'))
export const moneyFields = (...names: string[]) => names.map(name => field(name, 'money'))
export const checks = (...names: string[]) => names.map(name => field(name, 'checkbox'))
export const dimensions = () => [select('costCenter', 'costCenters'), select('fundId', 'funds')]
export const grid = (name: string, columns: PluginField[], value = 'editLines', lineCount = 8): PluginField => field(name, 'lines', { columns, value, lineCount, optional: false })

export function form(title: string, path: string, fields: PluginField[], values: Data = {}, roles: Role[] = OFFICE): PluginForm {
  return { kind: 'form', title, submit: title, path, roles, fields: fields.map(input => ({ ...input, ...(input.kind !== 'lines' && values[input.name] !== undefined ? { value: str(values[input.name]) } : {}) })) }
}

export const filter = (path: string, data: Data, fields: PluginField[]): PluginForm => ({ ...form('Apply filters', path, fields, { ...data, ...object(data.query) }), method: 'GET', roles: undefined, placement: 'inline' })
export const col = (key: string, kind?: CellKind, extra: Partial<PluginColumn> = {}): PluginColumn => ({ key, label: label(key.replace(/Paise$/, '')), kind, ...extra })
export const table = (title: string, key: string, columns: PluginColumn[], extra: Partial<PluginTable> = {}): PluginTable => ({ kind: 'table', title, rows: key, columns, empty: `No ${title.toLowerCase()} to show.`, ...extra })
export const moneyCols = (...keys: string[]) => keys.map(key => col(key, 'money'))
export const linkCol = (key: string, path: string, idKey = 'id') => col(key, undefined, { href: `/m/finance${path}?id={${idKey}}` })
export const shortcuts = (title: string, items: { label: string; href: string }[]): PluginSection => ({ kind: 'shortcuts', title, items })
export const tabs = (path: string, query: Data, key: string, values: string[]): PluginSection => ({ kind: 'links', links: values.map(value => ({ label: value ? label(value) : 'All', href: href(path, { ...query, [key]: value }), active: str(query[key]) === value })) })
export const currencyMinor = (data: Data, currency: unknown) => Number(object(data.minorUnits)[str(currency)] ?? 2)

export function display(source: Data, data: Data = {}, currency?: string): Data {
  const result: Data = { ...source }
  const code = currency || str(source.currency) || str(data.baseCurrency) || 'INR'
  for (const [key, value] of Object.entries(source)) {
    if (key.endsWith('Fc') && typeof value === 'number') result[`${key}Text`] = fc(value, code, currencyMinor(data, code))
    if (key.endsWith('Milli') && value !== null) result[`${key}Text`] = formatQty(Number(value))
    if (key.endsWith('Bp') && value !== null) result[`${key}Text`] = formatDecimal(Number(value), 2)
    if (value instanceof Date) result[key] = value.toISOString()
  }
  if ('number' in result && !result.number) result.number = 'Draft'
  if (Array.isArray(result.serials)) result.serials = result.serials.join(', ')
  return result
}

export function draftValues(source: Data, data: Data = {}, currency?: string): Data {
  const minor = currencyMinor(data, currency || source.currency || data.baseCurrency)
  const result = Object.fromEntries(Object.entries(source).map(([key, value]) => [key, str(value)]))
  const amounts: Record<string, string> = { rate: 'rateFc', amount: 'amountFc', tds: 'tdsPaise', bankCharges: 'bankChargesPaise', debit: 'debitPaise', credit: 'creditPaise', gross: 'grossPaise', openingAccumulated: 'openingAccumulatedPaise', creditLimit: 'creditLimitPaise', standardRate: 'standardRatePaise' }
  for (const [target, sourceKey] of Object.entries(amounts)) if (source[sourceKey] !== undefined && source[sourceKey] !== null) result[target] = formatDecimal(Number(source[sourceKey]), sourceKey.endsWith('Fc') ? minor : 2)
  for (const [target, sourceKey] of Object.entries({ qty: 'qtyMilli', rejected: 'rejectedMilli', reorderLevel: 'reorderLevelMilli', reorderQty: 'reorderQtyMilli' })) if (source[sourceKey] !== undefined) result[target] = formatQty(Number(source[sourceKey]))
  if (source.discountBp !== undefined) result.discount = formatDecimal(Number(source.discountBp), 2)
  return result
}

export const approval = (docType: string, docId: unknown) => form('Record approval', '/approvals/decide', [hidden('docType', docType), hidden('docId', docId), select('decision', ['approved', 'refused'], { kind: 'radio', optional: false }), field('note', 'textarea')], {}, ['institution_admin', 'super_admin', 'accounts_staff', 'hod', 'faculty', 'library_staff', 'hostel_staff'])
export const postingTable = () => table('Ledger posting', 'posting', [col('code'), col('name'), ...moneyCols('debitPaise', 'creditPaise'), col('costCenter'), col('memo')], { fixedOrder: true })
export const approvalTable = () => table('Approval history', 'approvals', [col('decision', 'status'), col('approver'), col('note'), col('createdAt', 'when')])
export const chooseRecord: PluginSection = { kind: 'note', text: 'Choose a record from the list to open its details.' }
