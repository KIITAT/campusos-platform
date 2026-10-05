import { eq } from 'drizzle-orm'
import { withTenant } from '@campusos/db'
import type { ImportSpec, PluginActor } from '@campusos/module-framework'
import { accounts, itemGroups, items, parties } from './schema'
import { createAccount, createItem, createParty, saveJournal } from './api'

/**
 * The books' master data, from the spreadsheets an accounts office moves in
 * with: the chart, the people it trades with, what it buys and sells, and the
 * balances it opens with. Rows go through the same operations as the forms,
 * so a chart cannot be imported out of shape and a file with one bad line
 * posts nothing.
 */

const ADMIN = ['institution_admin', 'super_admin'] as const
const OFFICE = ['institution_admin', 'super_admin', 'accounts_staff'] as const
const tenantOf = (actor: PluginActor) => actor.institutionId!
const blank = (v: string | undefined) => (v ? v : undefined)
const yes = (v: string | undefined) => ['yes', 'y', 'true', '1'].includes((v ?? '').trim().toLowerCase())

const accountByCode = async (actor: PluginActor, code: string) => {
  const [row] = await withTenant(tenantOf(actor), (tx) => tx.select({ id: accounts.id, isGroup: accounts.isGroup }).from(accounts).where(eq(accounts.code, code.trim())))
  return row
}
const partyByCode = async (actor: PluginActor, code: string) => {
  const [row] = await withTenant(tenantOf(actor), (tx) => tx.select({ id: parties.id }).from(parties).where(eq(parties.code, code.trim())))
  return row
}

interface OpeningLine {
  accountId: string
  partyId?: string
  debit?: string
  credit?: string
  memo?: string
}

