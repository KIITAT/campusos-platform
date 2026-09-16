CREATE TABLE "parent_links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"institution_id" uuid NOT NULL,
	"parent_id" text NOT NULL,
	"student_id" text NOT NULL,
	"relation" text NOT NULL,
	"verified_at" timestamp with time zone,
	"verified_by" text,
	"refused_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "parent_links_relation" CHECK (length(trim(relation)) > 0),
	CONSTRAINT "parent_links_distinct" CHECK (parent_id <> student_id),
	CONSTRAINT "parent_links_decided" CHECK (verified_at is null or refused_reason is null)
);
--> statement-breakpoint
ALTER TABLE "parent_links" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "parent_links" ADD CONSTRAINT "parent_links_institution_id_institutions_id_fk" FOREIGN KEY ("institution_id") REFERENCES "public"."institutions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "parent_links" ADD CONSTRAINT "parent_links_parent_id_users_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "parent_links" ADD CONSTRAINT "parent_links_student_id_users_id_fk" FOREIGN KEY ("student_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "parent_links" ADD CONSTRAINT "parent_links_verified_by_users_id_fk" FOREIGN KEY ("verified_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "parent_links_pair" ON "parent_links" USING btree ("parent_id","student_id");--> statement-breakpoint
CREATE INDEX "parent_links_student" ON "parent_links" USING btree ("student_id");--> statement-breakpoint
CREATE INDEX "parent_links_pending" ON "parent_links" USING btree ("institution_id","verified_at");--> statement-breakpoint
CREATE POLICY "parent_links_tenant_isolation" ON "parent_links" AS PERMISSIVE FOR ALL TO "campusos_app" USING (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid) WITH CHECK (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid);