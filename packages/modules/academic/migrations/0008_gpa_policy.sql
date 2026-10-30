-- P0-09: grade point average rules by date (FUNC-03, decisions 214 and 215).
--
-- A rule says whether a failed course counts its credits at zero points and
-- which attempt of a repeated course counts. The rule for an attempt is the
-- one in force on its term's first day, so a rule never reaches back into a
-- term that started before it.
--
-- Every institution that already has results gets two rows: today's rule
-- (failed credits left out, every passed attempt counted) from the beginning,
-- and the corrected rule (failed credits at zero, the latest attempt) from the
-- day of this upgrade. Results published before the upgrade read exactly as
-- they did. An institution with no results gets no row: the corrected rule.
--
-- Pre-flight: none needed (a new table; the seed reads completions only).
-- Rollback: to go back to the old figures, delete only the row this migration
-- added: delete from academic_gpa_policies where failed_credits = 'zero' and
-- repeats = 'latest' and effective_from = '<upgrade day>'; (the legacy row then
-- applies to every term). Drop the table only after academic, examinations,
-- placement, fees, ceremonies, mentoring and parents are all back at their
-- pre-P0-09 versions: each of them reads it.

CREATE TABLE "academic_gpa_policies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"institution_id" uuid NOT NULL,
	"effective_from" date NOT NULL,
	"failed_credits" text NOT NULL,
	"repeats" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "academic_gpa_policies_failed" CHECK (failed_credits in ('exclude', 'zero')),
	CONSTRAINT "academic_gpa_policies_repeats" CHECK (repeats in ('all', 'latest', 'best'))
);
--> statement-breakpoint
ALTER TABLE "academic_gpa_policies" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "academic_gpa_policies" ADD CONSTRAINT "academic_gpa_policies_institution_id_institutions_id_fk" FOREIGN KEY ("institution_id") REFERENCES "public"."institutions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "academic_gpa_policies_from" ON "academic_gpa_policies" USING btree ("institution_id","effective_from");--> statement-breakpoint
CREATE POLICY "academic_gpa_policies_tenant_isolation" ON "academic_gpa_policies" AS PERMISSIVE FOR ALL TO "campusos_app" USING (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid) WITH CHECK (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid);--> statement-breakpoint
INSERT INTO "academic_gpa_policies" ("institution_id", "effective_from", "failed_credits", "repeats")
SELECT DISTINCT institution_id, DATE '0001-01-01', 'exclude', 'all' FROM academic_course_completions;--> statement-breakpoint
INSERT INTO "academic_gpa_policies" ("institution_id", "effective_from", "failed_credits", "repeats")
SELECT DISTINCT institution_id, current_date, 'zero', 'latest' FROM academic_course_completions;
