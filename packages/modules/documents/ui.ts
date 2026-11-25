import type { PluginColumn, PluginField, PluginForm, PluginPage, PluginSection, Role } from '@campusos/module-framework'
import { ADMIN } from './api/core'

export const field = (name: string, label: string, kind: PluginField['kind'] = 'text', optional = false, hint?: string): PluginField => ({ name, label, kind, optional, hint })
export const hidden = (name: string, value: string): PluginField => ({ name, label: '', kind: 'hidden', value })
export const choice = (items: readonly string[]) => items.map(value => ({ value, label: value.replaceAll('_', ' ') }))
export const form = (title: string, path: string, fields: PluginField[], roles: readonly Role[] = ADMIN): PluginForm => ({ kind: 'form', title, path, fields, submit: title, roles: [...roles], placement: 'inline' })
export const table = (title: string, rows: string, columns: PluginColumn[], paging?: { data: string; sorts: string[] }): PluginSection => ({ kind: 'table', title, rows, columns, empty: 'No documents yet.', ...(paging ? { paging } : {}) })
export function screen<Data extends Record<string, unknown>>(definition: Omit<PluginPage, 'load' | 'sections'> & { load: (actor: Parameters<PluginPage['load']>[0], request: Request) => Promise<Data>; sections: (data: Data) => PluginSection[] }): PluginPage {
  return { ...definition, sections: data => definition.sections(data as Data) }
}
