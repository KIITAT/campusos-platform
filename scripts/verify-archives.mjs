import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

/**
 * Prove a packed plugin is loadable by somebody who has only the archive.
 *
 * Everything else in this repository tests the modules as workspace packages,
 * with TypeScript, a resolver and nine sibling projects available. An
 * institution has none of that: it has a tar file, plain Node, and a running
 * host. This unpacks each archive into a temporary directory outside the
 * workspace and loads it there, which is the only way to know the bundling
 * assumptions still hold.
 */

const ROOT = resolve(import.meta.dirname, '..')
const OUT = join(ROOT, 'dist', 'plugins')

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex')

const index = JSON.parse(readFileSync(join(OUT, 'registry.json'), 'utf8'))
const work = mkdtempSync(join(tmpdir(), 'campusos-verify-'))

// The host publishes its pool before loading anything. Nothing here connects,
// so a placeholder is enough to prove the seam is the only thing needed.
globalThis.__campusosPool = { __placeholder: 'verify' }

let checked = 0
try {
  for (const [id, pkg] of Object.entries(index.packages)) {
    const entry = pkg.versions[pkg.latest]
    const archive = join(OUT, entry.archive.split('/').pop())

    const digest = sha256(readFileSync(archive))
    if (digest !== entry.sha256) {
      throw new Error(`${id}: archive does not match the checksum in the index`)
    }

    // The archive is copied in and extracted with a working directory rather
    // than absolute paths: bsdtar on Windows will not take a drive letter.
    const dir = join(work, id)
    mkdirSync(dir, { recursive: true })
    const local = entry.archive.split('/').pop()
    copyFileSync(archive, join(dir, local))
    execFileSync('tar', ['-xzf', local], { cwd: dir, stdio: 'inherit' })
    rmSync(join(dir, local))

    const meta = JSON.parse(readFileSync(join(dir, 'plugin.json'), 'utf8'))
    for (const [file, expected] of Object.entries(meta.files)) {
      const actual = sha256(readFileSync(join(dir, file)))
      if (actual !== expected) throw new Error(`${id}: ${file} does not match plugin.json`)
    }

    const { plugin } = await import(pathToFileURL(join(dir, 'server.mjs')).href)

    if (plugin.manifest.id !== id) {
      throw new Error(`${id}: archive declares ${plugin.manifest.id}`)
    }
    if (plugin.routes.length !== meta.endpoints.length) {
      throw new Error(`${id}: ${plugin.routes.length} routes, ${meta.endpoints.length} listed`)
    }
    if (meta.migrations.length !== readdirSync(join(dir, 'migrations')).length) {
      throw new Error(`${id}: migrations listed and shipped disagree`)
    }

    console.log(
      `${id.padEnd(14)} ${plugin.routes.length} routes, ` +
        `${meta.migrations.length} migrations, ok`,
    )
    checked++
  }
} finally {
  rmSync(work, { recursive: true, force: true })
}

console.log(`\n${checked} archives load outside the workspace`)
