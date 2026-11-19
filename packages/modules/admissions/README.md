# Admissions

Institution-operated admissions. The office records an enquiry, applies to an Academic programme and intake term (optionally with the applicant's own name, email, date of birth and category, when the enquirer is someone else), offers a place, and accepts it into a section of the programme. The section is required.

Acceptance enrols the applicant in one transaction:

- **Account.** An existing student account may be picked. Otherwise the applicant's own email (or the enquiry's) decides: a new address creates a student account and a 30-day sign-in invitation, whose link is shown once in the acceptance notice; an existing student here is reused; an address that is another role here, or an account at another institution, is refused.
- **Programme and section.** The active Academic programme declaration is reused or created (another active primary programme is not displaced), and the student is seated in the chosen section.
- **Profile.** A student without a roll number gets one, `<intake year><programme code><4-digit sequence>` (for example `2026BSC0001`), numbered per programme and intake year; a number already typed by hand is skipped. The application's category is copied to the profile when it has none, and its date of birth to an account that has none.
- **Fees.** When Fees is on for the institution, the term's invoice is issued and posted in the same transaction; nothing is invoiced when it is off.

Only `institution_admin` and tenant-scoped `super_admin` operate this module. No public applicant portal, applicant login, payment capture or document verification service is introduced (P1-12b).

## State and integrity

- Applications start `submitted`; only submitted applications can become `offered`.
- Submitted/offered applications may be `rejected` or `withdrawn`, with a reason.
- Only offered applications can become `accepted`. Accepted/rejected/withdrawn applications are terminal.
- An enquiry has at most one application for a programme and term. All referenced records and the non-erased student identity must belong to the institution.
- Row locks serialize decisions and acceptance. Tenant RLS, an enquiry composite foreign key, and same-transaction audit protect the workflow.

## Interfaces

API base: `/api/v1/modules/admissions`. GET: `/enquiries`, `/applications`. POST: `/enquiries`, `/applications`, `/applications/decision`, `/applications/accept`. Every mutation has a corresponding declarative screen form and an OpenAPI request schema.

Run `pnpm test` with app and migration database URLs pointing to an isolated PostgreSQL database after applying core, Academic, and this module's migrations. Tests cover acceptance races, tenant/role/erased-identity boundaries, stored RLS/composite references, audit, and real loaded page choices.
