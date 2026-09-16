import { existsSync } from 'node:fs'
import { dirname, join, parse } from 'node:path'

// Loads the repo-root .env.local for anything run outside Next.js (drizzle-kit,
// seed, tests) and for Next itself, which only looks in its own app directory.
//
// Walks up from cwd rather than using import.meta.url: the bundler rewrites
// this file's location into .next/, so a path relative to the module resolves
// somewhere meaningless in a production build.
//
// Nothing found is not an error -- deployed environments inject real env vars.
for (let dir = process.cwd(); dir !== parse(dir).root; dir = dirname(dir)) {
  const file = join(dir, '.env.local')
  if (existsSync(file)) {
    process.loadEnvFile(file)
    break
  }
}
