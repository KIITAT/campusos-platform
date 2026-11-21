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
-- under the new one; the new table is empty.
--
-- Rollback (forward-only; decision 162): restore the pre-upgrade backup with
-- the previous fees version. Otherwise a later migration that, after checking
--   select program_id, term_id, label from fee_items
--    group by 1, 2, 3 having count(*) > 1;   -- must return no rows
-- (else delete or relabel the batch and category lines first), runs:
--   DROP TABLE fee_late_fees;
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
CREATE UNIQUE INDEX "fee_late_fees_slab" ON "fee_late_fees" USING btree ("term_id","after_days");--> statement-breakpoint
CREATE POLICY "fee_late_fees_tenant_isolation" ON "fee_late_fees" AS PERMISSIVE FOR ALL TO "campusos_app" USING (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid) WITH CHECK (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid);
