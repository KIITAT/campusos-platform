CREATE TABLE "admissions_enquiries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"institution_id" uuid NOT NULL,
	"name" text NOT NULL,
	"email" text NOT NULL,
	"phone" text,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
ALTER TABLE "admissions_enquiries" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "admissions_applications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"institution_id" uuid NOT NULL,
	"enquiry_id" uuid NOT NULL,
	"program_id" uuid NOT NULL,
	"term_id" uuid NOT NULL,
	"status" text DEFAULT 'submitted' NOT NULL,
	"reason" text,
	"student_id" text,
	"student_program_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "admissions_application_state" CHECK (status in ('submitted','offered','accepted','rejected','withdrawn')),
	CONSTRAINT "admissions_application_accepted_link" CHECK ((status = 'accepted') = (student_id is not null and student_program_id is not null))
);--> statement-breakpoint
ALTER TABLE "admissions_applications" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE UNIQUE INDEX "admissions_enquiries_tenant_id" ON "admissions_enquiries" USING btree ("institution_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "admissions_application_identity" ON "admissions_applications" USING btree ("enquiry_id","program_id","term_id");--> statement-breakpoint
ALTER TABLE "admissions_enquiries" ADD CONSTRAINT "admissions_enquiries_institution_id_institutions_id_fk" FOREIGN KEY ("institution_id") REFERENCES "public"."institutions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "admissions_applications" ADD CONSTRAINT "admissions_applications_institution_id_institutions_id_fk" FOREIGN KEY ("institution_id") REFERENCES "public"."institutions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "admissions_applications" ADD CONSTRAINT "admissions_applications_program_id_academic_programs_id_fk" FOREIGN KEY ("program_id") REFERENCES "public"."academic_programs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "admissions_applications" ADD CONSTRAINT "admissions_applications_term_id_academic_terms_id_fk" FOREIGN KEY ("term_id") REFERENCES "public"."academic_terms"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "admissions_applications" ADD CONSTRAINT "admissions_applications_student_id_users_id_fk" FOREIGN KEY ("student_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "admissions_applications" ADD CONSTRAINT "admissions_applications_student_program_id_academic_student_programs_id_fk" FOREIGN KEY ("student_program_id") REFERENCES "public"."academic_student_programs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "admissions_applications" ADD CONSTRAINT "admissions_applications_institution_id_enquiry_id_admissions_enquiries_institution_id_id_fk" FOREIGN KEY ("institution_id","enquiry_id") REFERENCES "public"."admissions_enquiries"("institution_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE POLICY "admissions_enquiries_tenant_isolation" ON "admissions_enquiries" AS PERMISSIVE FOR ALL TO "campusos_app" USING (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid) WITH CHECK (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "admissions_applications_tenant_isolation" ON "admissions_applications" AS PERMISSIVE FOR ALL TO "campusos_app" USING (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid) WITH CHECK (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid);
