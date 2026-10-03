-- Documents that go with a notice (decision 144): a circular as issued, a
-- manual, a timetable. Added while the notice is a draft and fixed once it is
-- published, at most five to a notice. And a notice now has a page of its
-- own, which the inbox links to.
CREATE TABLE "notice_attachments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"institution_id" uuid NOT NULL,
	"notice_id" uuid NOT NULL,
	"name" text NOT NULL,
	"type" text NOT NULL,
	"size" integer NOT NULL,
	"sha256" text NOT NULL,
	"content" "bytea" NOT NULL,
	"added_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "notice_attachments_type" CHECK (type in ('application/pdf', 'image/png', 'image/jpeg')),
	CONSTRAINT "notice_attachments_size" CHECK (size = octet_length(content) and size between 1 and 10485760),
	CONSTRAINT "notice_attachments_name" CHECK (length(trim(name)) between 1 and 200)
);
--> statement-breakpoint
ALTER TABLE "notice_attachments" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "notice_attachments" ADD CONSTRAINT "notice_attachments_institution_id_institutions_id_fk" FOREIGN KEY ("institution_id") REFERENCES "public"."institutions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notice_attachments" ADD CONSTRAINT "notice_attachments_notice_id_notices_id_fk" FOREIGN KEY ("notice_id") REFERENCES "public"."notices"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notice_attachments" ADD CONSTRAINT "notice_attachments_added_by_users_id_fk" FOREIGN KEY ("added_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "notice_attachments_notice" ON "notice_attachments" USING btree ("notice_id");--> statement-breakpoint
CREATE POLICY "notice_attachments_tenant_isolation" ON "notice_attachments" AS PERMISSIVE FOR ALL TO "campusos_app" USING (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid) WITH CHECK (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid);
--> statement-breakpoint

-- What everybody was sent is what stays: attached and taken off only while
-- the notice is a draft, five at most, never rewritten.
CREATE OR REPLACE FUNCTION notice_attachment_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'an attached document is kept as it was sent'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'notice_attachment_fixed';
  END IF;
  IF TG_OP = 'DELETE' THEN
    IF EXISTS (SELECT 1 FROM institutions WHERE id = OLD.institution_id)
       AND EXISTS (SELECT 1 FROM notices WHERE id = OLD.notice_id AND published_at IS NOT NULL) THEN
      RAISE EXCEPTION 'that notice is published; its documents stay with it'
        USING ERRCODE = 'check_violation', CONSTRAINT = 'notice_attachment_published';
    END IF;
    RETURN OLD;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM notices WHERE id = NEW.notice_id AND published_at IS NULL) THEN
    RAISE EXCEPTION 'that notice is published; its documents stay as they were sent'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'notice_attachment_published';
  END IF;
  IF (SELECT count(*) FROM notice_attachments WHERE notice_id = NEW.notice_id) >= 5 THEN
    RAISE EXCEPTION 'a notice carries five documents at most'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'notice_attachments_count';
  END IF;
  NEW.created_at := now();
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "notice_attachments_guard" BEFORE INSERT OR UPDATE OR DELETE ON "notice_attachments"
  FOR EACH ROW EXECUTE FUNCTION notice_attachment_guard();
--> statement-breakpoint

-- The inbox linked a notice to /notices/<id>, a page that never existed.
UPDATE "notifications"
   SET link = '/m/notices/notice?id=' || notice_id
 WHERE notice_id IS NOT NULL AND link = '/notices/' || notice_id;
