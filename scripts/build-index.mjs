import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { join, resolve } from 'node:path'

/**
 * The index of the CampusOS package repository.
 *
 * This is the file a host fetches to find out what it can install. It is
 * deliberately a plain, static JSON document rather than a service: a registry
 * that is a running server is a registry that can be down while an institution
 * is trying to buy something, and one more thing to operate.
 *
 * Every entry carries a sha256 of the archive. The host verifies it after
 * downloading and refuses to install on a mismatch, so the index is the trust
 * anchor and the transport does not have to be.
 *
 * Versions accumulate: a release never rewrites an older entry, so a host that
 * pinned 0.1.0 keeps working after 0.2.0 ships. The index is merged with
 * whatever was published before, which the release workflow passes in.
 */

const ROOT = resolve(import.meta.dirname, '..')
const OUT = join(ROOT, 'dist', 'plugins')

const packed = JSON.parse(readFileSync(join(OUT, 'packed.json'), 'utf8'))

/**
 * Where the archives are served from. GitHub Releases: free, versioned,
 * immutable once published, and already the place the code lives. Overridable
 * so an institution that cannot reach GitHub can mirror the whole thing.
 */
const base =
  process.env.REGISTRY_BASE_URL ??
  `https://github.com/KIITAT/campusos-platform/releases/download/v${packed.version}`

/** An earlier index, so older versions survive a new release. */
const previousPath = process.env.PREVIOUS_INDEX ?? join(OUT, 'previous-registry.json')
const previous = existsSync(previousPath)
  ? JSON.parse(readFileSync(previousPath, 'utf8'))
  : { packages: {} }

const packages = { ...previous.packages }

for (const p of packed.plugins) {
  const entry = {
    version: p.version,
    // The release this archive was published in. Derivable today, because the
    // tag is v<version> -- recorded anyway, because a host resolving an archive
    // has to know which release holds it once versions have accumulated across
    // several, and an assumption about the release workflow is not something a
    // host should be making.
    release: `v${p.version}`,
    archive: `${base}/${p.archive}`,
    sha256: p.sha256,
    // What the store shows before anybody commits to installing.
    dependsOn: p.manifest.dependsOn,
    softDependsOn: p.manifest.softDependsOn ?? [],
    rolesWithAccess: p.manifest.rolesWithAccess,
    pricing: p.manifest.pricing,
    alwaysEnabled: p.manifest.alwaysEnabled,
    endpoints: p.endpoints.length,
    migrations: p.migrations.length,
    publishedAt: new Date().toISOString(),
  }

  const existing = packages[p.id] ?? {
    id: p.id,
    name: p.name,
    description: p.description,
    versions: {},
  }

  packages[p.id] = {
    ...existing,
    name: p.name,
    description: p.description,
    latest: p.version,
    versions: { ...existing.versions, [p.version]: entry },
  }
}

// Core libraries, if they were packed alongside. A host fetches these before
// it can build at all, where a plugin is fetched by an administrator after it
// is already running.
const corePath = join(ROOT, 'dist', 'core', 'packed-core.json')
const libraries = {}
if (existsSync(corePath)) {
  const core = JSON.parse(readFileSync(corePath, 'utf8'))
  for (const lib of core.libraries) {
    const previousVersions = previous.libraries?.[lib.name]?.versions ?? {}
    libraries[lib.name] = {
      name: lib.name,
      latest: lib.version,
      versions: {
        ...previousVersions,
        [lib.version]: {
          version: lib.version,
          release: `v${lib.version}`,
          archive: `${base}/${lib.archive}`,
          sha256: lib.sha256,
          publishedAt: new Date().toISOString(),
        },
      },
    }
  }
}

const index = {
  // Bumped only if the *shape* of this document changes, so an old host can
  // refuse an index it would misread rather than guessing.
  schema: 1,
  registry: 'CampusOS',
  generatedAt: new Date().toISOString(),
  libraries: { ...(previous.libraries ?? {}), ...libraries },
  packages,
}

writeFileSync(join(OUT, 'registry.json'), JSON.stringify(index, null, 2) + '\n')

/**
 * dist/registry is the release, laid out as it will actually be served: every
 * archive and the index in one flat directory.
 *
 * Plugins and core libraries are packed separately because they are built
 * differently, but nothing downstream cares about that split -- a host, or an
 * institution mirroring the repository onto a USB stick, sees one directory. A
 * local index resolves its archives beside itself, so this is also the thing to
 * copy for an air-gapped install, and building it on every pack means that path
 * is exercised rather than described in a document nobody runs.
 */
const RELEASE = join(ROOT, 'dist', 'registry')
rmSync(RELEASE, { recursive: true, force: true })
mkdirSync(RELEASE, { recursive: true })

let copied = 0
for (const dir of [OUT, join(ROOT, 'dist', 'core')]) {
  if (!existsSync(dir)) continue
  for (const file of readdirSync(dir)) {
    if (!file.endsWith('.tgz')) continue
    copyFileSync(join(dir, file), join(RELEASE, file))
    copied++
  }
}
copyFileSync(join(OUT, 'registry.json'), join(RELEASE, 'registry.json'))
console.log(`dist/registry: ${copied} archives + registry.json`)

console.log(
  `registry.json: ${Object.keys(index.libraries).length} core libraries, ` +
    `${Object.keys(packages).length} packages, ` +
    `${Object.values(packages).reduce((n, p) => n + Object.keys(p.versions).length, 0)} versions`,
)
