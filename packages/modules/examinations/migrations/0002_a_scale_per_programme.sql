-- A grading scale is not an institution-wide constant.
--
-- One university can run a ten-point scale for its engineering degrees, a
-- percentage with divisions for an affiliated diploma, and a pass/fail scheme
-- for a certificate -- at the same time, for students sitting in the same
-- building. Holding "the institution's scheme" as a single default makes the
-- second programme somebody's spreadsheet.
--
-- So a programme may name its own, and the institution's default is what
-- everything else falls back to. One row per programme: two scales for one
-- degree is not a policy, it is an argument.

CREATE TABLE "exam_scheme_programs" (
	"institution_id" uuid NOT NULL,
	"program_id" uuid NOT NULL,
	"scheme_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "exam_scheme_programs_pk" PRIMARY KEY("program_id")
);
--> statement-breakpoint
ALTER TABLE "exam_scheme_programs" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint

ALTER TABLE "exam_scheme_programs" ADD CONSTRAINT "exam_scheme_programs_institution_id_institutions_id_fk" FOREIGN KEY ("institution_id") REFERENCES "public"."institutions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "exam_scheme_programs" ADD CONSTRAINT "exam_scheme_programs_program_id_academic_programs_id_fk" FOREIGN KEY ("program_id") REFERENCES "public"."academic_programs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "exam_scheme_programs" ADD CONSTRAINT "exam_scheme_programs_scheme_id_exam_grading_schemes_id_fk" FOREIGN KEY ("scheme_id") REFERENCES "public"."exam_grading_schemes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint

CREATE POLICY "exam_scheme_programs_tenant_isolation" ON "exam_scheme_programs" AS PERMISSIVE FOR ALL TO "campusos_app" USING (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid) WITH CHECK (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid);
