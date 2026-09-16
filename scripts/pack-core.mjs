import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

/**
 * Pack the core libraries the host builds against.
 *
 * These are not plugins. A plugin is installed at runtime by an administrator;
 * these four are what the host *is* -- its database layer, its module
 * framework, its shared contracts. They have to be present before the
 * application compiles, let alone before anybody installs anything.
 *
 * They travel through the same package repository anyway, for the same reason
 * the modules do: an institution self-hosting CampusOS should need a Node
 * runtime and nothing else. No registry account, no package manager
 * configuration, no private npm.
 *
 * The archives carry TypeScript source rather than compiled output, because the
 * host bundles them itself and a build step here would only add a second
 * compiler to keep in step with the first.
 */

const ROOT = resolve(import.meta.dirname, '..')
const OUT = join(ROOT, 'dist', 'core')

/** In dependency order, so a mirror can be walked top to bottom. */
const LIBRARIES = [
  { name: '@campusos/module-framework', dir: 'packages/module-framework' },
  { name: '@campusos/money', dir: 'packages/money' },
  { name: '@campusos/db', dir: 'packages/db' },
  { name: '@campusos/api-contracts', dir: 'packages/api-contracts' },
]

/** Not shipped: test files, local builds, and anything a consumer cannot use. */
const SKIP = new Set(['node_modules', 'dist', '.pack', '.turbo'])
const isTest = (p) => /\.test\.ts$/.test(p)

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex')

const version =
  process.env.PLUGIN_VERSION ??
  JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version ??
  '0.1.0'

rmSync(OUT, { recursive: true, force: true })
mkdirSync(OUT, { recursive: true })

const packed = []

for (const lib of LIBRARIES) {
  const short = lib.name.replace('@campusos/', '')
  const staging = join(OUT, short)
  mkdirSync(staging, { recursive: true })

  cpSync(join(ROOT, lib.dir), staging, {
    recursive: true,
    filter: (src) => {
      const parts = src.split(/[\\/]/)
      if (parts.some((p) => SKIP.has(p))) return false
      return !isTest(src)
    },
  })

  // devDependencies are stripped from the shipped package.json. They exist for
  // this repository's own tests -- api-contracts depends on every module to
  // assert that routes and OpenAPI agree -- and a consumer that tried to
  // install them would be looking for packages that are plugins, not packages.
  const manifestPath = join(staging, 'package.json')
  const pkg = JSON.parse(readFileSync(manifestPath, 'utf8'))
  delete pkg.devDependencies
  delete pkg.scripts?.test
  writeFileSync(manifestPath, JSON.stringify(pkg, null, 2) + '\n')

  const name = `campusos-core-${short}-${version}.tgz`
  execFileSync('tar', ['-czf', name, '-C', short, '.'], { cwd: OUT, stdio: 'inherit' })
  rmSync(staging, { recursive: true, force: true })

  packed.push({
    name: lib.name,
    short,
    version,
    archive: name,
    sha256: sha256(readFileSync(join(OUT, name))),
  })
  console.log(`packed ${lib.name}@${version}`)
}

writeFileSync(
  join(OUT, 'packed-core.json'),
  JSON.stringify({ version, libraries: packed }, null, 2) + '\n',
)
console.log(`\n${packed.length} core libraries -> dist/core`)
