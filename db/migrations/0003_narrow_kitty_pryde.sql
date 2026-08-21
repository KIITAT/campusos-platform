CREATE TYPE "public"."attendance_device_status" AS ENUM('active', 'pending_approval', 'revoked');--> statement-breakpoint
CREATE TYPE "public"."attendance_mark_method" AS ENUM('scan', 'manual_override');--> statement-breakpoint
CREATE TABLE "attendance_devices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"institution_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"device_hash" text NOT NULL,
	"label" text,
	"status" "attendance_device_status" DEFAULT 'pending_approval' NOT NULL,
	"approved_by" text,
	"approved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "attendance_devices" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "attendance_records" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"institution_id" uuid NOT NULL,
	"session_id" uuid NOT NULL,
	"student_id" text NOT NULL,
	"method" "attendance_mark_method" NOT NULL,
	"marked_at" timestamp with time zone DEFAULT now() NOT NULL,
	"latitude" double precision,
	"longitude" double precision,
	"accuracy_m" double precision,
	"device_id" uuid,
	"override_reason" text,
	"marked_by" text,
	"anomalies" text[] DEFAULT '{}'::text[] NOT NULL,
	CONSTRAINT "attendance_records_override_reason" CHECK (method <> 'manual_override' or (override_reason is not null and length(trim(override_reason)) > 0))
);
--> statement-breakpoint
ALTER TABLE "attendance_records" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "attendance_room_geofences" (
	"institution_id" uuid NOT NULL,
	"room_id" uuid PRIMARY KEY NOT NULL,
	"latitude" double precision NOT NULL,
	"longitude" double precision NOT NULL,
	"radius_m" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "attendance_geofence_lat" CHECK (latitude between -90 and 90),
	CONSTRAINT "attendance_geofence_lng" CHECK (longitude between -180 and 180),
	CONSTRAINT "attendance_geofence_radius" CHECK (radius_m is null or radius_m between 10 and 5000)
);
--> statement-breakpoint
ALTER TABLE "attendance_room_geofences" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "attendance_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"institution_id" uuid NOT NULL,
	"slot_id" uuid NOT NULL,
	"offering_id" uuid NOT NULL,
	"opened_by" text NOT NULL,
	"token_secret" text NOT NULL,
	"opened_at" timestamp with time zone DEFAULT now() NOT NULL,
	"closed_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "attendance_sessions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "attendance_settings" (
	"institution_id" uuid PRIMARY KEY NOT NULL,
	"default_radius_m" integer DEFAULT 100 NOT NULL,
	"token_window_seconds" smallint DEFAULT 7 NOT NULL,
	"max_accuracy_m" integer DEFAULT 200 NOT NULL
);
--> statement-breakpoint
ALTER TABLE "attendance_settings" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "attendance_devices" ADD CONSTRAINT "attendance_devices_institution_id_institutions_id_fk" FOREIGN KEY ("institution_id") REFERENCES "public"."institutions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attendance_devices" ADD CONSTRAINT "attendance_devices_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attendance_devices" ADD CONSTRAINT "attendance_devices_approved_by_users_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attendance_records" ADD CONSTRAINT "attendance_records_institution_id_institutions_id_fk" FOREIGN KEY ("institution_id") REFERENCES "public"."institutions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attendance_records" ADD CONSTRAINT "attendance_records_session_id_attendance_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."attendance_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attendance_records" ADD CONSTRAINT "attendance_records_student_id_users_id_fk" FOREIGN KEY ("student_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attendance_records" ADD CONSTRAINT "attendance_records_device_id_attendance_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."attendance_devices"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attendance_records" ADD CONSTRAINT "attendance_records_marked_by_users_id_fk" FOREIGN KEY ("marked_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attendance_room_geofences" ADD CONSTRAINT "attendance_room_geofences_institution_id_institutions_id_fk" FOREIGN KEY ("institution_id") REFERENCES "public"."institutions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attendance_room_geofences" ADD CONSTRAINT "attendance_room_geofences_room_id_academic_rooms_id_fk" FOREIGN KEY ("room_id") REFERENCES "public"."academic_rooms"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attendance_sessions" ADD CONSTRAINT "attendance_sessions_institution_id_institutions_id_fk" FOREIGN KEY ("institution_id") REFERENCES "public"."institutions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attendance_sessions" ADD CONSTRAINT "attendance_sessions_slot_id_academic_slots_id_fk" FOREIGN KEY ("slot_id") REFERENCES "public"."academic_slots"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attendance_sessions" ADD CONSTRAINT "attendance_sessions_offering_id_academic_offerings_id_fk" FOREIGN KEY ("offering_id") REFERENCES "public"."academic_offerings"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attendance_sessions" ADD CONSTRAINT "attendance_sessions_opened_by_users_id_fk" FOREIGN KEY ("opened_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attendance_settings" ADD CONSTRAINT "attendance_settings_institution_id_institutions_id_fk" FOREIGN KEY ("institution_id") REFERENCES "public"."institutions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "attendance_devices_one_active" ON "attendance_devices" USING btree ("user_id") WHERE status = 'active';--> statement-breakpoint
CREATE UNIQUE INDEX "attendance_devices_identity" ON "attendance_devices" USING btree ("user_id","device_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "attendance_records_once" ON "attendance_records" USING btree ("session_id","student_id");--> statement-breakpoint
CREATE INDEX "attendance_records_student" ON "attendance_records" USING btree ("student_id");--> statement-breakpoint
CREATE UNIQUE INDEX "attendance_sessions_one_open" ON "attendance_sessions" USING btree ("slot_id") WHERE closed_at is null;--> statement-breakpoint
CREATE INDEX "attendance_sessions_offering" ON "attendance_sessions" USING btree ("offering_id");--> statement-breakpoint
CREATE POLICY "attendance_devices_tenant_isolation" ON "attendance_devices" AS PERMISSIVE FOR ALL TO "campusos_app" USING (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid) WITH CHECK (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "attendance_records_tenant_isolation" ON "attendance_records" AS PERMISSIVE FOR ALL TO "campusos_app" USING (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid) WITH CHECK (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "attendance_room_geofences_tenant_isolation" ON "attendance_room_geofences" AS PERMISSIVE FOR ALL TO "campusos_app" USING (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid) WITH CHECK (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "attendance_sessions_tenant_isolation" ON "attendance_sessions" AS PERMISSIVE FOR ALL TO "campusos_app" USING (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid) WITH CHECK (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "attendance_settings_tenant_isolation" ON "attendance_settings" AS PERMISSIVE FOR ALL TO "campusos_app" USING (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid) WITH CHECK (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid);