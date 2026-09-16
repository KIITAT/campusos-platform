# CampusOS platform

[![CI](https://github.com/KIITAT/campusos-platform/actions/workflows/ci.yml/badge.svg)](https://github.com/KIITAT/campusos-platform/actions/workflows/ci.yml)

The core of a multi-tenant college ERP, and the nine feature modules that ship
as installable plugins.

One institution's data is invisible to another because Postgres says so, not
because the query remembered a `WHERE` clause.

| Repository | What it is |
|---|---|
| **campusos-platform** (here) | The database layer, the module framework, shared contracts, and the modules |
| [campusos-web](https://github.com/KIITAT/campusos-web) | The host: admin portal, JSON API, plugin runtime |
| [campusos-mobile](https://github.com/KIITAT/campusos-mobile) | The Flutter client |

---

## What is in here

```
packages/db                   Core schema, RLS helpers, audit log, DPDP, device tokens
packages/module-framework     Manifest, entitlement gate, nav, the plugin contract
packages/api-contracts        Zod 4 schemas + the generated OpenAPI document
packages/money                Rupee and paise parsing, shared by fees and library
packages/modules/academic     Departments, programmes, terms, cohorts, timetable
packages/modules/attendance   Rotating-QR sessions, geofence, device binding
packages/modules/examinations Exams, publish-locked marks, grade scales, transcripts
packages/modules/fees         Charges, waivers, receipted payments, dues
packages/modules/library      Catalogue, circulation, overdue fines
packages/modules/hostel       Rooms, allocation, roll call, leave, visitors
packages/modules/hr           Staff, leave workflow, dated pay, payslips
packages/modules/notices      Notice board and the notification centre
packages/modules/parents      Verified links, a read-only lens over the rest
scripts/                      Packing, the registry index, and their checks
```

## The package repository

CampusOS keeps its own. An institution installing a module should not need a
Node toolchain, a registry account or a package manager — they pick it from a
list in the admin portal, and the host downloads it.

A tag publishes one release holding every plugin archive plus `registry.json`,
the index a host reads. Each entry carries a sha256; the host verifies it after
downloading and refuses to install on a mismatch, so the index is the trust
anchor and the transport does not have to be. Versions accumulate — publishing
0.2.0 leaves 0.1.0 in the index for a host that pinned it.

```
campusos-library-0.1.0.tgz
  plugin.json        manifest, version, sha256 of every file in here
  server.mjs         the bundled API: operations, routes, OpenAPI fragment
  migrations/*.sql   the SQL that builds this module's tables
```

```bash
pnpm pack:plugins       # build the archives into dist/plugins
pnpm registry:index     # build the index over them
node scripts/verify-archives.mjs
```

## How a plugin works

A module used to contribute its API as files in the host application — ninety
odd three-line mounts, written and reviewed by hand. A module that arrives from
the package repository at runtime cannot do that: nobody is there to add files
and rebuild. So a module **declares** its routes and the host dispatches.

```ts
// packages/modules/library/routes.ts
export const routes: PluginRoute[] = [
  { method: 'GET', path: '/titles', handler: (actor, req) => catalogue(actor, param(req, 'q')) },
  ...
]
```

The handler is the same operation it always was and still checks its own
permissions; the host wraps the session and the entitlement gate around it
exactly as the mounts did. `plugin.ts` bundles that together with the manifest
and the OpenAPI fragment, and validates at load: a route outside the module's
own base path, a duplicate, or an `apiBasePath` that contradicts the id fails
on load rather than on the first request in a corridor.

**Everything is bundled**, including `@campusos/db` and drizzle, because a
plugin has to load under plain Node at an institution with no toolchain.

**Except the connection pool.** Two pools against one database would double the
connections and make "how many is CampusOS using" unanswerable from either
side. The host publishes its pool on a global before loading anything and the
plugin's bundled copy of `@campusos/db` picks it up. Nothing else crosses the
boundary: a handler takes a plain actor and a `Request`, and returns JSON.

## Migrations

The core history is drizzle-kit's and covers what exists before any plugin
does — institutions, users, the Auth.js tables, the audit log, device tokens.
That is exactly the set every module's foreign keys point at.

Each module owns the rest. `packages/modules/<id>/migrations/*.sql` travels in
the archive and is applied by the host at install time, in order, tracked per
plugin.

`ponytail:` module SQL is hand-maintained rather than generated. drizzle-kit
wants one history and a module cannot have one; for a new module, generate
against the full workspace and move the statements into its folder. CI applies
every module's migrations on top of a fresh core on every run, so a file that
stopped applying is caught here rather than at an institution.

## Working on it

```bash
pnpm install
docker compose up -d
pnpm db:migrate                            # core
node scripts/apply-module-migrations.mjs   # every module, in dependency order
pnpm test
```

## The three rules a change is reviewed against

**1. RLS is the security boundary; entitlements are a billing feature.** A new
tenant-scoped table gets `tenantPolicy()` in the same commit that creates it.

**2. Every invariant that can live in the database, does** — and the test proves
it by bypassing the application check and asserting Postgres still refuses.

**3. A module owns its domain logic and its contract.** The host owns session,
gating and the error envelope.

`SECURITY.md` has the boundaries this product defends and how to report a hole
in one privately.
