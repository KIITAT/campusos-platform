CREATE TYPE "public"."library_copy_status" AS ENUM('available', 'on_loan', 'lost', 'withdrawn');--> statement-breakpoint
CREATE TABLE "library_copies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"institution_id" uuid NOT NULL,
	"title_id" uuid NOT NULL,
	"accession_no" text NOT NULL,
	"status" "library_copy_status" DEFAULT 'available' NOT NULL,
	"shelf" text,
	"replacement_paise" bigint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "library_copies_accession_shape" CHECK (length(trim(accession_no)) > 0),
	CONSTRAINT "library_copies_replacement" CHECK (replacement_paise is null or replacement_paise > 0)
);
--> statement-breakpoint
ALTER TABLE "library_copies" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "library_loans" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"institution_id" uuid NOT NULL,
	"copy_id" uuid NOT NULL,
	"borrower_id" text NOT NULL,
	"issued_at" timestamp with time zone DEFAULT now() NOT NULL,
	"due_on" timestamp with time zone NOT NULL,
	"returned_at" timestamp with time zone,
	"renewals" smallint DEFAULT 0 NOT NULL,
	"fine_paise" bigint DEFAULT 0 NOT NULL,
	"fine_waived_paise" bigint DEFAULT 0 NOT NULL,
	"fine_waiver_reason" text,
	"fine_paid_at" timestamp with time zone,
	"issued_by" text,
	"returned_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "library_loans_dates" CHECK (due_on > issued_at),
	CONSTRAINT "library_loans_returned_after_issue" CHECK (returned_at is null or returned_at >= issued_at),
	CONSTRAINT "library_loans_fine" CHECK (fine_paise >= 0 and fine_waived_paise >= 0),
	CONSTRAINT "library_loans_waiver_within_fine" CHECK (fine_waived_paise <= fine_paise),
	CONSTRAINT "library_loans_renewals" CHECK (renewals >= 0)
);
--> statement-breakpoint
ALTER TABLE "library_loans" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "library_settings" (
	"institution_id" uuid PRIMARY KEY NOT NULL,
	"loan_days" smallint DEFAULT 14 NOT NULL,
	"grace_days" smallint DEFAULT 0 NOT NULL,
	"fine_per_day_paise" bigint DEFAULT 100 NOT NULL,
	"max_concurrent_loans" smallint DEFAULT 3 NOT NULL,
	"max_renewals" smallint DEFAULT 1 NOT NULL,
	"max_fine_paise" bigint,
	"block_at_outstanding_paise" bigint DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "library_settings_loan_days" CHECK (loan_days between 1 and 365),
	CONSTRAINT "library_settings_grace" CHECK (grace_days between 0 and 90),
	CONSTRAINT "library_settings_fine" CHECK (fine_per_day_paise >= 0),
	CONSTRAINT "library_settings_max_fine" CHECK (max_fine_paise is null or max_fine_paise > 0),
	CONSTRAINT "library_settings_limits" CHECK (max_concurrent_loans between 1 and 50),
	CONSTRAINT "library_settings_renewals" CHECK (max_renewals between 0 and 20),
	CONSTRAINT "library_settings_block" CHECK (block_at_outstanding_paise >= 0)
);
--> statement-breakpoint
ALTER TABLE "library_settings" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "library_titles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"institution_id" uuid NOT NULL,
	"isbn" text,
	"title" text NOT NULL,
	"author" text NOT NULL,
	"publisher" text,
	"year" smallint,
	"category" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "library_titles_title" CHECK (length(trim(title)) > 0),
	CONSTRAINT "library_titles_year" CHECK (year is null or (year between 1400 and 2200))
);
--> statement-breakpoint
ALTER TABLE "library_titles" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "library_copies" ADD CONSTRAINT "library_copies_institution_id_institutions_id_fk" FOREIGN KEY ("institution_id") REFERENCES "public"."institutions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "library_copies" ADD CONSTRAINT "library_copies_title_id_library_titles_id_fk" FOREIGN KEY ("title_id") REFERENCES "public"."library_titles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "library_loans" ADD CONSTRAINT "library_loans_institution_id_institutions_id_fk" FOREIGN KEY ("institution_id") REFERENCES "public"."institutions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "library_loans" ADD CONSTRAINT "library_loans_copy_id_library_copies_id_fk" FOREIGN KEY ("copy_id") REFERENCES "public"."library_copies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "library_loans" ADD CONSTRAINT "library_loans_borrower_id_users_id_fk" FOREIGN KEY ("borrower_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "library_loans" ADD CONSTRAINT "library_loans_issued_by_users_id_fk" FOREIGN KEY ("issued_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "library_loans" ADD CONSTRAINT "library_loans_returned_by_users_id_fk" FOREIGN KEY ("returned_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "library_settings" ADD CONSTRAINT "library_settings_institution_id_institutions_id_fk" FOREIGN KEY ("institution_id") REFERENCES "public"."institutions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "library_titles" ADD CONSTRAINT "library_titles_institution_id_institutions_id_fk" FOREIGN KEY ("institution_id") REFERENCES "public"."institutions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "library_copies_accession" ON "library_copies" USING btree ("institution_id","accession_no");--> statement-breakpoint
CREATE INDEX "library_copies_title" ON "library_copies" USING btree ("title_id");--> statement-breakpoint
CREATE INDEX "library_copies_status" ON "library_copies" USING btree ("institution_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "library_loans_one_open" ON "library_loans" USING btree ("copy_id") WHERE returned_at is null;--> statement-breakpoint
CREATE INDEX "library_loans_borrower" ON "library_loans" USING btree ("borrower_id","returned_at");--> statement-breakpoint
CREATE INDEX "library_loans_due" ON "library_loans" USING btree ("institution_id","due_on");--> statement-breakpoint
CREATE UNIQUE INDEX "library_titles_isbn" ON "library_titles" USING btree ("institution_id","isbn") WHERE isbn is not null;--> statement-breakpoint
CREATE INDEX "library_titles_search" ON "library_titles" USING btree ("institution_id","title");--> statement-breakpoint
CREATE POLICY "library_copies_tenant_isolation" ON "library_copies" AS PERMISSIVE FOR ALL TO "campusos_app" USING (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid) WITH CHECK (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "library_loans_tenant_isolation" ON "library_loans" AS PERMISSIVE FOR ALL TO "campusos_app" USING (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid) WITH CHECK (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "library_settings_tenant_isolation" ON "library_settings" AS PERMISSIVE FOR ALL TO "campusos_app" USING (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid) WITH CHECK (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "library_titles_tenant_isolation" ON "library_titles" AS PERMISSIVE FOR ALL TO "campusos_app" USING (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid) WITH CHECK (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid);