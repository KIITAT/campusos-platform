# Admissions

Institution-operated admissions using existing CampusOS identities. The office records an enquiry, applies to an Academic programme and intake term, offers a place, and accepts it by linking an existing student. Acceptance and the active Academic student-programme declaration commit atomically. An existing active declaration is reused; another active primary programme is not displaced.

Only `institution_admin` and tenant-scoped `super_admin` operate this module. No public applicant portal, applicant login, payment capture, document verification service, or automatic identity provisioning is introduced.

## State and integrity

- Applications start `submitted`; only submitted applications can become `offered`.
- Submitted/offered applications may be `rejected` or `withdrawn`, with a reason.
- Only offered applications can become `accepted`. Accepted/rejected/withdrawn applications are terminal.
- An enquiry has at most one application for a programme and term. All referenced records and the non-erased student identity must belong to the institution.
- Row locks serialize decisions and acceptance. Tenant RLS, an enquiry composite foreign key, and same-transaction audit protect the workflow.

## Interfaces

API base: `/api/v1/modules/admissions`. GET: `/enquiries`, `/applications`. POST: `/enquiries`, `/applications`, `/applications/decision`, `/applications/accept`. Every mutation has a corresponding declarative screen form and an OpenAPI request schema.

Run `pnpm test` with app and migration database URLs pointing to an isolated PostgreSQL database after applying core, Academic, and this module's migrations. Tests cover acceptance races, tenant/role/erased-identity boundaries, stored RLS/composite references, audit, and real loaded page choices.
