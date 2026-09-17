import { execFileSync } from 'node:child_process'
import { gzipSync } from 'node:zlib'
import { readFileSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { join, relative, sep } from 'node:path'

/**
 * Packing a directory into an archive that is the same bytes every time.
 *
 * A registry that pins a sha256 is making a claim -- this archive is what the
 * repository published -- and the claim is only checkable if the same source
 * packs to the same bytes. `tar -czf` fails that twice: it records each file's
 * modification time, and gzip stamps the moment of compression into its header.
 * Two builds of an unchanged module then differ, the pin churns for no reason,
 * and nobody can rebuild an archive to verify it against the source.
 *
 * So: fixed mtimes, a sorted file list rather than directory order, and gzip
 * from node's zlib, which writes no timestamp. bsdtar and GNU tar disagree
 * about nearly every flag, but both take a list of names and produce the same
 * ustar stream from them.
 */

/** 2020-01-01. Arbitrary, fixed, and obviously not a build time. */
const EPOCH = new Date('2020-01-01T00:00:00Z')

function filesUnder(dir, base = dir) {
  const out = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...filesUnder(full, base))
    else out.push(relative(base, full).split(sep).join('/'))
  }
  // Sorted, so the archive does not depend on the order a filesystem happened
  // to hand back its entries.
  return out.sort()
}

/**
 * @param cwd   directory the archive is written into
 * @param dir   subdirectory of `cwd` to pack, packed as its contents
 * @param name  archive filename, written into `cwd`
 */
export function packDirectory(cwd, dir, name) {
  const root = join(cwd, dir)
  const names = filesUnder(root)

  for (const file of names) utimesSync(join(root, file), EPOCH, EPOCH)
  // Directories carry an mtime too, and tar records them.
  const dirs = new Set()
  for (const file of names) {
    const parts = file.split('/')
    for (let i = 1; i < parts.length; i++) dirs.add(parts.slice(0, i).join('/'))
  }
  for (const d of [...dirs].sort().reverse()) utimesSync(join(root, d), EPOCH, EPOCH)
  utimesSync(root, EPOCH, EPOCH)

  const listing = join(cwd, `${name}.files`)
  writeFileSync(listing, names.join('\n') + '\n')

  const tarball = join(cwd, `${name}.tar`)
  try {
    // Relative paths with an explicit cwd: bsdtar on Windows will not take an
    // absolute path with a drive letter.
    execFileSync(
      'tar',
      ['-cf', `${name}.tar`, '-C', dir, '--numeric-owner', '-T', `${name}.files`],
      { cwd, stdio: 'inherit' },
    )
    // level 9 and no timestamp; gzipSync writes MTIME 0 by default.
    writeFileSync(join(cwd, name), gzipSync(readFileSync(tarball), { level: 9 }))
  } finally {
    rmSync(tarball, { force: true })
    rmSync(listing, { force: true })
  }

  return statSync(join(cwd, name)).size
}
