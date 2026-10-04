# PostgreSQL jobs

`@campusos/db/jobs` is part of the existing database core library, not a fifth
distribution. Migration `0004_job_queue.sql` adds the RLS-scoped queue.

Enqueue inside the business transaction with `enqueueJob(tx, {institutionId,
actorId,kind,dedupeKey,payload,runAfter?,maxAttempts?})`. A tenant-local dedupe key
returns the original job; conflicting actor/kind/payload is refused. Payloads
are limited to 64 KiB and must not contain credentials. Keep completed rows for
as long as their dedupe keys need replay protection.

`claimJob(tenant,workerId,leaseSeconds=120)` atomically claims one due job using
`FOR UPDATE SKIP LOCKED`, increments its attempt count and returns a fresh token.
Expired leases recover on the next claim; exhausted leases become dead.

`runClaimedJob(tenant,id,leaseToken,handler)` locks and validates the claimed row,
then commits the handler's database effects and success receipt together. Every
plugin handler must use the supplied transaction, never open its own transaction
or make external writes. The row lock prevents takeover while the handler runs,
even when the nominal lease expires. Failed transactions roll back both effects
and acknowledgement; `failJob` separately records a safe error code and retry
time. A stale token cannot fail or complete a new attempt. Five attempts by
default (maximum ten), exponentially delayed from five seconds, capped one hour.

Host handlers use `jobActor` inside the same transaction to recheck institution
suspension, actor tenant/erasure/current role and current enabled entitlement.
Shared row locks serialize concurrent role/entitlement changes with execution.
The explicit `alwaysEnabled` argument is only for manifest-declared base modules.

Plugin `jobs` metadata declares kind, roles, optional daily scheduling, and
`run(actor,tx,payload)`. The worker only loads installed plugins and explicitly
configured institution/actor bindings. Financial business dates resolve in the
institution timezone; daily enqueue dedupe is UTC. No unauthenticated HTTP
scheduler exists. Financial and inbox delivery effects are exactly-once within
PostgreSQL; this does not extend to email or external providers.
