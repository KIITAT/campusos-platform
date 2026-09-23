import './src/env'
import { defineConfig } from 'drizzle-kit'

export default defineConfig({
  // Core only. Modules are plugins now: each carries its own migrations in its
  // package, applied by the host at install time and tracked per plugin. This
  // history covers the tables that exist before any plugin does -- institutions,
  // users, the Auth.js tables, the shared audit log and device tokens -- which
  // is exactly the set a module's foreign keys point at.
  schema: ['./src/schema.ts', './src/audit.ts', './src/device-tokens.ts', './src/invitations.ts'],
  out: './migrations',
  dialect: 'postgresql',
  // owner role: only migrations get DDL rights, the app never does
  dbCredentials: { url: process.env.MIGRATION_DATABASE_URL! },
  entities: { roles: true }, // emit CREATE POLICY / role SQL from pgPolicy()
})
