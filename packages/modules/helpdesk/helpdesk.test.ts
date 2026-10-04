import { test } from 'node:test'
import assert from 'node:assert/strict'
import { eq } from 'drizzle-orm'
import { auditLog, authDb, users, withTenant } from '@campusos/db'
import { college } from './test-support.test'
import { assignCase, caseDetail, createCase, listCases, postMessage, reopenCase, resolveCase } from './api'
import { cases, messages } from './schema'

test('helpdesk RLS protects case references and audit never copies confidential text', async () => {
  const actors = await college()
  const other = await college()
  const secret = 'Confidential detail not for the general audit trail'
  const issue = await createCase(actors.student, { subject: 'Private concern', description: secret, kind: 'grievance' })
  assert.deepEqual(await withTenant(other.id, transaction => transaction.select().from(cases)), [])
  await assert.rejects(() => withTenant(other.id, transaction => transaction.insert(messages).values({ institutionId: other.id, caseId: issue.id, authorId: other.student.id, body: 'Foreign case link' })))
  await assert.rejects(() => withTenant(other.id, transaction => transaction.insert(messages).values({ institutionId: actors.id, caseId: issue.id, authorId: other.student.id, body: 'Foreign tenant write' })))
  await postMessage(actors.student, { caseId: issue.id, body: secret })
  const trail = await withTenant(actors.id, transaction => transaction.select().from(auditLog).where(eq(auditLog.moduleId, 'helpdesk')))
  assert.deepEqual(trail.map(row => row.action).sort(), ['case.created', 'case.message'])
  assert.ok(!JSON.stringify(trail).includes(secret))
})

test('a demoted or erased assignee loses confidential officer access immediately', async () => {
  const actors = await college()
  const issue = await createCase(actors.student, { subject: 'Private grievance', description: 'Confidential details for an authorized officer.', kind: 'grievance' })
  const ownIssue = await createCase(actors.faculty, { subject: 'Own grievance', description: 'A former staff member retains only reporter access.', kind: 'grievance' })
  await assignCase(actors.admin, { caseId: issue.id, assigneeId: actors.faculty.id })
  await assignCase(actors.admin, { caseId: ownIssue.id, assigneeId: actors.faculty.id })
  await authDb.update(users).set({ role: 'student' }).where(eq(users.id, actors.faculty.id))
  const demoted = { ...actors.faculty, role: 'student' as const }
  assert.deepEqual((await listCases(demoted)).map(row => row.id), [ownIssue.id])
  await assert.rejects(() => caseDetail(demoted, issue.id))
  await assert.rejects(() => postMessage(demoted, { caseId: issue.id, body: 'Must not write' }))
  await assert.rejects(() => resolveCase(demoted, { caseId: issue.id, resolution: 'Must not resolve' }))
  assert.equal((await caseDetail(demoted, ownIssue.id)).case.id, ownIssue.id)
  await assert.rejects(() => resolveCase(demoted, { caseId: ownIssue.id, resolution: 'Reporters cannot resolve' }))
  await authDb.update(users).set({ role: 'faculty', erasedAt: new Date() }).where(eq(users.id, actors.faculty.id))
  await assert.rejects(() => assignCase(actors.admin, { caseId: issue.id, assigneeId: actors.faculty.id }))
})

test('a confidential grievance is visible only to reporter, assigned officer and administrators', async () => {
  const actors = await college()
  const other = await college()
  const issue = await createCase(actors.student, { subject: 'Private concern', description: 'A confidential matter for the assigned officer.', kind: 'grievance' })
  assert.equal(issue.confidential, true)
  assert.deepEqual(await listCases(actors.faculty), [])
  await assert.rejects(() => caseDetail(actors.other, issue.id))
  await assert.rejects(() => caseDetail(other.admin, issue.id))
  await assert.rejects(() => assignCase(actors.student, { caseId: issue.id, assigneeId: actors.faculty.id }))
  await assert.rejects(() => assignCase(actors.admin, { caseId: issue.id, assigneeId: other.faculty.id }))
  await assignCase(actors.admin, { caseId: issue.id, assigneeId: actors.faculty.id })
  await postMessage(actors.faculty, { caseId: issue.id, body: 'Please meet at the office.' })
  assert.equal((await caseDetail(actors.student, issue.id)).messages.length, 1)
  assert.equal((await listCases(actors.faculty)).length, 1)
})

test('resolution is serialized and the reporter can reopen with a recorded reason', async () => {
  const actors = await college()
  const issue = await createCase(actors.student, { subject: 'Broken desk', description: 'The desk in room 101 is broken.', kind: 'helpdesk' })
  await assignCase(actors.admin, { caseId: issue.id, assigneeId: actors.faculty.id })
  const results = await Promise.allSettled([1, 2].map(() => resolveCase(actors.faculty, { caseId: issue.id, resolution: 'Desk replaced' })))
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1)
  await assert.rejects(() => resolveCase(actors.student, { caseId: issue.id, resolution: 'Not authorized' }))
  await reopenCase(actors.student, { caseId: issue.id, reason: 'Replacement still broken' })
  assert.equal((await caseDetail(actors.student, issue.id)).case.status, 'open')
  await assert.rejects(() => reopenCase(actors.student, { caseId: issue.id, reason: 'Already reopened' }))
})
