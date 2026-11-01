-- P2-16: sales CRM (MG-65; decisions 390 to 409).
-- Rollback (nothing else depends on these):
--   DROP FUNCTION IF EXISTS dpdp_retention.purge_crm(uuid);
--   DROP TABLE IF EXISTS crm_activities, crm_leads, crm_team_members, crm_teams, crm_lost_reasons, crm_stages;
DO $$
BEGIN
  IF to_regclass('public.finance_parties') IS NULL OR to_regclass('public.finance_orders') IS NULL THEN
    RAISE EXCEPTION 'the finance module must be installed first';
  END IF;
  IF to_regnamespace('dpdp_retention') IS NULL THEN
    RAISE EXCEPTION 'core migration 0016 (retention) must be applied first';
  END IF;
END $$;
--> statement-breakpoint
CREATE TABLE "crm_stages" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "institution_id" uuid NOT NULL REFERENCES "public"."institutions"("id") ON DELETE cascade,
  "name" text NOT NULL,
  "seq" integer NOT NULL,
  "archived_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "crm_stage_name_text" CHECK (length(trim(name)) between 1 and 60),
  CONSTRAINT "crm_stage_seq" CHECK (seq between 1 and 999)
);--> statement-breakpoint
CREATE UNIQUE INDEX "crm_stages_name" ON "crm_stages" ("institution_id","name");--> statement-breakpoint
CREATE UNIQUE INDEX "crm_stages_tenant_id" ON "crm_stages" ("institution_id","id");--> statement-breakpoint
CREATE TABLE "crm_lost_reasons" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "institution_id" uuid NOT NULL REFERENCES "public"."institutions"("id") ON DELETE cascade,
  "name" text NOT NULL,
  "archived_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "crm_lost_reason_name_text" CHECK (length(trim(name)) between 2 and 120)
);--> statement-breakpoint
CREATE UNIQUE INDEX "crm_lost_reasons_name" ON "crm_lost_reasons" ("institution_id","name");--> statement-breakpoint
CREATE UNIQUE INDEX "crm_lost_reasons_tenant_id" ON "crm_lost_reasons" ("institution_id","id");--> statement-breakpoint
CREATE TABLE "crm_teams" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "institution_id" uuid NOT NULL REFERENCES "public"."institutions"("id") ON DELETE cascade,
  "name" text NOT NULL,
  "manager_id" text NOT NULL REFERENCES "public"."users"("id"),
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "crm_team_name_text" CHECK (length(trim(name)) between 2 and 80)
);--> statement-breakpoint
CREATE UNIQUE INDEX "crm_teams_name" ON "crm_teams" ("institution_id","name");--> statement-breakpoint
CREATE UNIQUE INDEX "crm_teams_tenant_id" ON "crm_teams" ("institution_id","id");--> statement-breakpoint
CREATE INDEX "crm_teams_manager" ON "crm_teams" ("institution_id","manager_id");--> statement-breakpoint
CREATE TABLE "crm_team_members" (
  "institution_id" uuid NOT NULL REFERENCES "public"."institutions"("id") ON DELETE cascade,
  "team_id" uuid NOT NULL,
  "user_id" text NOT NULL REFERENCES "public"."users"("id"),
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  PRIMARY KEY ("team_id","user_id"),
  FOREIGN KEY ("institution_id","team_id") REFERENCES "crm_teams"("institution_id","id") ON DELETE cascade
);--> statement-breakpoint
CREATE UNIQUE INDEX "crm_team_members_user" ON "crm_team_members" ("institution_id","user_id");--> statement-breakpoint
CREATE TABLE "crm_leads" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "institution_id" uuid NOT NULL REFERENCES "public"."institutions"("id") ON DELETE cascade,
  "kind" text NOT NULL DEFAULT 'lead',
  "status" text NOT NULL DEFAULT 'open',
  "title" text NOT NULL,
  "company" text,
  "contact_name" text,
  "email" text,
  "phone" text,
  "gstin" text,
  "source" text NOT NULL,
  "notes" text,
  "owner_id" text NOT NULL REFERENCES "public"."users"("id"),
  "stage_id" uuid,
  "item_id" uuid,
  "expected_value_paise" bigint,
  "expected_close" date,
  "lost_reason_id" uuid,
  "lost_note" text,
  "won_at" timestamp with time zone,
  "closed_at" timestamp with time zone,
  "party_id" uuid REFERENCES "public"."finance_parties"("id"),
  "quotation_id" uuid REFERENCES "public"."finance_orders"("id") ON DELETE set null,
  "converted_at" timestamp with time zone,
  "erased_at" timestamp with time zone,
  "created_by" text NOT NULL REFERENCES "public"."users"("id"),
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  FOREIGN KEY ("institution_id","stage_id") REFERENCES "crm_stages"("institution_id","id"),
  FOREIGN KEY ("institution_id","lost_reason_id") REFERENCES "crm_lost_reasons"("institution_id","id"),
  CONSTRAINT "crm_lead_kind" CHECK (kind in ('lead','opportunity')),
  CONSTRAINT "crm_lead_status" CHECK (status in ('open','won','lost')),
  CONSTRAINT "crm_lead_source" CHECK (source in ('website','referral','event','cold_call','existing_customer','other')),
  CONSTRAINT "crm_lead_stage" CHECK ((kind = 'lead') = (stage_id is null)),
  CONSTRAINT "crm_lead_won" CHECK (status <> 'won' or (kind = 'opportunity' and won_at is not null)),
  CONSTRAINT "crm_lead_lost" CHECK ((status = 'lost') = (lost_reason_id is not null)),
  CONSTRAINT "crm_lead_converted" CHECK (party_id is null or (status = 'won' and converted_at is not null)),
  CONSTRAINT "crm_lead_value" CHECK (expected_value_paise is null or expected_value_paise >= 0),
  CONSTRAINT "crm_lead_gstin" CHECK (gstin is null or gstin ~ '^[0-9]{2}[A-Z0-9]{10}[0-9A-Z]Z[0-9A-Z]$')
);--> statement-breakpoint
CREATE UNIQUE INDEX "crm_leads_tenant_id" ON "crm_leads" ("institution_id","id");--> statement-breakpoint
CREATE INDEX "crm_leads_owner" ON "crm_leads" ("institution_id","owner_id","status");--> statement-breakpoint
CREATE INDEX "crm_leads_updated" ON "crm_leads" ("institution_id","updated_at");--> statement-breakpoint
CREATE TABLE "crm_activities" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "institution_id" uuid NOT NULL REFERENCES "public"."institutions"("id") ON DELETE cascade,
  "lead_id" uuid NOT NULL,
  "kind" text NOT NULL,
  "summary" text NOT NULL,
  "due_at" timestamp with time zone NOT NULL,
  "remind_at" timestamp with time zone,
  "assignee_id" text NOT NULL REFERENCES "public"."users"("id"),
  "done_at" timestamp with time zone,
  "reminded_at" timestamp with time zone,
  "created_by" text NOT NULL REFERENCES "public"."users"("id"),
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  FOREIGN KEY ("institution_id","lead_id") REFERENCES "crm_leads"("institution_id","id") ON DELETE cascade,
  CONSTRAINT "crm_activity_kind" CHECK (kind in ('call','meeting','task')),
  CONSTRAINT "crm_activity_summary" CHECK (length(summary) between 1 and 500),
  CONSTRAINT "crm_activity_remind" CHECK (remind_at is null or remind_at <= due_at)
);--> statement-breakpoint
CREATE INDEX "crm_activities_lead" ON "crm_activities" ("institution_id","lead_id");--> statement-breakpoint
CREATE INDEX "crm_activities_due_reminders" ON "crm_activities" ("remind_at") WHERE reminded_at IS NULL AND done_at IS NULL AND remind_at IS NOT NULL;--> statement-breakpoint
ALTER TABLE "crm_stages" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "crm_lost_reasons" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "crm_teams" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "crm_team_members" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "crm_leads" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "crm_activities" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "crm_stages_tenant_isolation" ON "crm_stages" AS PERMISSIVE FOR ALL TO "campusos_app" USING (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid) WITH CHECK (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "crm_lost_reasons_tenant_isolation" ON "crm_lost_reasons" AS PERMISSIVE FOR ALL TO "campusos_app" USING (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid) WITH CHECK (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "crm_teams_tenant_isolation" ON "crm_teams" AS PERMISSIVE FOR ALL TO "campusos_app" USING (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid) WITH CHECK (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "crm_team_members_tenant_isolation" ON "crm_team_members" AS PERMISSIVE FOR ALL TO "campusos_app" USING (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid) WITH CHECK (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "crm_leads_tenant_isolation" ON "crm_leads" AS PERMISSIVE FOR ALL TO "campusos_app" USING (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid) WITH CHECK (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "crm_activities_tenant_isolation" ON "crm_activities" AS PERMISSIVE FOR ALL TO "campusos_app" USING (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid) WITH CHECK (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid);--> statement-breakpoint
CREATE OR REPLACE FUNCTION dpdp_retention.purge_crm(inst uuid)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE ids uuid[]; n_leads integer; n_acts integer;
BEGIN
  SELECT coalesce(array_agg(id), '{}') INTO ids FROM crm_leads
   WHERE institution_id = inst AND erased_at IS NULL AND updated_at < now() - interval '730 days';
  UPDATE crm_activities SET summary = '[erased]' WHERE lead_id = ANY (ids) AND summary <> '[erased]';
  GET DIAGNOSTICS n_acts = ROW_COUNT;
  UPDATE crm_leads SET title = '[erased]', company = NULL, contact_name = NULL, email = NULL, phone = NULL,
         gstin = NULL, notes = NULL, lost_note = NULL, erased_at = now()
   WHERE id = ANY (ids);
  GET DIAGNOSTICS n_leads = ROW_COUNT;
  RETURN jsonb_build_object('crm_leads', n_leads, 'crm_activities', n_acts);
END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION dpdp_retention.purge_crm(uuid) FROM PUBLIC;
