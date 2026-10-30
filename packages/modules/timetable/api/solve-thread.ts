import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads'
import { solve, type SolverInput } from './solver'

/**
 * Runs the solver in a worker thread so a long solve does not hold the event
 * loop for every tenant (REL-01). The thread gets only the solver's input: no
 * tenant, no database, no actor. It is stopped at a hard time limit, at a
 * memory cap, or when cancelled.
 *
 * The thread starts by importing this same module (an installed plugin carries
 * only `server.mjs`, so there is no separate worker file); the check at the
 * foot of the module runs the job it was given.
 */

export type SolveJob = { kind: 'solve'; input: SolverInput } | { kind: 'spin'; ms: number } | { kind: 'hog' }
export type SolveFailure = 'timed_out' | 'out_of_memory' | 'crashed' | 'cancelled'

export class SolveFailed extends Error {
  constructor(readonly code: SolveFailure) {
    super(`timetable solve ${code}`)
  }
}

export interface SolveHandle {
  /** Resolves when the thread has started. */
  online: Promise<void>
  /** The solver's result, or a rejection with `SolveFailed`. */
  result: Promise<unknown>
  readonly settled: boolean
  cancel(): void
}

const MARK = 'campusosTimetableSolve'
// Node has no per-thread CPU cap: the time limit is the CPU bound.
export const RESOURCE_LIMITS = { maxOldGenerationSizeMb: 256, maxYoungGenerationSizeMb: 32 }

/** `spin` and `hog` exist for tests: a thread held for a known time, and one that hits the memory cap. */
function run(job: SolveJob): unknown {
  if (job.kind === 'solve') return solve(job.input)
  if (job.kind === 'spin') {
    const until = Date.now() + job.ms
    while (Date.now() < until);
    return { spun: job.ms }
  }
  const keep: unknown[] = []
  for (;;) keep.push(new Array(1e6).fill(1))
}

if (!isMainThread && workerData?.[MARK]) parentPort!.postMessage(run(workerData[MARK] as SolveJob))

export function solveInThread(job: SolveJob, hardLimitMs: number): SolveHandle {
  // Run from source (tests, `tsx`), Node's own type stripping would load the
  // file in the thread and refuse it, so the thread registers tsx first.
  const self = JSON.stringify(import.meta.url)
  const load = import.meta.url.endsWith('.ts')
    ? `import(${JSON.stringify(import.meta.resolve('tsx/esm/api'))}).then((m) => { m.register(); return import(${self}) })`
    : `import(${self})`
  const worker = new Worker(`globalThis.__campusosPool ??= { __placeholder: 'solver-thread' }; ${load}`, {
    eval: true,
    workerData: { [MARK]: job },
    resourceLimits: RESOURCE_LIMITS,
  })
  let why: SolveFailure | null = null
  let settled = false
  const timer = setTimeout(() => {
    why = 'timed_out'
    void worker.terminate()
  }, hardLimitMs)
  const online = new Promise<void>((resolve) => worker.once('online', () => resolve()))
  const result = new Promise<unknown>((resolve, reject) => {
    const end = () => {
      settled = true
      clearTimeout(timer)
    }
    worker.once('message', (m) => {
      end()
      resolve(m)
      void worker.terminate()
    })
    worker.once('error', (err: NodeJS.ErrnoException) => {
      end()
      reject(new SolveFailed(err.code === 'ERR_WORKER_OUT_OF_MEMORY' ? 'out_of_memory' : 'crashed'))
      void worker.terminate()
    })
    worker.once('exit', () => {
      if (settled) return
      end()
      reject(new SolveFailed(why ?? 'crashed'))
    })
  })
  // A handle nobody awaits (cancelled, then dropped) must not become an unhandled rejection.
  result.catch(() => undefined)
  return {
    online,
    result,
    get settled() {
      return settled
    },
    cancel() {
      why = 'cancelled'
      void worker.terminate()
    },
  }
}
