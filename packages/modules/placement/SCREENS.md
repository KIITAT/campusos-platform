# Placement screens and workflows

All seven declared pages are implemented: workspace `/`, `/companies`,
`/drives`, `/applications`, `/offers`, `/statistics` and `/officers`.
Administrators appoint faculty/HOD placement officers; unappointed staff cannot
load operational data. Students see only their own applications/results/offers.

1. Add an employer and draft a drive, optionally limiting its academic programme.
2. Open the drive with a future deadline. Students apply as themselves.
3. Eligibility is checked against active/completed programme declarations and
   academic course completions, never student-supplied grades. CGPA follows the
   existing degree audit's credit-weighted graded passes. A missing average
   fails a positive threshold; failed courses subsequently passed are not backlogs.
4. Add ordered selection rounds, then record pass/fail and panel reasons.
   Earlier rounds must pass; saved results are immutable.
5. Issue an offer only after all rounds pass and current academic eligibility
   is rechecked. Annual compensation is integer paise, not a bank payment.
6. The applicant accepts or declines. A row lock and database uniqueness rule
   allow at most one accepted offer per student, including concurrent requests.
7. Officers view institution statistics; students may withdraw active
   applications, but cannot rewrite decisions or someone else's records.

Create/apply/selection/offer actions use the module's documented routes. Every
mutation writes an audit record in the same transaction. Draft/open/closed
drives cannot reopen after closure. Duplicate applications and identical offer
responses are idempotent; changing an issued offer or result is refused.

Workspace lists are bounded to 1,000 records. Dedicated aggregate statistics
cover all records. Recruiter accounts, public vacancy portals, accepted-offer
rescission, document uploads and external employer integrations are not part
of this institutional workflow.
