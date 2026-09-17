import { createHash } from 'node:crypto'
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { join, resolve } from 'node:path'
import { build } from 'esbuild'
import { packDirectory } from './archive.mjs'

/**
 * Turn every module into a plugin archive the host can download and install.
 *
 * Not an npm package. CampusOS keeps its own package repository -- a plain,
 * signed, versioned set of archives with an index -- because an institution
 * installing a module should not need a Node toolchain, a registry account or
 * a package manager. They pick it from a list in the admin portal.
 *
 * Each archive holds:
 *
 *   plugin.json      manifest, version, and a sha256 for every file in here
 *   server.mjs       the bundled API: operations, routes, OpenAPI fragment
 *   migrations/*.sql the SQL that builds this module's tables
 *
 * Everything is bundled, including @campusos/db and drizzle. That is the whole
 * point: a plugin must load under plain Node at an institution with no
 * toolchain, no package manager and no source. Leaving dependencies external
 * would mean resolving TypeScript-source workspace packages at runtime, which
 * Node cannot do.
 *
 * The one thing a plugin must not bring its own of is the connection pool. Two
 * pools against the same database would double the connections and make "how
 * many is CampusOS using" unanswerable from either side. So the host publishes
 * its pool on a global and the plugin's bundled copy of @campusos/db picks it
 * up; see `useSharedPool`. Nothing else crosses the boundary -- a handler takes
 * a plain actor and a Request, and returns JSON.
 *
 * `pg` itself is stubbed rather than bundled: the plugin never constructs a
 * pool, so carrying the driver would be dead weight with native bindings
 * attached.
 */

const ROOT = resolve(import.meta.dirname, '..')
const MODULES = join(ROOT, 'packages', 'modules')
const OUT = join(ROOT, 'dist', 'plugins')

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

const stubPg = {
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

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex')

const version = () => {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
  return process.env.PLUGIN_VERSION ?? pkg.version ?? '0.1.0'
}

async function packOne(id, versionTag) {
  const dir = join(MODULES, id)
  const out = join(OUT, id)
  // Built inside the module's own directory first. The externals above resolve
  // by ordinary Node lookup walking up from the importing file, so the bundle
  // can only be imported from somewhere that can see @campusos/*. That is
  // exactly the arrangement the host reproduces when it extracts a plugin into
  // its own tree -- packing here is the same resolution path, tested early.
  const staging = join(dir, '.pack')
  rmSync(out, { recursive: true, force: true })
  rmSync(staging, { recursive: true, force: true })
  mkdirSync(join(out, 'migrations'), { recursive: true })
  mkdirSync(staging, { recursive: true })

  await build({
    entryPoints: [join(dir, 'plugin.ts')],
    outfile: join(staging, 'server.mjs'),
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'node22',
    // Node builtins only. Everything else travels with the plugin.
    packages: 'bundle',
    plugins: [stubPg],
    // Readable in a stack trace from a production incident. The archive is a
    // few hundred kilobytes either way, and a minified plugin is a plugin
    // nobody can debug at an institution that has no source access.
    minify: false,
    sourcemap: false,
    // ESM output has no ambient `require`, so esbuild emits a shim that throws
    // on any CommonJS dependency reaching for a Node builtin -- `pg-types`
    // reaches for `stream`. Giving the bundle a real one costs two lines and
    // covers the class rather than this instance. Only builtins can arrive
    // here: everything else is bundled.
    banner: {
      js: [
        "import { createRequire as __campusosCreateRequire } from 'node:module'",
        'const require = __campusosCreateRequire(import.meta.url)',
      ].join('\n'),
    },
    logLevel: 'warning',
  })

  // A placeholder pool, so importing the bundle exercises the same seam the
  // host uses. If this were absent the plugin would try to open its own, which
  // is precisely what the stubbed driver refuses -- and packing would fail
  // loudly rather than shipping an archive that cannot load.
  globalThis.__campusosPool ??= { __placeholder: 'pack-time' }

  // The manifest is read out of the built bundle rather than parsed from
  // source: whatever the host will load is what gets described.
  const { plugin } = await import(`file://${join(staging, 'server.mjs')}`)
  cpSync(join(staging, 'server.mjs'), join(out, 'server.mjs'))
  rmSync(staging, { recursive: true, force: true })

  const migrations = existsSync(join(dir, 'migrations'))
    ? readdirSync(join(dir, 'migrations')).filter((f) => f.endsWith('.sql')).sort()
    : []
  for (const f of migrations) {
    cpSync(join(dir, 'migrations', f), join(out, 'migrations', f))
  }

  const files = ['server.mjs', ...migrations.map((f) => `migrations/${f}`)]
  const checksums = Object.fromEntries(
    files.map((f) => [f, sha256(readFileSync(join(out, f)))]),
  )

  const meta = {
    id: plugin.manifest.id,
    name: plugin.manifest.name,
    description: plugin.manifest.description,
    version: versionTag,
    manifest: plugin.manifest,
    migrations,
    // Every endpoint this plugin will answer, so the store can show its surface
    // before anybody installs it.
    endpoints: plugin.routes.map((r) => `${r.method} ${r.path}`).sort(),
    files: checksums,
  }
  writeFileSync(join(out, 'plugin.json'), JSON.stringify(meta, null, 2) + '\n')

  // The archive: one tar.gz per module per version, which is what the host
  // downloads. tar is used over zip because every target platform has it and
  // it preserves the directory shape without a dependency.
  // Relative paths with an explicit cwd: bsdtar on Windows chokes on absolute
  // paths with a drive letter, and this is the one place the build touches the
  // shell.
  const name = `campusos-${id}-${versionTag}.tgz`
  packDirectory(OUT, id, name)

  const digest = sha256(readFileSync(join(OUT, name)))
  return { ...meta, archive: name, sha256: digest }
}

const versionTag = version()
rmSync(OUT, { recursive: true, force: true })
mkdirSync(OUT, { recursive: true })

const ids = readdirSync(MODULES).filter((d) =>
  existsSync(join(MODULES, d, 'plugin.ts')),
)

const packed = []
for (const id of ids) {
  packed.push(await packOne(id, versionTag))
  console.log(`packed ${id}@${versionTag}`)
}

writeFileSync(
  join(OUT, 'packed.json'),
  JSON.stringify({ version: versionTag, plugins: packed }, null, 2) + '\n',
)
console.log(`\n${packed.length} plugins -> dist/plugins`)