export const imports: ImportSpec[] = [
  {
    id: 'accounts',
    title: 'Chart of accounts',
    note: 'One row per account or group. A group must come before the accounts under it. Codes already in the chart are left as they are.',
    roles: [...ADMIN],
    columns: [
      { name: 'code', required: true, note: 'The account code', example: '1210' },
      { name: 'name', required: true, note: 'The account name', example: 'Canara Bank current account' },
      { name: 'type', required: true, note: 'asset, liability, equity, income or expense', example: 'asset' },
      { name: 'parent_code', note: 'The group it sits under', example: '1200' },
      { name: 'group', note: 'yes for a group, which holds accounts and takes no postings', example: 'no' },
      { name: 'purpose', note: 'What posting modules look for: bank, cash, fee_income…; usually blank', example: 'bank' },
      { name: 'currency', note: 'Three letters, for an account kept in a foreign currency', example: '' },
      { name: 'description', note: 'Optional', example: '' },
    ],
    row: async (actor, { values: v }) => {
      if (await accountByCode(actor, v.code!)) return 'skipped'
      await createAccount(actor, {
        code: v.code, name: v.name, type: v.type!.toLowerCase(), parentCode: blank(v.parent_code), isGroup: yes(v.group),
        purpose: blank(v.purpose?.toLowerCase()), currency: blank(v.currency?.toUpperCase()), description: blank(v.description),
      })
      return 'created'
    },
  },
  {
    id: 'parties',
    title: 'Customers and suppliers',
    note: 'One row per party. Say yes under customer, supplier or both.',
    roles: [...OFFICE],
    columns: [
      { name: 'code', required: true, note: 'Unique here', example: 'SUP-0007' },
      { name: 'name', required: true, note: 'Legal or trading name', example: 'Sharma Stationers' },
      { name: 'customer', note: 'yes if we bill them', example: 'no' },
      { name: 'supplier', note: 'yes if we pay them', example: 'yes' },
      { name: 'gstin', note: 'Optional', example: '29ABCDE1234F1Z5' },
      { name: 'pan', note: 'Optional', example: 'ABCDE1234F' },
      { name: 'state_code', note: 'Two digits, for GST place of supply', example: '29' },
      { name: 'email', note: 'Optional', example: 'accounts@sharma.example' },
      { name: 'phone', note: 'Optional', example: '080 2345 6789' },
      { name: 'address', note: 'Optional', example: '12 MG Road, Bengaluru' },
      { name: 'payment_terms_days', note: 'Days to pay; blank is 0', example: '30' },
    ],
    row: async (actor, { values: v }) => {
      if (await partyByCode(actor, v.code!)) return 'skipped'
      await createParty(actor, {
        code: v.code, name: v.name, isCustomer: yes(v.customer), isSupplier: yes(v.supplier), gstin: blank(v.gstin), pan: blank(v.pan),
        stateCode: blank(v.state_code), email: blank(v.email), phone: blank(v.phone), address: blank(v.address), paymentTermsDays: blank(v.payment_terms_days),
      })
      return 'created'
    },
  },
  {
    id: 'items',
    title: 'Items',
    note: 'What is bought, sold and kept in the stores: one row per item.',
    roles: [...OFFICE],
    columns: [
      { name: 'code', required: true, note: 'Unique here', example: 'PAPER-A4' },
      { name: 'name', required: true, note: 'What it is called', example: 'A4 paper, 500 sheets' },
      { name: 'nature', note: 'stock, service or asset; blank is stock', example: 'stock' },
      { name: 'uom', note: 'Unit of measure; blank is Nos', example: 'Ream' },
      { name: 'group', note: 'An item group, by name', example: 'Stationery' },
      { name: 'hsn_sac', note: 'Optional', example: '4802' },
      { name: 'standard_rate', note: 'Usual price in rupees', example: '320' },
      { name: 'reorder_level', note: 'Optional', example: '20' },
      { name: 'reorder_qty', note: 'Optional', example: '100' },
      { name: 'batches', note: 'yes if tracked by batch', example: 'no' },
      { name: 'serials', note: 'yes if tracked by serial number', example: 'no' },
      { name: 'description', note: 'Optional', example: '' },
    ],
    row: async (actor, { values: v }) => {
      const [existing] = await withTenant(tenantOf(actor), (tx) => tx.select({ id: items.id }).from(items).where(eq(items.code, v.code!.trim())))
      if (existing) return 'skipped'
      let groupId: string | undefined
      if (v.group) {
        const [group] = await withTenant(tenantOf(actor), (tx) => tx.select({ id: itemGroups.id }).from(itemGroups).where(eq(itemGroups.name, v.group!)))
        if (!group) throw new Error(`no item group ${v.group}`)
        groupId = group.id
      }
      await createItem(actor, {
        code: v.code, name: v.name, nature: blank(v.nature?.toLowerCase()), uom: blank(v.uom), groupId, hsnSac: blank(v.hsn_sac),
        standardRate: blank(v.standard_rate), reorderLevel: blank(v.reorder_level), reorderQty: blank(v.reorder_qty),
        hasBatch: yes(v.batches), hasSerial: yes(v.serials), description: blank(v.description),
      })
      return 'created'
    },
  },
  {
    id: 'opening-balances',
    title: 'Opening balances',
    note: 'The balances the books start from, as one opening voucher. Whatever does not balance yet is carried to the opening balance account, which is empty once every balance is in, so balances may come in several files. Give a party for a customer’s or supplier’s balance. At most 200 lines.',
    roles: [...OFFICE],
    maxRows: 200,
    columns: [
      { name: 'posting_date', required: true, note: 'YYYY-MM-DD, the same on every row: usually the day before the books start', example: '2026-03-31' },
      { name: 'account_code', required: true, note: 'An account, not a group', example: '1210' },
      { name: 'party', note: 'A customer’s or supplier’s code, for their balance', example: '' },
      { name: 'debit', note: 'In rupees; blank or 0 when this is a credit', example: '250000' },
      { name: 'credit', note: 'In rupees; blank or 0 when this is a debit', example: '' },
      { name: 'memo', note: 'Optional', example: 'Balance as per bank certificate' },
    ],
    row: async (actor, { values: v }, memo) => {
      const date = (memo.get('date') as string | undefined) ?? v.posting_date!
      if (v.posting_date !== date) throw new Error(`every row must have the same posting date; the first has ${date}`)
      memo.set('date', date)
      const account = await accountByCode(actor, v.account_code!)
      if (!account) throw new Error(`no account ${v.account_code}`)
      if (account.isGroup) throw new Error(`${v.account_code} is a group, which takes no postings`)
      let partyId: string | undefined
      if (v.party) {
        const party = await partyByCode(actor, v.party)
        if (!party) throw new Error(`no party ${v.party}`)
        partyId = party.id
      }
      const debit = blank(v.debit === '0' ? '' : v.debit)
      const credit = blank(v.credit === '0' ? '' : v.credit)
      if (!debit === !credit) throw new Error('give either a debit or a credit')
      const lines = (memo.get('lines') as OpeningLine[] | undefined) ?? []
      lines.push({ accountId: account.id, partyId, debit, credit, memo: blank(v.memo) })
      memo.set('lines', lines)
      return 'created'
    },
    finish: async (actor, memo) => {
      await saveJournal(actor, {
        kind: 'opening', postingDate: memo.get('date'), memo: 'Opening balances, imported from CSV', reference: 'CSV-IMPORT',
        lines: memo.get('lines'), submit: true,
      })
    },
  },
]
