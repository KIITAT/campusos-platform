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
import { RESOLVE_DIR, SHARED, banner, exportNames, publishPackHost, stubPg } from './host-libs.mjs'

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
 * Everything is bundled except the shared libraries of host-libs.mjs (@campusos/db,
 * the module framework, money, drizzle, zod): those come from the host through
 * globalThis.__campusosHost, so 25 plugins do not carry 25 copies of them. The rest
 * is bundled because a plugin must load under plain Node at an institution with
 * no toolchain, no package manager and no source. An archive built this way
 * does not load on a host older than this change (P1-10d).
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

// Imports of a shared library become a shim that reads the host's copy, and
// fails at load -- not on the first request that needs it -- if the host lacks
// the library or one of its names (P1-10d, D4).
// The timetable solver re-imports its own module in a worker thread, which has
// no host to lend libraries (P1-10d); it keeps its own copies.
const NO_HOST_LIBS = new Set(['timetable'])
const shims = new Map()
const hostLibs = () => ({
  name: 'host-libs',
  setup(build) {
    build.onResolve({ filter: /^(@campusos[/](db|module-framework|money)|drizzle-orm|zod)([/].*)?$/ }, (args) =>
      SHARED.includes(args.path) ? { path: args.path, namespace: 'host-lib' } : undefined,
    )
    build.onLoad({ filter: /.*/, namespace: 'host-lib' }, async (args) => {
      if (!shims.has(args.path)) shims.set(args.path, shim(args.path, await exportNames(args.path, RESOLVE_DIR)))
      return { contents: shims.get(args.path), loader: 'js' }
    })
  },
})

function shim(spec, names) {
  const s = JSON.stringify(spec)
  return [
    'const host = globalThis.__campusosHost',
    "if (!host || host.api !== 1) throw new Error('this module needs a CampusOS host that provides its libraries (host API 1)')",
    `const m = host.modules[${s}]`,
    `if (!m) throw new Error('the host does not provide ' + ${s})`,
    ...names.map(
      (n, i) =>
        `if (!(${JSON.stringify(n)} in m)) throw new Error("the host's " + ${s} + " lacks " + ${JSON.stringify(n)}); const __h${i} = m[${JSON.stringify(n)}]`,
    ),
    `export { ${names.map((n, i) => `__h${i} as ${n}`).join(', ')} }`,
  ].join(String.fromCharCode(10))
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
    plugins: NO_HOST_LIBS.has(id) ? [stubPg] : [hostLibs(), stubPg],
    // Readable in a stack trace from a production incident. The archive is a
    // few hundred kilobytes either way, and a minified plugin is a plugin
    // nobody can debug at an institution that has no source access.
    minify: false,
    sourcemap: false,
    banner,
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

await publishPackHost()
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
