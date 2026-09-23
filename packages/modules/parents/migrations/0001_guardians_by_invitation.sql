-- Guardians arrive by invitation (decision 121). The invitation is core; this
-- is which child it is for, turned into a verified link on first arrival.

CREATE TABLE "parent_guardian_invites" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"institution_id" uuid NOT NULL,
	"invitation_id" uuid NOT NULL,
	"student_id" text NOT NULL,
	"relation" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"linked_at" timestamp with time zone,
	CONSTRAINT "parent_guardian_invites_relation" CHECK (length(trim(relation)) > 0)
);
--> statement-breakpoint
ALTER TABLE "parent_guardian_invites" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "parent_guardian_invites" ADD CONSTRAINT "parent_guardian_invites_institution_id_institutions_id_fk" FOREIGN KEY ("institution_id") REFERENCES "public"."institutions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "parent_guardian_invites" ADD CONSTRAINT "parent_guardian_invites_invitation_id_invitations_id_fk" FOREIGN KEY ("invitation_id") REFERENCES "public"."invitations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "parent_guardian_invites" ADD CONSTRAINT "parent_guardian_invites_student_id_users_id_fk" FOREIGN KEY ("student_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "parent_guardian_invites_pair" ON "parent_guardian_invites" USING btree ("invitation_id","student_id");--> statement-breakpoint
CREATE INDEX "parent_guardian_invites_student" ON "parent_guardian_invites" USING btree ("student_id");--> statement-breakpoint
CREATE POLICY "parent_guardian_invites_tenant_isolation" ON "parent_guardian_invites" AS PERMISSIVE FOR ALL TO "campusos_app" USING (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid) WITH CHECK (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid);
