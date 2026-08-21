import './src/env'
import { defineConfig } from 'drizzle-kit'

export default defineConfig({
  // Core schema plus every module's tables. One migration history for the
  // whole product: drizzle-kit needs a single history, and a module owning its
  // own migrations folder would make ordering across modules unresolvable.
  // Listed rather than imported, so packages/db never depends on a module and
  // there is no workspace cycle.
  schema: ['./src/schema.ts', './src/audit.ts', '../modules/*/schema.ts'],
  out: './migrations',
  dialect: 'postgresql',
  // owner role: only migrations get DDL rights, the app never does
  dbCredentials: { url: process.env.MIGRATION_DATABASE_URL! },
  entities: { roles: true }, // emit CREATE POLICY / role SQL from pgPolicy()
})
