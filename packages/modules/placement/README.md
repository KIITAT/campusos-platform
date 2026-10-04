# Placement

Institutional placement workflow built on Academic records: appointed officers,
companies, eligibility-gated drives, self-service student applications, ordered
selection rounds and offers. Seven declared pages and twelve API routes provide
the working web/mobile surface; see `SCREENS.md`.

Student eligibility uses active/completed programme declarations and published
course completions. Grade averages follow Academic's credit-weighted graded
passes; uncleared backlogs count distinct failed courses without a later pass.
Missing grades fail a positive CGPA threshold. Eligibility is rechecked before
issuing an offer, and all configured rounds must have passed in order.

Faculty/HOD actors need an active appointment and a current staff identity.
Revoking an appointment after demotion/erasure remains possible without granting
access. Students see their own records and may withdraw active applications or
accept/decline their own offer. One accepted offer per student is enforced by a
database uniqueness rule and serialized acceptance; results/offers cannot be
silently overwritten. Every mutation is audited in its tenant transaction.

The initial migration enables tenant RLS and tenant/identity reference guards.
Run the tests with a non-owner app database URL after core, Academic and Placement
migrations. Tests cover lifecycle, academic eligibility, isolation, role erasure,
ordered rounds, concurrent acceptance, direct database guards and actual pages.

No recruiter/public portal, external employer integration or accepted-offer
rescission is included. Workspace lists are bounded to 1,000 records; aggregate
statistics cover the complete institution.
