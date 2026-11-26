-- P1-03d: fee structures by batch and category, instalments, late fees (ACC-21).
--
-- A fee line may be for one batch (admission year) and one reservation category
-- (the codes of academic_student_profiles.category, P1-12a); a student is
-- charged the most specific line of each label (fees priceListSql). An
-- instalment is a line with a due date (the existing due_on). Late-fee rules
-- per term raise a student charge once per instalment still unpaid after_days
-- after its due date.
--
-- Pre-flight: none needed. The new columns are nullable and every existing
-- row keeps both null, which the new CHECKs accept; the re-made identity index
-- adds key columns, so every set of rows unique under the old index is unique
-- under the new one; the new table is empty. fee_invoices.versions_issued_at
-- is filled for every existing invoice: version 1 at issued_at, any later
-- version at the time of this upgrade (the day it was really issued is not
-- kept in fees; later is the side that never raises a late fee early).
-- fee_invoices.owed_at and owed_dues are filled with one entry at issued_at, per
-- due date where the lines can be told (see the UPDATE), else as one figure that
-- counts at every instalment day (the key 'undated'): the most a late fee could
-- be judged on (a rule never reaches back before the day it was made). The
-- UPDATE reads each invoice's lines, so it runs with no statement timeout.
--
-- Rollback (forward-only; decision 162): restore the pre-upgrade backup with
-- the previous fees version. Otherwise a later migration that, after checking
--   select program_id, term_id, label from fee_items
--    group by 1, 2, 3 having count(*) > 1;   -- must return no rows
-- (else delete or relabel the batch and category lines first), runs:
--   DROP TABLE fee_late_fees;
--   ALTER TABLE fee_invoices DROP CONSTRAINT fee_invoices_versions, DROP COLUMN versions_issued_at;
--   ALTER TABLE fee_invoices DROP CONSTRAINT fee_invoices_owed, DROP COLUMN owed_at, DROP COLUMN owed_dues;
--   DROP INDEX fee_items_identity;
--   ALTER TABLE fee_items DROP COLUMN admission_year, DROP COLUMN category;
--   CREATE UNIQUE INDEX fee_items_identity ON fee_items (program_id, term_id, label);
-- Late-fee student charges already raised stay (source_id 'late:...').

ALTER TABLE "fee_items" ADD COLUMN "admission_year" smallint;--> statement-breakpoint
ALTER TABLE "fee_items" ADD COLUMN "category" text;--> statement-breakpoint
ALTER TABLE "fee_items" ADD CONSTRAINT "fee_items_admission_year" CHECK (admission_year is null or admission_year between 1900 and 2200);--> statement-breakpoint
ALTER TABLE "fee_items" ADD CONSTRAINT "fee_items_category" CHECK (category is null or category in ('general','ews','obc','sc','st'));--> statement-breakpoint
DROP INDEX "fee_items_identity";--> statement-breakpoint
CREATE UNIQUE INDEX "fee_items_identity" ON "fee_items" USING btree ("program_id","term_id","label",coalesce("admission_year", 0),coalesce("category", ''));--> statement-breakpoint

