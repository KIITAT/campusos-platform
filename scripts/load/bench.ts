import { resolve } from 'node:path'
import { authDb, corePool } from '../../packages/db/src/index'
import { balanceSheet, postEntry, trialBalanceReport, type Actor } from '../../packages/modules/finance/api/index'
import { validateLoadEnvironment } from './seed'

/** Times the two ledger reports on load-00 (P1-10a, decision 382): same code path as the route, no HTTP. */
const RUNS = 5

async function time(report: string, call: () => Promise<unknown>) {
  try {
    await call() // one unmeasured warm-up
    const ms: number[] = []
    for (let i = 0; i < RUNS; i++) {
      const start = performance.now()
      await call()
      ms.push(performance.now() - start)
    }
    ms.sort((a, b) => a - b)
    return { report, runs: RUNS, medianMs: Math.round(ms[Math.floor(RUNS / 2)]!), maxMs: Math.round(ms[RUNS - 1]!) }
  } catch (error) {
    return { report, error: (error as { code?: string }).code ?? (error as Error).name }
  }
}

/** Times 200 sequential postings after one warm-up (P1-10b, B11): the write cost of the daily-balance trigger. */
async function timePost(admin: Actor) {
  const run = Date.now()
  const call = (i: number) =>
    postEntry(admin, {
      memo: 'Bench post',
      sourceModule: 'manual',
      sourceRef: `bench:${run}:${i}`,
      postingDate: '2026-03-31',
      lines: [
        { purpose: 'bank', debitPaise: 100 },
        { purpose: 'purchase_expense', creditPaise: 100 },
      ],
    })
  try {
    await call(-1)
    const ms: number[] = []
    for (let i = 0; i < 200; i++) {
      const start = performance.now()
      await call(i)
      ms.push(performance.now() - start)
    }
    ms.sort((a, b) => a - b)
    return { report: 'post', runs: 200, medianMs: Math.round(ms[100]!), maxMs: Math.round(ms[199]!) }
  } catch (error) {
    return { report: 'post', error: (error as { code?: string }).code ?? (error as Error).name }
  }
}

async function main() {
  try {
    validateLoadEnvironment(process.env)
    const { rows } = await authDb.$client.query("select id, institution_id, email from users where email = 'acc0@load-00.invalid'")
    if (!rows.length) throw new Error('load-00 is not seeded')
    const actor: Actor = { id: rows[0].id, email: rows[0].email, institutionId: rows[0].institution_id, role: 'accounts_staff' }
    const adm = await authDb.$client.query("select id, institution_id, email from users where email = 'adm@load-00.invalid'")
    if (!adm.rows.length) throw new Error('load-00 is not seeded')
    const admin: Actor = { id: adm.rows[0].id, email: adm.rows[0].email, institutionId: adm.rows[0].institution_id, role: 'institution_admin' }
    const lines = [
      await time('trial-balance', () => trialBalanceReport(actor, { from: '2025-04-01', to: '2026-03-31' })),
      await time('balance-sheet', () => balanceSheet(actor, { on: '2026-03-31' })),
      await timePost(admin),
    ]
    for (const line of lines) process.stdout.write(`${JSON.stringify(line)}\n`)
  } catch (error) {
    process.stderr.write(`${(error as Error).message}\n`)
    process.exitCode = 1
  } finally {
    await Promise.all([corePool.end(), authDb.$client.end()])
  }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve('scripts/load/bench.ts')) void main()
