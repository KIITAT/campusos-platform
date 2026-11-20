import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { PluginTable } from '@campusos/module-framework'
import { display } from './screen-kit'
import { sellingPages } from './documents'

/**
 * The invoice list's Total and Outstanding are display text ("₹1,250.50"). A
 * CSV export must carry the amount itself, at the currency's scale, with its
 * sign: a credit note is a number, never text (review P1-09a HIGH).
 */
test('a list row carries each foreign-currency amount as a plain decimal at the currency scale', () => {
  const data = { minorUnits: { INR: 2, KWD: 3, JPY: 0 } }
  const shown = display({ totalFc: 125050, outstandingFc: -125050, currency: 'INR' }, data)
  assert.equal(shown.totalFcPlain, '1250.50')
  assert.equal(shown.outstandingFcPlain, '-1250.50')
  assert.equal(display({ totalFc: 1250500, currency: 'KWD' }, data).totalFcPlain, '1250.500')
  assert.equal(display({ totalFc: 1250, currency: 'JPY' }, data).totalFcPlain, '1250')
})

test('the invoice list exports Total and Outstanding from the plain amounts', () => {
  const page = sellingPages.find((p) => p.path === '/invoices')!
  const table = page.sections({ query: {}, rows: [] }).find((s): s is PluginTable => s.kind === 'table' && s.rows === 'rows')!
  const by = Object.fromEntries(table.columns.map((c) => [c.label, c.exportKey]))
  assert.equal(by.Total, 'totalFcPlain')
  assert.equal(by.Outstanding, 'outstandingFcPlain')
})
