CREATE TABLE "helpdesk_cases" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"institution_id" uuid NOT NULL,
	"reporter_id" text NOT NULL,
	"assignee_id" text,
	"subject" text NOT NULL,
	"description" text NOT NULL,
	"kind" text NOT NULL,
	"confidential" boolean DEFAULT false NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"resolution" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "helpdesk_case_state" CHECK (status in ('open','assigned','resolved')),
	CONSTRAINT "helpdesk_case_kind" CHECK (kind in ('helpdesk','grievance') and (kind <> 'grievance' or confidential))
);--> statement-breakpoint
ALTER TABLE "helpdesk_cases" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "helpdesk_messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"institution_id" uuid NOT NULL,
	"case_id" uuid NOT NULL,
	"author_id" text NOT NULL,
	"body" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
ALTER TABLE "helpdesk_messages" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE UNIQUE INDEX "helpdesk_cases_tenant_id" ON "helpdesk_cases" USING btree ("institution_id","id");--> statement-breakpoint
ALTER TABLE "helpdesk_cases" ADD CONSTRAINT "helpdesk_cases_institution_id_institutions_id_fk" FOREIGN KEY ("institution_id") REFERENCES "public"."institutions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "helpdesk_cases" ADD CONSTRAINT "helpdesk_cases_reporter_id_users_id_fk" FOREIGN KEY ("reporter_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "helpdesk_cases" ADD CONSTRAINT "helpdesk_cases_assignee_id_users_id_fk" FOREIGN KEY ("assignee_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "helpdesk_messages" ADD CONSTRAINT "helpdesk_messages_institution_id_institutions_id_fk" FOREIGN KEY ("institution_id") REFERENCES "public"."institutions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "helpdesk_messages" ADD CONSTRAINT "helpdesk_messages_author_id_users_id_fk" FOREIGN KEY ("author_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "helpdesk_messages" ADD CONSTRAINT "helpdesk_messages_institution_id_case_id_helpdesk_cases_institution_id_id_fk" FOREIGN KEY ("institution_id","case_id") REFERENCES "public"."helpdesk_cases"("institution_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE POLICY "helpdesk_cases_tenant_isolation" ON "helpdesk_cases" AS PERMISSIVE FOR ALL TO "campusos_app" USING (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid) WITH CHECK (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "helpdesk_messages_tenant_isolation" ON "helpdesk_messages" AS PERMISSIVE FOR ALL TO "campusos_app" USING (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid) WITH CHECK (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid);