CREATE TABLE "fee_late_fees" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"institution_id" uuid NOT NULL,
	"term_id" uuid NOT NULL,
	"after_days" smallint NOT NULL,
	"amount_paise" bigint NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "fee_late_fees_days" CHECK (after_days between 0 and 365),
	CONSTRAINT "fee_late_fees_amount" CHECK (amount_paise between 1 and 10000000)
);
--> statement-breakpoint
ALTER TABLE "fee_late_fees" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "fee_late_fees" ADD CONSTRAINT "fee_late_fees_institution_id_institutions_id_fk" FOREIGN KEY ("institution_id") REFERENCES "public"."institutions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fee_late_fees" ADD CONSTRAINT "fee_late_fees_term_id_academic_terms_id_fk" FOREIGN KEY ("term_id") REFERENCES "public"."academic_terms"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fee_late_fees" ADD CONSTRAINT "fee_late_fees_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
-- When each version of an invoice was issued, so a late fee judges a cutoff on
-- what had been invoiced to the student by then (P1-03d second review).
ALTER TABLE "fee_invoices" ADD COLUMN "versions_issued_at" timestamp with time zone[] NOT NULL DEFAULT ARRAY[now()];--> statement-breakpoint
UPDATE "fee_invoices" SET "versions_issued_at" = ARRAY["issued_at"] || array_fill(now(), ARRAY["version" - 1]);--> statement-breakpoint
ALTER TABLE "fee_invoices" ADD CONSTRAINT "fee_invoices_versions" CHECK (cardinality(versions_issued_at) = version);--> statement-breakpoint
-- What the invoice asked for, net of posted waivers, after each issue, each
-- waiver change and each void: what was owed as at a day. owed_dues[k] says it
-- per due date: {"2026-10-17": net paise of the lines due that day, "undated": net
-- of the lines with no due date}; a void is an empty object. The figure for an
-- instalment is the sum of the keys up to its day, plus 'undated'.
ALTER TABLE "fee_invoices" ADD COLUMN "owed_at" timestamp with time zone[] NOT NULL DEFAULT '{}';--> statement-breakpoint
ALTER TABLE "fee_invoices" ADD COLUMN "owed_dues" jsonb[] NOT NULL DEFAULT '{}';--> statement-breakpoint
-- One entry per invoice at issued_at, per due date: before this migration a fee line has no batch
-- or category and is unique per programme, term and label, so what the invoice asked for is the
-- student's declared programmes' lines for the term (the filter of priceListSql), each less the
-- waiver posted against it, plus the student's own charges as 'undated'. Where that does not add
-- up to the invoice's total less the waivers posted (a line added or corrected since it was issued,
-- or a student invoiced under a section roster), the invoice has no dates to give and asks for
-- its whole total at every instalment day: the most a late fee could be judged on.
SET LOCAL statement_timeout = 0;--> statement-breakpoint
WITH "calc" AS (SELECT i."id",
  CASE WHEN d."total" = i."charged_paise" - p."posted" THEN d."dues"
       ELSE jsonb_build_object('undated', i."charged_paise" - p."posted") END AS "dues"
  FROM "fee_invoices" i JOIN "academic_terms" t ON t."id" = i."term_id",
  LATERAL (SELECT coalesce(sum(w."posted_paise"), 0)::bigint AS "posted" FROM "fee_waivers" w JOIN "fee_items" f ON f."id" = w."fee_item_id"
            WHERE w."student_id" = i."student_id" AND f."term_id" = i."term_id") p,
  LATERAL (SELECT jsonb_object_agg(g."k", g."net") AS "dues", sum(g."net")::bigint AS "total"
             FROM (SELECT u."k", sum(u."net")::bigint AS "net"
                     FROM (SELECT coalesce((f."due_on" AT TIME ZONE 'UTC')::date::text, 'undated') AS "k", f."amount_paise" - coalesce(w."posted_paise", 0) AS "net"
                             FROM (SELECT DISTINCT sp."program_id" FROM "academic_student_programs" sp
                                    WHERE sp."student_id" = i."student_id" AND sp."declared_on" <= t."ends_on"
                                      AND (sp."ended_on" IS NULL OR sp."ended_on" > t."starts_on")
                                      AND (sp."ended_on" IS NULL OR sp."ended_on" > sp."declared_on")) e
                             JOIN "fee_items" f ON f."program_id" = e."program_id" AND f."term_id" = i."term_id"
                             LEFT JOIN "fee_waivers" w ON w."fee_item_id" = f."id" AND w."student_id" = i."student_id"
                           UNION ALL
                           SELECT 'undated', c."amount_paise" FROM "fee_student_charges" c
                            WHERE c."student_id" = i."student_id" AND c."term_id" = i."term_id" AND c."cancelled_at" IS NULL) u
                    GROUP BY u."k") g) d)
UPDATE "fee_invoices" i SET "owed_at" = ARRAY[i."issued_at"], "owed_dues" = ARRAY[calc."dues"] FROM "calc" WHERE calc."id" = i."id";--> statement-breakpoint
ALTER TABLE "fee_invoices" ADD CONSTRAINT "fee_invoices_owed" CHECK (cardinality(owed_at) = cardinality(owed_dues));--> statement-breakpoint
CREATE UNIQUE INDEX "fee_late_fees_slab" ON "fee_late_fees" USING btree ("term_id","after_days");--> statement-breakpoint
CREATE POLICY "fee_late_fees_tenant_isolation" ON "fee_late_fees" AS PERMISSIVE FOR ALL TO "campusos_app" USING (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid) WITH CHECK (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid);
