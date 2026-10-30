import { test } from 'node:test'
import assert from 'node:assert/strict'
import { performance } from 'node:perf_hooks'
import { solve, type SolverInput } from './api/solver'
import { solveInThread, SolveFailed } from './api/solve-thread'

/**
 * The solver off the request thread (REL-01): a long solve leaves the event
 * loop free, and a solve past its time or memory limit, or cancelled, is
 * stopped and says why. No database.
 */

/** The smallest real input: one section, two teachers, one room, a short week. */
function tiny(): SolverInput {
  const periods = []
  for (const day of [1, 2, 3]) {
    for (let index = 1; index <= 4; index++) {
      const m = 9 * 60 + (index - 1) * 50
      const hhmm = (x: number) => `${String(Math.floor(x / 60)).padStart(2, '0')}:${String(x % 60).padStart(2, '0')}`
      periods.push({ day, index, startsAt: hhmm(m), endsAt: hhmm(m + 50) })
    }
  }
  return {
    periods,
    rooms: [{ id: 'R1', capacity: 60, kind: 'classroom' }],
    teachers: [
      { id: 'rao', maxPerDay: 5, maxPerWeek: 24, maxConsecutive: 3 },
      { id: 'sen', maxPerDay: 5, maxPerWeek: 24, maxConsecutive: 3 },
    ],
    offerings: [
      { id: 'A-DS', sectionId: 'A', size: 40, teachers: [{ id: 'rao', preference: 5 }] },
      { id: 'A-OS', sectionId: 'A', size: 40, teachers: [{ id: 'sen', preference: 5 }] },
    ],
    needs: [
      { id: 'A-DS:l', offeringId: 'A-DS', kind: 'lecture', blocks: 3, length: 1, roomKind: 'classroom' },
      { id: 'A-OS:l', offeringId: 'A-OS', kind: 'lecture', blocks: 3, length: 1, roomKind: 'classroom' },
    ],
    options: { seed: 7, iterations: 500 },
  }
}

test('a long solve leaves the event loop free (REL-01)', async () => {
  const s = solveInThread({ kind: 'spin', ms: 3000 }, 10_000)
  await s.online
  for (let i = 0; i < 10; i++) {
    const t0 = performance.now()
    await new Promise((r) => setImmediate(r))
    await new Promise((r) => setTimeout(r, 50))
    assert.ok(performance.now() - t0 < 300, 'the main thread was held up by the solve')
  }
  assert.equal(s.settled, false, 'the solve was still running while the loop was measured')
  assert.deepEqual(await s.result, { spun: 3000 })
})

test('a solve past its hard limit is stopped (REL-01)', async () => {
  const t0 = performance.now()
  const s = solveInThread({ kind: 'spin', ms: 5000 }, 500)
  await assert.rejects(s.result, (e: unknown) => e instanceof SolveFailed && e.code === 'timed_out')
  assert.ok(performance.now() - t0 < 2000)
})

test('a solve over its memory is stopped (REL-01)', async () => {
  const s = solveInThread({ kind: 'hog' }, 30_000)
  await assert.rejects(s.result, (e: unknown) => e instanceof SolveFailed && e.code === 'out_of_memory')
})

test('a cancelled solve rejects as cancelled', async () => {
  const t0 = performance.now()
  const s = solveInThread({ kind: 'spin', ms: 5000 }, 30_000)
  await s.online
  s.cancel()
  await assert.rejects(s.result, (e: unknown) => e instanceof SolveFailed && e.code === 'cancelled')
  assert.ok(performance.now() - t0 < 1000 + 500, 'cancel stops the thread at once')
})

test('a real solve in a thread returns what the solver returns', async () => {
  const input = tiny()
  const s = solveInThread({ kind: 'solve', input }, 30_000)
  // Everything but the wall-clock time the solver reports about itself.
  const same = (r: unknown) => {
    const { stats, ...rest } = r as ReturnType<typeof solve>
    const { ms: _ms, ...counts } = stats
    return { ...rest, stats: counts }
  }
  assert.deepEqual(same(await s.result), same(solve(tiny())))
})
