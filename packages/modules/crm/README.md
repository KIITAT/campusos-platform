# Sales CRM

Leads, opportunities and a sales pipeline for companies that sell. A won opportunity becomes a finance customer and a draft quotation without retyping. Separate from admissions: an admissions enquiry is about a prospective student; a CRM lead is a business contact. CRM reads and writes no `admissions_*` table.

## Who sees what (decision 396)

`ownersOf(tx, actor)` in `api/settings.ts` is the only place the rule lives. An administrator sees everything. Anyone else sees the leads owned by themself and by the members of every team they manage. A person who is in no team (and manages none) gets 403 `not_in_sales_team`. A lead outside the actor's set answers 404 `not_found`, not 403, so its existence is not confirmed. Lists filter by the same set in SQL. Teams, stages and lost reasons are set by administrators only; a person belongs to at most one team.

## Lifecycle

A lead has no stage. Qualifying it makes it an opportunity at the first active stage. `won` and `lost` are statuses, not stages; losing needs an active lost reason. Defaults (New, Qualified, Proposition, Negotiation; three lost reasons) are created by the first lead in an institution.

## Conversion and the party match rule (decision 404)

`POST /leads/convert` runs in one transaction under a row lock: it finds or creates a customer in finance and creates a **draft** quotation (one line: the lead's item, quantity 1, the expected value as the rate). It never submits the quotation and never sets bank details, a credit limit or the supplier flag. A party with the lead's GSTIN is never duplicated (409 `party_exists`, and 409 `gstin_taken` even with "create a new customer anyway"); a customer with the same e-mail stops a silent duplicate but can be overridden. Pick an existing customer with `partyId`.

## Personal data (decisions 405 to 408)

A contact is not a user. A staff member's DPDP export shows that they owned or worked a lead, never the contact's data. `POST /leads/erase` (administrators, with a reason that is a request reference) clears the contact and the activity summaries; the finance customer made from it stays, as a financial record. `dpdp_retention.purge_crm` anonymises a lead idle for 730 days the same way. No contact data goes to the audit log or into a notification. P1-08b's guardian-consent rules apply to students who are minors and not to CRM contacts; whether a privacy notice must be sent to a business contact is counsel's question.

## Reminders

The job `crm.activity-reminders` runs every 15 minutes and sends each due activity's reminder once, to its assignee, through notices (`moduleId: 'crm'`, category `Sales CRM`). The text carries the kind and the time only.

API base: `/api/v1/modules/crm`. GET `/settings`, `/pipeline`, `/leads/detail?id=…`. POST `/stages`, `/stages/update`, `/lost-reasons`, `/lost-reasons/archive`, `/teams`, `/teams/members`, `/teams/members/remove`, `/leads`, `/leads/update`, `/leads/qualify`, `/leads/stage`, `/leads/assign`, `/leads/won`, `/leads/lost`, `/leads/reopen`, `/leads/convert`, `/leads/erase`, `/activities`, `/activities/done`.

Run `pnpm test` against isolated PostgreSQL after core and module migrations. Tests cover RLS, the visibility rule (positive and negative), the lifecycle, paging, reminders (once, opted out, concurrent), conversion (no silent duplicate, forced interleaving), erasure and the screens by role and state.
