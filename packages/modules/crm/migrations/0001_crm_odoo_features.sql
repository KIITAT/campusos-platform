-- crm 0.2.0: stage probability, priority, contact history, next-activity scripts,
-- round-robin teams, two more activity kinds.
ALTER TABLE "crm_stages" ADD COLUMN "probability" integer NOT NULL DEFAULT 10;--> statement-breakpoint
ALTER TABLE "crm_stages" ADD CONSTRAINT "crm_stage_probability" CHECK (probability between 0 and 100);--> statement-breakpoint
UPDATE "crm_stages" SET "probability" = CASE name WHEN 'New' THEN 10 WHEN 'Qualified' THEN 30 WHEN 'Proposition' THEN 60 WHEN 'Negotiation' THEN 80 ELSE 10 END;--> statement-breakpoint
ALTER TABLE "crm_leads" ADD COLUMN "priority" integer NOT NULL DEFAULT 0;--> statement-breakpoint
ALTER TABLE "crm_leads" ADD CONSTRAINT "crm_lead_priority" CHECK (priority between 0 and 3);--> statement-breakpoint
ALTER TABLE "crm_teams" ADD COLUMN "auto_assign" boolean NOT NULL DEFAULT false;--> statement-breakpoint
ALTER TABLE "crm_activities" DROP CONSTRAINT "crm_activity_kind";--> statement-breakpoint
ALTER TABLE "crm_activities" ADD CONSTRAINT "crm_activity_kind" CHECK (kind in ('call','meeting','task','email','quotation'));--> statement-breakpoint
CREATE TABLE "crm_notes" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "institution_id" uuid NOT NULL REFERENCES "public"."institutions"("id") ON DELETE cascade,
  "lead_id" uuid NOT NULL,
  "kind" text NOT NULL DEFAULT 'note',
  "body" text NOT NULL,
  "author_id" text NOT NULL REFERENCES "public"."users"("id"),
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  FOREIGN KEY ("institution_id","lead_id") REFERENCES "crm_leads"("institution_id","id") ON DELETE cascade,
  CONSTRAINT "crm_note_kind" CHECK (kind in ('note','system')),
  CONSTRAINT "crm_note_body" CHECK (length(body) between 1 and 4000)
);--> statement-breakpoint
CREATE INDEX "crm_notes_lead" ON "crm_notes" ("institution_id","lead_id","created_at");--> statement-breakpoint
CREATE TABLE "crm_activity_scripts" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "institution_id" uuid NOT NULL REFERENCES "public"."institutions"("id") ON DELETE cascade,
  "after_kind" text NOT NULL,
  "next_kind" text NOT NULL,
  "after_days" integer NOT NULL DEFAULT 1,
  "summary" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "crm_script_kinds" CHECK (after_kind in ('call','meeting','task','email','quotation') and next_kind in ('call','meeting','task','email','quotation')),
  CONSTRAINT "crm_script_days" CHECK (after_days between 0 and 90),
  CONSTRAINT "crm_script_summary" CHECK (length(summary) between 1 and 500)
);--> statement-breakpoint
CREATE UNIQUE INDEX "crm_activity_scripts_after" ON "crm_activity_scripts" ("institution_id","after_kind");--> statement-breakpoint
ALTER TABLE "crm_notes" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "crm_activity_scripts" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "crm_notes_tenant_isolation" ON "crm_notes" AS PERMISSIVE FOR ALL TO "campusos_app" USING (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid) WITH CHECK (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "crm_activity_scripts_tenant_isolation" ON "crm_activity_scripts" AS PERMISSIVE FOR ALL TO "campusos_app" USING (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid) WITH CHECK (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid);--> statement-breakpoint
CREATE OR REPLACE FUNCTION dpdp_retention.purge_crm(inst uuid)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE ids uuid[]; n_leads integer; n_acts integer; n_notes integer;
BEGIN
  SELECT coalesce(array_agg(id), '{}') INTO ids FROM crm_leads
   WHERE institution_id = inst AND erased_at IS NULL AND updated_at < now() - interval '730 days';
  UPDATE crm_activities SET summary = '[erased]' WHERE lead_id = ANY (ids) AND summary <> '[erased]';
  GET DIAGNOSTICS n_acts = ROW_COUNT;
  UPDATE crm_notes SET body = '[erased]' WHERE lead_id = ANY (ids) AND body <> '[erased]';
  GET DIAGNOSTICS n_notes = ROW_COUNT;
  UPDATE crm_leads SET title = '[erased]', company = NULL, contact_name = NULL, email = NULL, phone = NULL,
         gstin = NULL, notes = NULL, lost_note = NULL, erased_at = now()
   WHERE id = ANY (ids);
  GET DIAGNOSTICS n_leads = ROW_COUNT;
  RETURN jsonb_build_object('crm_leads', n_leads, 'crm_activities', n_acts, 'crm_notes', n_notes);
END
$$;
