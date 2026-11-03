// The libraries a CampusOS host provides to plugins (P1-10d, decisions D3 to D7).
// The web host has its own list in lib/plugins/host-libs.ts: keep the two equal.
import { build } from 'esbuild'
import { mkdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

export const HOST_API = 1
export const SHARED = [
  '@campusos/db', '@campusos/db/jobs', '@campusos/db/sensitive-reads',
  '@campusos/module-framework', '@campusos/module-framework/pdf', '@campusos/money',
  'drizzle-orm', 'drizzle-orm/pg-core', 'zod',
]
const ROOT = resolve(import.meta.dirname, '..')
// A module that depends on every shared library, so one directory resolves them all.
export const RESOLVE_DIR = join(ROOT, 'packages', 'modules', 'finance')

/**
 * The driver is never used inside a plugin -- the host's pool arrives through
 * the global -- so it is replaced by something that says so loudly if that
 * assumption ever stops holding.
 *
 * `types` is the exception, and it is not optional: drizzle's node-postgres
 * driver does `const { Pool, types } = pg` at module load and then calls
 * `types.getTypeParser` for every column it does not special-case. A stub
 * without it left `types` undefined, and the first query any installed module
 * ran died on `Cannot read properties of undefined (reading 'builtins')` --
 * which nothing caught, because loading a plugin and querying through one are
 * different things and only the first was ever tested.
 *
 * pg-types is safe to carry: OID constants and pure functions over strings,
 * sharing no state with a connection. The pool remains the only live object
 * that crosses the boundary.
 */
const PG_STUB = `
import types from 'pg-types'

export class Pool {
  constructor() {
    throw new Error(
      'a plugin must not open its own connection pool; the host publishes one',
    )
  }
}
export class Client extends Pool {}
export { types }
export default { Pool, Client, types }
`

export const stubPg = {
  name: 'stub-pg',
  setup(build) {
    build.onResolve({ filter: /^pg$/ }, () => ({ path: 'pg', namespace: 'stub-pg' }))
    build.onLoad({ filter: /.*/, namespace: 'stub-pg' }, () => ({
      contents: PG_STUB,
      loader: 'js',
      // pg-types is resolved from this repository, which is where it is
      // installed; a synthetic module has no directory of its own.
      resolveDir: ROOT,
    }))
  },
}

// ESM output has no ambient `require`, so esbuild emits a shim that throws
// on any CommonJS dependency reaching for a Node builtin -- `pg-types`
// reaches for `stream`. Giving the bundle a real one costs two lines and
// covers the class rather than this instance. Only builtins can arrive
// here: everything else is bundled.
export const banner = {
  js: [
    "import { createRequire as __campusosCreateRequire } from 'node:module'",
    'const require = __campusosCreateRequire(import.meta.url)',
  ].join('\n'),
}

const common = {
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node22',
  packages: 'bundle',
  plugins: [stubPg],
  banner,
  logLevel: 'warning',
  write: false,
  metafile: true,
  outfile: 'out.mjs',
}

/** Export names of a specifier, as esbuild sees them from the module directory `from`. */
export async function exportNames(spec, from) {
  const names = async (contents) => {
    const r = await build({ ...common, stdin: { contents, resolveDir: from, loader: 'js' } })
    return Object.values(r.metafile.outputs)[0].exports
  }
  const all = await names(`export * from ${JSON.stringify(spec)}`)
  const hasDefault = await names(`export { default } from ${JSON.stringify(spec)}`).then(
    () => true,
    () => false,
  )
  return hasDefault ? [...all, 'default'] : all
}

/** For a pack or a test in plain Node: build every shared library once and publish them as a host would. */
export async function publishPackHost() {
  if (globalThis.__campusosHost?.api === HOST_API) return
  const outfile = join(ROOT, 'dist', 'host-libs.mjs')
  mkdirSync(join(ROOT, 'dist'), { recursive: true })
  await build({
    ...common,
    write: true,
    metafile: false,
    outfile,
    stdin: {
      contents: SHARED.map((s, i) => `export * as m${i} from ${JSON.stringify(s)}`).join('\n'),
      resolveDir: RESOLVE_DIR,
      loader: 'js',
    },
  })
  globalThis.__campusosPool ??= { __placeholder: 'pack-time' }
  const mod = await import(pathToFileURL(outfile).href)
  globalThis.__campusosHost = {
    api: HOST_API,
    modules: Object.fromEntries(SHARED.map((s, i) => [s, mod['m' + i]])),
  }
}
