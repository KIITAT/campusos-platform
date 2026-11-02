-- P2-14: projects, stages, milestones, tasks, timesheets, and their billing and costing (MG-62, MG-63).
-- A project's money is in finance under its cost centre; this module keeps the work, who did it, and
-- which invoice and journal entry each line of time went into.
--
-- Rollback:
--   DROP TABLE IF EXISTS projects_idempotency_keys, projects_timesheets, projects_billings, projects_costings,
--     projects_tasks, projects_milestones, projects_stages, projects_members, projects_cost_rates, projects_projects;
--   DROP FUNCTION IF EXISTS public.projects_timesheet_guard(), public.projects_record_guard();
--   Invoices and journal entries already posted stay in finance.

DO $$
BEGIN
  IF to_regclass('public.finance_cost_centers') IS NULL OR to_regclass('public.finance_invoices') IS NULL
     OR to_regclass('public.finance_journal_entries') IS NULL OR to_regclass('public.finance_parties') IS NULL
     OR to_regclass('public.finance_funds') IS NULL OR to_regclass('public.finance_tax_templates') IS NULL THEN
    RAISE EXCEPTION 'projects needs the finance module installed first';
  END IF;
END $$;
--> statement-breakpoint
CREATE TABLE "projects_projects" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"institution_id" uuid NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"manager_id" text NOT NULL,
	"cost_center" text NOT NULL,
	"party_id" uuid,
	"billable" boolean DEFAULT false NOT NULL,
	"billing_rate_paise" bigint,
	"tax_template_id" uuid,
	"fund_id" uuid,
	"starts_on" date NOT NULL,
	"ends_on" date,
	"status" text DEFAULT 'active' NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "projects_projects_code_text" CHECK (code ~ '^[A-Z0-9-]{1,20}$'),
	CONSTRAINT "projects_projects_name_text" CHECK (length(trim(name)) BETWEEN 2 AND 200),
	CONSTRAINT "projects_projects_description_text" CHECK (description IS NULL OR length(description) <= 4000),
	CONSTRAINT "projects_projects_status" CHECK (status IN ('active', 'closed')),
	CONSTRAINT "projects_projects_rate" CHECK (billing_rate_paise IS NULL OR billing_rate_paise > 0),
	CONSTRAINT "projects_projects_billing" CHECK (NOT billable OR (party_id IS NOT NULL AND billing_rate_paise IS NOT NULL)),
	CONSTRAINT "projects_projects_dates" CHECK (ends_on IS NULL OR ends_on >= starts_on)
);
--> statement-breakpoint
CREATE TABLE "projects_members" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"institution_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"added_by" text NOT NULL,
	"added_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "projects_stages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"institution_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"name" text NOT NULL,
	"seq" integer NOT NULL,
	"closes" boolean DEFAULT false NOT NULL,
	CONSTRAINT "projects_stages_name_text" CHECK (length(trim(name)) BETWEEN 1 AND 60),
	CONSTRAINT "projects_stages_seq" CHECK (seq BETWEEN 1 AND 999)
);
--> statement-breakpoint
CREATE TABLE "projects_milestones" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"institution_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"name" text NOT NULL,
	"due_on" date,
	"reached_on" date,
	"reached_by" text,
	CONSTRAINT "projects_milestones_name_text" CHECK (length(trim(name)) BETWEEN 2 AND 120),
	CONSTRAINT "projects_milestones_reached" CHECK ((reached_on IS NULL) = (reached_by IS NULL))
);
--> statement-breakpoint
CREATE TABLE "projects_tasks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"institution_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"stage_id" uuid NOT NULL,
	"milestone_id" uuid,
	"title" text NOT NULL,
	"description" text,
	"assignee_id" text,
	"deadline" date,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "projects_tasks_title_text" CHECK (length(trim(title)) BETWEEN 2 AND 200),
	CONSTRAINT "projects_tasks_description_text" CHECK (description IS NULL OR length(description) <= 4000)
);
--> statement-breakpoint
CREATE TABLE "projects_cost_rates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"institution_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"effective_from" date NOT NULL,
	"hourly_cost_paise" bigint NOT NULL,
	"home_cost_center" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "projects_cost_rates_amount" CHECK (hourly_cost_paise >= 100),
	CONSTRAINT "projects_cost_rates_home" CHECK (home_cost_center IS NULL OR length(trim(home_cost_center)) BETWEEN 1 AND 80)
);
--> statement-breakpoint
CREATE TABLE "projects_billings" (
	"id" uuid PRIMARY KEY NOT NULL,
	"institution_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"through" date NOT NULL,
	"billed_on" date NOT NULL,
	"invoice_id" uuid NOT NULL,
	"amount_paise" bigint NOT NULL,
	"minutes" integer NOT NULL,
	"billed_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "projects_billings_amount" CHECK (amount_paise >= 0 AND minutes > 0)
);
--> statement-breakpoint
CREATE TABLE "projects_costings" (
	"id" uuid PRIMARY KEY NOT NULL,
	"institution_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"period" text NOT NULL,
	"posted_on" date NOT NULL,
	"entry_id" uuid NOT NULL,
	"amount_paise" bigint NOT NULL,
	"minutes" integer NOT NULL,
	"costed_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"reversed_at" timestamp with time zone,
	"reversed_by" text,
	"reversal_entry_id" uuid,
	"reverse_reason" text,
	CONSTRAINT "projects_costings_period" CHECK (period ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
	CONSTRAINT "projects_costings_amount" CHECK (amount_paise > 0 AND minutes > 0),
	CONSTRAINT "projects_costings_reversal" CHECK (
		(reversed_at IS NULL) = (reversed_by IS NULL) AND (reversed_at IS NULL) = (reversal_entry_id IS NULL)
		AND (reversed_at IS NULL) = (reverse_reason IS NULL))
);
--> statement-breakpoint
CREATE TABLE "projects_timesheets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"institution_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"task_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"work_date" date NOT NULL,
	"minutes" integer NOT NULL,
	"description" text NOT NULL,
	"status" text DEFAULT 'submitted' NOT NULL,
	"entered_by" text NOT NULL,
	"decided_by" text,
	"decided_at" timestamp with time zone,
	"decision_note" text,
	"billing_id" uuid,
	"costing_id" uuid,
	"cost_paise" bigint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "projects_timesheets_minutes" CHECK (minutes BETWEEN 15 AND 1440 AND minutes % 15 = 0),
	CONSTRAINT "projects_timesheets_status" CHECK (status IN ('submitted', 'approved', 'rejected')),
	CONSTRAINT "projects_timesheets_description_text" CHECK (length(trim(description)) BETWEEN 2 AND 500),
	CONSTRAINT "projects_timesheets_decision" CHECK (
		(status = 'submitted') = (decided_by IS NULL) AND (decided_by IS NULL) = (decided_at IS NULL)
		AND (status <> 'rejected' OR decision_note IS NOT NULL)),
	CONSTRAINT "projects_timesheets_settled_approved" CHECK ((billing_id IS NULL AND costing_id IS NULL) OR status = 'approved'),
	CONSTRAINT "projects_timesheets_cost" CHECK ((costing_id IS NULL) = (cost_paise IS NULL))
);
--> statement-breakpoint
CREATE TABLE "projects_idempotency_keys" (
	"institution_id" uuid NOT NULL,
	"actor_id" text NOT NULL,
	"operation" text NOT NULL,
	"key" text NOT NULL,
	"request_hash" text NOT NULL,
	"result_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "projects_idempotency_keys_pkey" PRIMARY KEY("institution_id","actor_id","operation","key"),
	CONSTRAINT "projects_idempotency_keys_key" CHECK (key ~ '^[A-Za-z0-9._:-]{8,128}$')
);
--> statement-breakpoint
CREATE UNIQUE INDEX "projects_projects_tenant_id" ON "projects_projects" USING btree ("institution_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "projects_projects_code" ON "projects_projects" USING btree ("institution_id","code");--> statement-breakpoint
CREATE UNIQUE INDEX "projects_projects_cost_center" ON "projects_projects" USING btree ("institution_id","cost_center");--> statement-breakpoint
CREATE UNIQUE INDEX "projects_members_person" ON "projects_members" USING btree ("institution_id","project_id","user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "projects_stages_tenant_id" ON "projects_stages" USING btree ("institution_id","project_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "projects_stages_name" ON "projects_stages" USING btree ("institution_id","project_id","name");--> statement-breakpoint
CREATE UNIQUE INDEX "projects_milestones_tenant_id" ON "projects_milestones" USING btree ("institution_id","project_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "projects_milestones_name" ON "projects_milestones" USING btree ("institution_id","project_id","name");--> statement-breakpoint
CREATE UNIQUE INDEX "projects_tasks_tenant_id" ON "projects_tasks" USING btree ("institution_id","project_id","id");--> statement-breakpoint
CREATE INDEX "projects_tasks_list" ON "projects_tasks" USING btree ("institution_id","project_id","created_at","id");--> statement-breakpoint
CREATE UNIQUE INDEX "projects_cost_rates_day" ON "projects_cost_rates" USING btree ("institution_id","user_id","effective_from");--> statement-breakpoint
CREATE UNIQUE INDEX "projects_billings_tenant_id" ON "projects_billings" USING btree ("institution_id","project_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "projects_billings_invoice" ON "projects_billings" USING btree ("invoice_id");--> statement-breakpoint
CREATE UNIQUE INDEX "projects_costings_tenant_id" ON "projects_costings" USING btree ("institution_id","project_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "projects_costings_entry" ON "projects_costings" USING btree ("entry_id");--> statement-breakpoint
CREATE INDEX "projects_timesheets_project" ON "projects_timesheets" USING btree ("institution_id","project_id","status");--> statement-breakpoint
CREATE INDEX "projects_timesheets_person" ON "projects_timesheets" USING btree ("institution_id","user_id","work_date");--> statement-breakpoint
CREATE INDEX "projects_timesheets_list" ON "projects_timesheets" USING btree ("institution_id","work_date","created_at","id");--> statement-breakpoint
ALTER TABLE "projects_projects" ADD CONSTRAINT "projects_projects_institution_fk" FOREIGN KEY ("institution_id") REFERENCES "public"."institutions"("id") ON DELETE cascade;--> statement-breakpoint
ALTER TABLE "projects_projects" ADD CONSTRAINT "projects_projects_manager_fk" FOREIGN KEY ("manager_id") REFERENCES "public"."users"("id") ON DELETE no action;--> statement-breakpoint
ALTER TABLE "projects_projects" ADD CONSTRAINT "projects_projects_created_by_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action;--> statement-breakpoint
ALTER TABLE "projects_projects" ADD CONSTRAINT "projects_projects_cost_center_fk" FOREIGN KEY ("institution_id","cost_center") REFERENCES "public"."finance_cost_centers"("institution_id","code") ON DELETE no action;--> statement-breakpoint
ALTER TABLE "projects_projects" ADD CONSTRAINT "projects_projects_party_fk" FOREIGN KEY ("party_id") REFERENCES "public"."finance_parties"("id") ON DELETE no action;--> statement-breakpoint
ALTER TABLE "projects_projects" ADD CONSTRAINT "projects_projects_tax_template_fk" FOREIGN KEY ("tax_template_id") REFERENCES "public"."finance_tax_templates"("id") ON DELETE no action;--> statement-breakpoint
ALTER TABLE "projects_projects" ADD CONSTRAINT "projects_projects_fund_fk" FOREIGN KEY ("fund_id") REFERENCES "public"."finance_funds"("id") ON DELETE no action;--> statement-breakpoint
ALTER TABLE "projects_members" ADD CONSTRAINT "projects_members_institution_fk" FOREIGN KEY ("institution_id") REFERENCES "public"."institutions"("id") ON DELETE cascade;--> statement-breakpoint
ALTER TABLE "projects_members" ADD CONSTRAINT "projects_members_project_fk" FOREIGN KEY ("institution_id","project_id") REFERENCES "public"."projects_projects"("institution_id","id") ON DELETE no action;--> statement-breakpoint
ALTER TABLE "projects_members" ADD CONSTRAINT "projects_members_user_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action;--> statement-breakpoint
ALTER TABLE "projects_members" ADD CONSTRAINT "projects_members_added_by_fk" FOREIGN KEY ("added_by") REFERENCES "public"."users"("id") ON DELETE no action;--> statement-breakpoint
ALTER TABLE "projects_stages" ADD CONSTRAINT "projects_stages_institution_fk" FOREIGN KEY ("institution_id") REFERENCES "public"."institutions"("id") ON DELETE cascade;--> statement-breakpoint
ALTER TABLE "projects_stages" ADD CONSTRAINT "projects_stages_project_fk" FOREIGN KEY ("institution_id","project_id") REFERENCES "public"."projects_projects"("institution_id","id") ON DELETE no action;--> statement-breakpoint
ALTER TABLE "projects_milestones" ADD CONSTRAINT "projects_milestones_institution_fk" FOREIGN KEY ("institution_id") REFERENCES "public"."institutions"("id") ON DELETE cascade;--> statement-breakpoint
ALTER TABLE "projects_milestones" ADD CONSTRAINT "projects_milestones_project_fk" FOREIGN KEY ("institution_id","project_id") REFERENCES "public"."projects_projects"("institution_id","id") ON DELETE no action;--> statement-breakpoint
ALTER TABLE "projects_milestones" ADD CONSTRAINT "projects_milestones_reached_by_fk" FOREIGN KEY ("reached_by") REFERENCES "public"."users"("id") ON DELETE no action;--> statement-breakpoint
ALTER TABLE "projects_tasks" ADD CONSTRAINT "projects_tasks_institution_fk" FOREIGN KEY ("institution_id") REFERENCES "public"."institutions"("id") ON DELETE cascade;--> statement-breakpoint
ALTER TABLE "projects_tasks" ADD CONSTRAINT "projects_tasks_project_fk" FOREIGN KEY ("institution_id","project_id") REFERENCES "public"."projects_projects"("institution_id","id") ON DELETE no action;--> statement-breakpoint
ALTER TABLE "projects_tasks" ADD CONSTRAINT "projects_tasks_stage_fk" FOREIGN KEY ("institution_id","project_id","stage_id") REFERENCES "public"."projects_stages"("institution_id","project_id","id") ON DELETE no action;--> statement-breakpoint
ALTER TABLE "projects_tasks" ADD CONSTRAINT "projects_tasks_milestone_fk" FOREIGN KEY ("institution_id","project_id","milestone_id") REFERENCES "public"."projects_milestones"("institution_id","project_id","id") ON DELETE no action;--> statement-breakpoint
ALTER TABLE "projects_tasks" ADD CONSTRAINT "projects_tasks_assignee_fk" FOREIGN KEY ("assignee_id") REFERENCES "public"."users"("id") ON DELETE no action;--> statement-breakpoint
ALTER TABLE "projects_tasks" ADD CONSTRAINT "projects_tasks_created_by_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action;--> statement-breakpoint
ALTER TABLE "projects_cost_rates" ADD CONSTRAINT "projects_cost_rates_institution_fk" FOREIGN KEY ("institution_id") REFERENCES "public"."institutions"("id") ON DELETE cascade;--> statement-breakpoint
ALTER TABLE "projects_cost_rates" ADD CONSTRAINT "projects_cost_rates_user_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action;--> statement-breakpoint
ALTER TABLE "projects_billings" ADD CONSTRAINT "projects_billings_institution_fk" FOREIGN KEY ("institution_id") REFERENCES "public"."institutions"("id") ON DELETE cascade;--> statement-breakpoint
ALTER TABLE "projects_billings" ADD CONSTRAINT "projects_billings_project_fk" FOREIGN KEY ("institution_id","project_id") REFERENCES "public"."projects_projects"("institution_id","id") ON DELETE no action;--> statement-breakpoint
ALTER TABLE "projects_billings" ADD CONSTRAINT "projects_billings_invoice_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."finance_invoices"("id") ON DELETE no action;--> statement-breakpoint
ALTER TABLE "projects_billings" ADD CONSTRAINT "projects_billings_billed_by_fk" FOREIGN KEY ("billed_by") REFERENCES "public"."users"("id") ON DELETE no action;--> statement-breakpoint
ALTER TABLE "projects_costings" ADD CONSTRAINT "projects_costings_institution_fk" FOREIGN KEY ("institution_id") REFERENCES "public"."institutions"("id") ON DELETE cascade;--> statement-breakpoint
ALTER TABLE "projects_costings" ADD CONSTRAINT "projects_costings_project_fk" FOREIGN KEY ("institution_id","project_id") REFERENCES "public"."projects_projects"("institution_id","id") ON DELETE no action;--> statement-breakpoint
ALTER TABLE "projects_costings" ADD CONSTRAINT "projects_costings_entry_fk" FOREIGN KEY ("entry_id") REFERENCES "public"."finance_journal_entries"("id") ON DELETE no action;--> statement-breakpoint
ALTER TABLE "projects_costings" ADD CONSTRAINT "projects_costings_reversal_fk" FOREIGN KEY ("reversal_entry_id") REFERENCES "public"."finance_journal_entries"("id") ON DELETE no action;--> statement-breakpoint
ALTER TABLE "projects_costings" ADD CONSTRAINT "projects_costings_costed_by_fk" FOREIGN KEY ("costed_by") REFERENCES "public"."users"("id") ON DELETE no action;--> statement-breakpoint
ALTER TABLE "projects_costings" ADD CONSTRAINT "projects_costings_reversed_by_fk" FOREIGN KEY ("reversed_by") REFERENCES "public"."users"("id") ON DELETE no action;--> statement-breakpoint
ALTER TABLE "projects_timesheets" ADD CONSTRAINT "projects_timesheets_institution_fk" FOREIGN KEY ("institution_id") REFERENCES "public"."institutions"("id") ON DELETE cascade;--> statement-breakpoint
ALTER TABLE "projects_timesheets" ADD CONSTRAINT "projects_timesheets_task_fk" FOREIGN KEY ("institution_id","project_id","task_id") REFERENCES "public"."projects_tasks"("institution_id","project_id","id") ON DELETE no action;--> statement-breakpoint
ALTER TABLE "projects_timesheets" ADD CONSTRAINT "projects_timesheets_billing_fk" FOREIGN KEY ("institution_id","project_id","billing_id") REFERENCES "public"."projects_billings"("institution_id","project_id","id") ON DELETE no action;--> statement-breakpoint
ALTER TABLE "projects_timesheets" ADD CONSTRAINT "projects_timesheets_costing_fk" FOREIGN KEY ("institution_id","project_id","costing_id") REFERENCES "public"."projects_costings"("institution_id","project_id","id") ON DELETE no action;--> statement-breakpoint
ALTER TABLE "projects_timesheets" ADD CONSTRAINT "projects_timesheets_user_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action;--> statement-breakpoint
ALTER TABLE "projects_timesheets" ADD CONSTRAINT "projects_timesheets_entered_by_fk" FOREIGN KEY ("entered_by") REFERENCES "public"."users"("id") ON DELETE no action;--> statement-breakpoint
ALTER TABLE "projects_timesheets" ADD CONSTRAINT "projects_timesheets_decided_by_fk" FOREIGN KEY ("decided_by") REFERENCES "public"."users"("id") ON DELETE no action;--> statement-breakpoint
ALTER TABLE "projects_idempotency_keys" ADD CONSTRAINT "projects_idempotency_keys_institution_id_institutions_id_fk" FOREIGN KEY ("institution_id") REFERENCES "public"."institutions"("id") ON DELETE cascade;--> statement-breakpoint
ALTER TABLE "projects_idempotency_keys" ADD CONSTRAINT "projects_idempotency_keys_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE cascade;--> statement-breakpoint
ALTER TABLE "projects_projects" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "projects_members" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "projects_stages" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "projects_milestones" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "projects_tasks" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "projects_cost_rates" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "projects_billings" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "projects_costings" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "projects_timesheets" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "projects_idempotency_keys" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "projects_projects_tenant_isolation" ON "projects_projects" AS PERMISSIVE FOR ALL TO "campusos_app" USING (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid) WITH CHECK (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "projects_members_tenant_isolation" ON "projects_members" AS PERMISSIVE FOR ALL TO "campusos_app" USING (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid) WITH CHECK (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "projects_stages_tenant_isolation" ON "projects_stages" AS PERMISSIVE FOR ALL TO "campusos_app" USING (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid) WITH CHECK (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "projects_milestones_tenant_isolation" ON "projects_milestones" AS PERMISSIVE FOR ALL TO "campusos_app" USING (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid) WITH CHECK (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "projects_tasks_tenant_isolation" ON "projects_tasks" AS PERMISSIVE FOR ALL TO "campusos_app" USING (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid) WITH CHECK (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "projects_cost_rates_tenant_isolation" ON "projects_cost_rates" AS PERMISSIVE FOR ALL TO "campusos_app" USING (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid) WITH CHECK (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "projects_billings_tenant_isolation" ON "projects_billings" AS PERMISSIVE FOR ALL TO "campusos_app" USING (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid) WITH CHECK (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "projects_costings_tenant_isolation" ON "projects_costings" AS PERMISSIVE FOR ALL TO "campusos_app" USING (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid) WITH CHECK (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "projects_timesheets_tenant_isolation" ON "projects_timesheets" AS PERMISSIVE FOR ALL TO "campusos_app" USING (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid) WITH CHECK (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "projects_idempotency_keys_tenant_isolation" ON "projects_idempotency_keys" AS PERMISSIVE FOR ALL TO "campusos_app" USING (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid) WITH CHECK (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid);--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.projects_timesheet_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    -- Gone with its institution; otherwise approved time is kept.
    IF OLD.status = 'approved' AND EXISTS (SELECT 1 FROM public.institutions WHERE id = OLD.institution_id) THEN
      RAISE EXCEPTION 'approved time is kept as it was'
        USING ERRCODE = 'check_violation', CONSTRAINT = 'projects_timesheets_kept';
    END IF;
    RETURN OLD;
  END IF;
  IF OLD.billing_id IS NOT NULL AND NEW.billing_id IS DISTINCT FROM OLD.billing_id THEN
    RAISE EXCEPTION 'billed time stays billed'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'projects_timesheets_kept';
  END IF;
  IF OLD.status = 'approved' THEN
    IF NEW.status = 'approved' THEN
      IF (to_jsonb(NEW) - ARRAY['billing_id', 'costing_id', 'cost_paise', 'updated_at'])
         IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['billing_id', 'costing_id', 'cost_paise', 'updated_at']) THEN
        RAISE EXCEPTION 'approved time is kept as it was'
          USING ERRCODE = 'check_violation', CONSTRAINT = 'projects_timesheets_kept';
      END IF;
    ELSIF OLD.billing_id IS NOT NULL OR OLD.costing_id IS NOT NULL THEN
      RAISE EXCEPTION 'billed or costed time is not reopened'
        USING ERRCODE = 'check_violation', CONSTRAINT = 'projects_timesheets_kept';
    END IF;
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER "projects_timesheet_guard" BEFORE UPDATE OR DELETE ON "projects_timesheets"
  FOR EACH ROW EXECUTE FUNCTION public.projects_timesheet_guard();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.projects_record_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF EXISTS (SELECT 1 FROM public.institutions WHERE id = OLD.institution_id) THEN
      RAISE EXCEPTION '% rows are kept', TG_TABLE_NAME
        USING ERRCODE = 'check_violation', CONSTRAINT = TG_TABLE_NAME || '_kept';
    END IF;
    RETURN OLD;
  END IF;
  -- A costing is reversed once; nothing else about a billing or a costing changes.
  IF TG_TABLE_NAME = 'projects_costings' AND OLD.reversed_at IS NULL
     AND (to_jsonb(NEW) - ARRAY['reversed_at', 'reversed_by', 'reversal_entry_id', 'reverse_reason'])
       = (to_jsonb(OLD) - ARRAY['reversed_at', 'reversed_by', 'reversal_entry_id', 'reverse_reason']) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION '% rows are kept', TG_TABLE_NAME
    USING ERRCODE = 'check_violation', CONSTRAINT = TG_TABLE_NAME || '_kept';
END
$$;
--> statement-breakpoint
CREATE TRIGGER "projects_billings_guard" BEFORE UPDATE OR DELETE ON "projects_billings"
  FOR EACH ROW EXECUTE FUNCTION public.projects_record_guard();
--> statement-breakpoint
CREATE TRIGGER "projects_costings_guard" BEFORE UPDATE OR DELETE ON "projects_costings"
  FOR EACH ROW EXECUTE FUNCTION public.projects_record_guard();
