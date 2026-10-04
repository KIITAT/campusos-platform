# Alumni and events

The alumni office maintains graduate profiles attached to existing institution identities. A profile starts private. Only its owner may consent to directory publication and separately to publishing contact email; contact consent requires profile consent. Administrators retain office access to private records. Members see only their own or published profiles, with contact details removed unless separately consented.

Administrators create draft events, open registration, close registration or cancel the event. Opening after the registration deadline is refused. Deadlines are inclusive UTC calendar dates. An existing alumni profile is required to register; one active reservation per profile/event is allowed. Owners or administrators can cancel a reservation to release its seat. Cancelling an event cancels all reservations and prevents further registration. Closed events cannot reopen in this version.

Event locks serialize registration, cancellation and availability changes; capacity cannot be exceeded by concurrent requests. Tenant RLS and composite event/profile foreign keys prevent cross-institution reservations. Changes and audit records commit together. This module adds no alumni login, public directory, paid ticketing, mass messaging or external event service.

API base: `/api/v1/modules/alumni`. GET `/profiles`, `/events`, `/registrations`. POST `/profiles`, `/profiles/consent`, `/events`, `/events/transition`, `/registrations`, `/registrations/cancel`. All forms have declared request schemas in OpenAPI.

Run `pnpm test` against isolated PostgreSQL after core/module migrations. Tests cover consent ownership/redaction/revocation, erased identities, deadline boundaries, capacity races, cancellation, tenant RLS/composites, audit and actual loaded page wiring.
