import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { like } from 'drizzle-orm'
import { authDb, institutions, users } from '@campusos/db'
import { printedText } from '@campusos/module-framework/pdf'
import { createParty, invoicePdf, loadIndiaPreset, saveInvoice, updateSettings, type Actor } from './api'

let n = 0
const SLUG = 'fin-pdf-'

after(async () => {
  await authDb.delete(institutions).where(like(institutions.slug, `${SLUG}%`))
})

test('an invoice prints a Tamil party and a Bengali institution (UX-01)', async () => {
  const tag = `${SLUG}${++n}`
  const [i] = await authDb
    .insert(institutions)
    .values({ slug: tag, name: 'Pdf College', allowedEmailDomains: [`${tag}.test`] })
    .returning({ id: institutions.id })
  const id = i!.id
  const people = await authDb
    .insert(users)
    .values([
      { email: `adm@${tag}.test`, institutionId: id, role: 'institution_admin', name: 'Adm' },
      { email: `acc@${tag}.test`, institutionId: id, role: 'accounts_staff', name: 'Acc' },
    ])
    .returning({ id: users.id })
  const admin: Actor = { id: people[0]!.id, email: `adm@${tag}.test`, role: 'institution_admin', institutionId: id }
  const staff: Actor = { id: people[1]!.id, email: `acc@${tag}.test`, role: 'accounts_staff', institutionId: id }

  await updateSettings(admin, { stateCode: '21', legalName: 'অভিষেক চট্টোপাধ্যায়' })
  await loadIndiaPreset(admin)
  const party = await createParty(staff, { code: 'C1', name: 'அபிஷேக் கிருஷ்ணன்', isCustomer: true, stateCode: '21' })
  const inv = (await saveInvoice(staff, {
    kind: 'sales',
    partyId: party.id,
    postingDate: '2026-10-01',
    lines: [{ description: 'Consulting', qty: '1', rate: '1000' }],
    submit: true,
  })) as { id: string }

  const printed = await printedText((await invoicePdf(admin, inv.id)).bytes)
  assert.ok(printed.includes('அபிஷேக் கிருஷ்ணன்'), printed.join('|'))
  assert.ok(printed.includes('অভিষেক চট্টোপাধ্যায়'), printed.join('|'))
})
