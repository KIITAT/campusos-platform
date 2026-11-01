import type { SQL } from 'drizzle-orm'

export type KeyType = 'text' | 'date' | 'timestamptz' | 'uuid' | 'bigint'
export interface KeyColumn { sql: SQL; type: KeyType }
export type SortSpec = Record<string, { dir: 'asc' | 'desc'; keys: KeyColumn[] }>
export interface PageRequest { q: string | null; sort: string; dir: 'asc' | 'desc'; limit: number; after: string[] | null }
export interface Page<T> { rows: T[]; total: number; next: string | null }
export interface PageInfo { total: number; next: string | null }
export const MAX_PAGE = 500

const nope = (): never => { throw new Error('not implemented') }
export const readPage = (_req: Request, _prefix: string, _sorts: SortSpec, _defaultSort: string, _pageSize = 20): PageRequest => nope()
export const keyset = (_keys: KeyColumn[], _page: PageRequest): SQL | undefined => nope()
export const orderKeys = (_keys: KeyColumn[], _dir: 'asc' | 'desc'): SQL[] => nope()
export const cursorColumn = (_keys: KeyColumn[]): SQL<string[]> => nope()
export const finishPage = <T extends { _cursor: string[] }>(_rows: T[], _page: PageRequest, _total: number): Page<Omit<T, '_cursor'>> => nope()
export const searchAny = (_q: string | null, _columns: SQL[]): SQL | undefined => nope()
