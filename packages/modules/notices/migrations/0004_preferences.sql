-- P1-02: notification preferences (UX-02, decisions 283, 284).
-- notification_opt_outs: a person who does not want a category in their inbox.
-- notification_mandatory: a category the institution has made mandatory.
-- erase_notices now also deletes the person's opt-outs.
--
-- Rollback:
--   DROP TABLE IF EXISTS notification_opt_outs;
--   DROP TABLE IF EXISTS notification_mandatory;
--   then re-run the CREATE OR REPLACE FUNCTION from 0002_dpdp_subject.sql.

-- Pre-flight: notices 0002 (erase_notices) applied; the new tables do not exist.
DO $$
BEGIN
  IF to_regprocedure('dpdp_subject.erase_notices(text)') IS NULL THEN
    RAISE EXCEPTION 'notices migration 0002 must be applied first';
  END IF;
  IF to_regclass('public.notification_opt_outs') IS NOT NULL OR to_regclass('public.notification_mandatory') IS NOT NULL THEN
    RAISE EXCEPTION 'notification preference tables already exist';
  END IF;
END $$;
--> statement-breakpoint
CREATE TABLE "notification_opt_outs" (
	"institution_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"module_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "notification_opt_outs_user_id_module_id_pk" PRIMARY KEY("user_id","module_id")
);
--> statement-breakpoint
ALTER TABLE "notification_opt_outs" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "notification_mandatory" (
	"institution_id" uuid NOT NULL,
	"module_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "notification_mandatory_institution_id_module_id_pk" PRIMARY KEY("institution_id","module_id")
);
--> statement-breakpoint
ALTER TABLE "notification_mandatory" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "notification_opt_outs" ADD CONSTRAINT "notification_opt_outs_institution_id_institutions_id_fk" FOREIGN KEY ("institution_id") REFERENCES "public"."institutions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_opt_outs" ADD CONSTRAINT "notification_opt_outs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_mandatory" ADD CONSTRAINT "notification_mandatory_institution_id_institutions_id_fk" FOREIGN KEY ("institution_id") REFERENCES "public"."institutions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE POLICY "notification_opt_outs_tenant_isolation" ON "notification_opt_outs" AS PERMISSIVE FOR ALL TO "campusos_app" USING (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid) WITH CHECK (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "notification_mandatory_tenant_isolation" ON "notification_mandatory" AS PERMISSIVE FOR ALL TO "campusos_app" USING (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid) WITH CHECK (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid);
--> statement-breakpoint
CREATE OR REPLACE FUNCTION dpdp_subject.erase_notices(who text)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
  n_notifications integer := 0;
  n_opt_outs integer := 0;
BEGIN
  DELETE FROM notifications WHERE user_id = who;
  GET DIAGNOSTICS n_notifications = ROW_COUNT;
  DELETE FROM notification_opt_outs WHERE user_id = who;
  GET DIAGNOSTICS n_opt_outs = ROW_COUNT;
  RETURN jsonb_build_object('notifications', n_notifications, 'notification_opt_outs', n_opt_outs);
END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION dpdp_subject.erase_notices(text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION dpdp_subject.erase_notices(text) TO campusos_app;
