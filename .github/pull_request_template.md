## What this changes

<!-- One or two sentences. The diff says what; say why. -->

## Checklist

- [ ] Every new tenant-scoped table carries `tenantPolicy()` in this same PR
- [ ] Invariants that could be enforced by Postgres are, and a test proves it by
      bypassing the application check
- [ ] A disabled module stays unreachable — asserted, not assumed
- [ ] `pnpm typecheck && pnpm lint && pnpm test` pass locally
- [ ] `pnpm db:check` clean, and `openapi.json` regenerated if a contract changed
- [ ] A module schema change ships as SQL in that module's `migrations/`, not in
      the core history
- [ ] Deliberate shortcuts carry a `ponytail:` comment naming the ceiling

## Anything reviewers should look at first

<!-- Name the risky hunk. "Nothing" is a fine answer. -->
