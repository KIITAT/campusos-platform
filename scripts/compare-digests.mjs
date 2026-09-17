import { readFileSync } from 'node:fs'

/**
 * Two registry indexes must agree on every checksum.
 *
 * Used by CI to pack twice and compare. A difference means something in the
 * build leaks into the archive that is not the source -- a timestamp, a
 * filesystem ordering, an absolute path -- and the sha256 the repository
 * publishes stops being something anyone else can reproduce.
 */

const digests = (path) => {
  const index = JSON.parse(readFileSync(path, 'utf8'))
  const out = {}
  for (const group of [index.libraries, index.packages]) {
    for (const [id, pkg] of Object.entries(group)) {
      out[id] = pkg.versions[pkg.latest].sha256
    }
  }
  return out
}

const [a, b] = process.argv.slice(2).map(digests)
const drifted = Object.keys(a).filter((id) => a[id] !== b[id])

if (drifted.length > 0) {
  console.error('these archives are not reproducible:')
  for (const id of drifted) console.error(`  ${id}: ${a[id]} then ${b[id]}`)
  process.exit(1)
}

console.log(`${Object.keys(a).length} archives are byte-identical across two packs`)
