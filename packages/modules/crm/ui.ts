import type { PluginActor, PluginColumn, PluginField, PluginForm, PluginPage, PluginSection, Role } from '@campusos/module-framework'
import { ADMIN } from './api/core'

export const pick = (name: string, label: string, options: string, optional = false): PluginField => ({ name, label, kind: 'select', options, optional })
export const field = (name: string, label: string, kind: PluginField['kind'] = 'text', optional = false): PluginField => ({ name, label, kind, optional })
export const choice = (items: readonly string[]) => items.map(value => ({ value, label: value.replaceAll('_', ' ') }))
export const form = (title: string, path: string, fields: PluginField[], roles: readonly Role[] = ADMIN): PluginForm => ({ kind: 'form', title, path, fields, submit: title, roles: [...roles] })
export const table = (title: string, rows: string, columns: PluginColumn[]): PluginSection => ({ kind: 'table', title, rows, columns, empty: 'Nothing recorded yet.' })
export const hidden = (name: string, value: string): PluginField => ({ name, label: '', kind: 'hidden', value })
export function screen<Data extends Record<string, unknown>>(definition: Omit<PluginPage, 'load' | 'sections'> & { load: (actor: PluginActor, request: Request) => Promise<Data>; sections: (data: Data) => PluginSection[] }): PluginPage {
  return { ...definition, sections: data => definition.sections(data as Data) }
}
export const rupees = (paise: number | null | undefined) => (paise == null ? '—' : new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR' }).format(paise / 100))
