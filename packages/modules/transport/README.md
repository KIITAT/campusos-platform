# Transport

Institution transport allocation: register a vehicle and capacity, give it one route, order that route's stops, assign an existing student to a stop, and release the seat with a reason. One vehicle serves one route in this version; there are no trip schedules, GPS feeds, driver payroll, fare collection or external booking portal.

Administrators maintain inventory and assignments. Institution members can read route information and only their own assignment history. A student has at most one active transport assignment. Route locks serialize allocation and release, so concurrent requests cannot oversubscribe the vehicle. The stop must belong to the chosen route, and the non-erased student must belong to the institution.

All four tables use tenant RLS. Composite foreign keys bind route to tenant/vehicle, stop to tenant/route, and assignment to its route/stop. Every successful mutation writes an audit record in its transaction; denied requests do not leave partial assignments.

API base: `/api/v1/modules/transport`. GET: `/vehicles`, `/routes`, `/stops`, `/assignments`. POST: the same four resources plus `/assignments/release`. OpenAPI carries the request schemas. Vehicle inventory itself is office-only.

Run `pnpm test` against isolated PostgreSQL after core and module migrations. Tests exercise capacity races, seat reuse, owner views, erased identities, tenant RLS/composite references, audit and loaded page/route wiring.
