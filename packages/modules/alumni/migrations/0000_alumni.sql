CREATE TABLE "alumni_profiles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"institution_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"graduation_year" integer NOT NULL,
	"qualification" text NOT NULL,
	"employer" text,
	"contact_email" text,
	"publish_profile" boolean DEFAULT false NOT NULL,
	"publish_contact" boolean DEFAULT false NOT NULL,
	CONSTRAINT "alumni_profile_consent" CHECK (not publish_contact or publish_profile)
);--> statement-breakpoint
ALTER TABLE "alumni_profiles" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "alumni_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"institution_id" uuid NOT NULL,
	"title" text NOT NULL,
	"starts_on" date NOT NULL,
	"registration_deadline" date NOT NULL,
	"capacity" integer NOT NULL,
	"venue" text NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	CONSTRAINT "alumni_event_capacity" CHECK (capacity between 1 and 100000),
	CONSTRAINT "alumni_event_dates" CHECK (registration_deadline <= starts_on),
	CONSTRAINT "alumni_event_state" CHECK (status in ('draft','open','closed','cancelled'))
);--> statement-breakpoint
ALTER TABLE "alumni_events" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "alumni_registrations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"institution_id" uuid NOT NULL,
	"event_id" uuid NOT NULL,
	"profile_id" uuid NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "alumni_registration_state" CHECK (status in ('active','cancelled'))
);--> statement-breakpoint
ALTER TABLE "alumni_registrations" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE UNIQUE INDEX "alumni_profile_user" ON "alumni_profiles" USING btree ("institution_id","user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "alumni_profiles_tenant_id" ON "alumni_profiles" USING btree ("institution_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "alumni_events_tenant_id" ON "alumni_events" USING btree ("institution_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "alumni_registration_identity" ON "alumni_registrations" USING btree ("event_id","profile_id");--> statement-breakpoint
ALTER TABLE "alumni_profiles" ADD CONSTRAINT "alumni_profiles_institution_id_institutions_id_fk" FOREIGN KEY ("institution_id") REFERENCES "public"."institutions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "alumni_profiles" ADD CONSTRAINT "alumni_profiles_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "alumni_events" ADD CONSTRAINT "alumni_events_institution_id_institutions_id_fk" FOREIGN KEY ("institution_id") REFERENCES "public"."institutions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "alumni_registrations" ADD CONSTRAINT "alumni_registrations_institution_id_institutions_id_fk" FOREIGN KEY ("institution_id") REFERENCES "public"."institutions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "alumni_registrations" ADD CONSTRAINT "alumni_registrations_institution_id_event_id_alumni_events_institution_id_id_fk" FOREIGN KEY ("institution_id","event_id") REFERENCES "public"."alumni_events"("institution_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "alumni_registrations" ADD CONSTRAINT "alumni_registrations_institution_id_profile_id_alumni_profiles_institution_id_id_fk" FOREIGN KEY ("institution_id","profile_id") REFERENCES "public"."alumni_profiles"("institution_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE POLICY "alumni_profiles_tenant_isolation" ON "alumni_profiles" AS PERMISSIVE FOR ALL TO "campusos_app" USING (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid) WITH CHECK (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "alumni_events_tenant_isolation" ON "alumni_events" AS PERMISSIVE FOR ALL TO "campusos_app" USING (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid) WITH CHECK (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "alumni_registrations_tenant_isolation" ON "alumni_registrations" AS PERMISSIVE FOR ALL TO "campusos_app" USING (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid) WITH CHECK (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid);
