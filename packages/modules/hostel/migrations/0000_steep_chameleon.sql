-- Split from the monorepo history (0010_steep_chameleon.sql) when modules became
-- installable plugins. Applied by the host at install time, in this order.

CREATE TYPE "public"."hostel_block_kind" AS ENUM('mens', 'womens', 'any');--> statement-breakpoint
CREATE TYPE "public"."hostel_check_in_method" AS ENUM('scan', 'manual');--> statement-breakpoint
CREATE TYPE "public"."hostel_check_in_status" AS ENUM('present', 'absent', 'on_leave');--> statement-breakpoint
CREATE TABLE "hostel_allocations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"institution_id" uuid NOT NULL,
	"room_id" uuid NOT NULL,
	"student_id" text NOT NULL,
	"allocated_on" date NOT NULL,
	"vacated_on" date,
	"allocated_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "hostel_allocations_dates" CHECK (vacated_on is null or vacated_on >= allocated_on)
);
--> statement-breakpoint
ALTER TABLE "hostel_allocations" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "hostel_blocks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"institution_id" uuid NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"kind" "hostel_block_kind" DEFAULT 'any' NOT NULL,
	"warden_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "hostel_blocks_code_shape" CHECK (length(trim(code)) > 0)
);
--> statement-breakpoint
ALTER TABLE "hostel_blocks" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "hostel_check_ins" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"institution_id" uuid NOT NULL,
	"block_id" uuid NOT NULL,
	"student_id" text NOT NULL,
	"on_night" date NOT NULL,
	"status" "hostel_check_in_status" DEFAULT 'present' NOT NULL,
	"method" "hostel_check_in_method" NOT NULL,
	"note" text,
	"recorded_by" text,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "hostel_check_ins" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "hostel_leaves" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"institution_id" uuid NOT NULL,
	"student_id" text NOT NULL,
	"from_on" date NOT NULL,
	"to_on" date NOT NULL,
	"reason" text NOT NULL,
	"approved_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "hostel_leaves_dates" CHECK (to_on >= from_on),
	CONSTRAINT "hostel_leaves_reason" CHECK (length(trim(reason)) >= 5)
);
--> statement-breakpoint
ALTER TABLE "hostel_leaves" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "hostel_rooms" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"institution_id" uuid NOT NULL,
	"block_id" uuid NOT NULL,
	"number" text NOT NULL,
	"floor" smallint DEFAULT 0 NOT NULL,
	"capacity" smallint DEFAULT 2 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "hostel_rooms_capacity" CHECK (capacity between 1 and 20),
	CONSTRAINT "hostel_rooms_floor" CHECK (floor between -2 and 60)
);
--> statement-breakpoint
ALTER TABLE "hostel_rooms" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "hostel_visitors" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"institution_id" uuid NOT NULL,
	"block_id" uuid NOT NULL,
	"student_id" text,
	"name" text NOT NULL,
	"phone" text,
	"relation" text,
	"purpose" text,
	"entered_at" timestamp with time zone DEFAULT now() NOT NULL,
	"exited_at" timestamp with time zone,
	"recorded_by" text,
	CONSTRAINT "hostel_visitors_name" CHECK (length(trim(name)) > 0),
	CONSTRAINT "hostel_visitors_times" CHECK (exited_at is null or exited_at >= entered_at)
);
--> statement-breakpoint
ALTER TABLE "hostel_visitors" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "hostel_allocations" ADD CONSTRAINT "hostel_allocations_institution_id_institutions_id_fk" FOREIGN KEY ("institution_id") REFERENCES "public"."institutions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hostel_allocations" ADD CONSTRAINT "hostel_allocations_room_id_hostel_rooms_id_fk" FOREIGN KEY ("room_id") REFERENCES "public"."hostel_rooms"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hostel_allocations" ADD CONSTRAINT "hostel_allocations_student_id_users_id_fk" FOREIGN KEY ("student_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hostel_allocations" ADD CONSTRAINT "hostel_allocations_allocated_by_users_id_fk" FOREIGN KEY ("allocated_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hostel_blocks" ADD CONSTRAINT "hostel_blocks_institution_id_institutions_id_fk" FOREIGN KEY ("institution_id") REFERENCES "public"."institutions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hostel_blocks" ADD CONSTRAINT "hostel_blocks_warden_user_id_users_id_fk" FOREIGN KEY ("warden_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hostel_check_ins" ADD CONSTRAINT "hostel_check_ins_institution_id_institutions_id_fk" FOREIGN KEY ("institution_id") REFERENCES "public"."institutions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hostel_check_ins" ADD CONSTRAINT "hostel_check_ins_block_id_hostel_blocks_id_fk" FOREIGN KEY ("block_id") REFERENCES "public"."hostel_blocks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hostel_check_ins" ADD CONSTRAINT "hostel_check_ins_student_id_users_id_fk" FOREIGN KEY ("student_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hostel_check_ins" ADD CONSTRAINT "hostel_check_ins_recorded_by_users_id_fk" FOREIGN KEY ("recorded_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hostel_leaves" ADD CONSTRAINT "hostel_leaves_institution_id_institutions_id_fk" FOREIGN KEY ("institution_id") REFERENCES "public"."institutions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hostel_leaves" ADD CONSTRAINT "hostel_leaves_student_id_users_id_fk" FOREIGN KEY ("student_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hostel_leaves" ADD CONSTRAINT "hostel_leaves_approved_by_users_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hostel_rooms" ADD CONSTRAINT "hostel_rooms_institution_id_institutions_id_fk" FOREIGN KEY ("institution_id") REFERENCES "public"."institutions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hostel_rooms" ADD CONSTRAINT "hostel_rooms_block_id_hostel_blocks_id_fk" FOREIGN KEY ("block_id") REFERENCES "public"."hostel_blocks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hostel_visitors" ADD CONSTRAINT "hostel_visitors_institution_id_institutions_id_fk" FOREIGN KEY ("institution_id") REFERENCES "public"."institutions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hostel_visitors" ADD CONSTRAINT "hostel_visitors_block_id_hostel_blocks_id_fk" FOREIGN KEY ("block_id") REFERENCES "public"."hostel_blocks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hostel_visitors" ADD CONSTRAINT "hostel_visitors_student_id_users_id_fk" FOREIGN KEY ("student_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hostel_visitors" ADD CONSTRAINT "hostel_visitors_recorded_by_users_id_fk" FOREIGN KEY ("recorded_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "hostel_allocations_one_open" ON "hostel_allocations" USING btree ("student_id") WHERE vacated_on is null;--> statement-breakpoint
CREATE INDEX "hostel_allocations_room" ON "hostel_allocations" USING btree ("room_id","vacated_on");--> statement-breakpoint
CREATE UNIQUE INDEX "hostel_blocks_code" ON "hostel_blocks" USING btree ("institution_id","code");--> statement-breakpoint
CREATE UNIQUE INDEX "hostel_check_ins_once" ON "hostel_check_ins" USING btree ("student_id","on_night");--> statement-breakpoint
CREATE INDEX "hostel_check_ins_night" ON "hostel_check_ins" USING btree ("block_id","on_night");--> statement-breakpoint
CREATE INDEX "hostel_leaves_student" ON "hostel_leaves" USING btree ("student_id","from_on");--> statement-breakpoint
CREATE UNIQUE INDEX "hostel_rooms_number" ON "hostel_rooms" USING btree ("block_id","number");--> statement-breakpoint
CREATE INDEX "hostel_rooms_block" ON "hostel_rooms" USING btree ("block_id");--> statement-breakpoint
CREATE INDEX "hostel_visitors_open" ON "hostel_visitors" USING btree ("block_id","exited_at");--> statement-breakpoint
CREATE INDEX "hostel_visitors_student" ON "hostel_visitors" USING btree ("student_id");--> statement-breakpoint
CREATE POLICY "hostel_allocations_tenant_isolation" ON "hostel_allocations" AS PERMISSIVE FOR ALL TO "campusos_app" USING (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid) WITH CHECK (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "hostel_blocks_tenant_isolation" ON "hostel_blocks" AS PERMISSIVE FOR ALL TO "campusos_app" USING (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid) WITH CHECK (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "hostel_check_ins_tenant_isolation" ON "hostel_check_ins" AS PERMISSIVE FOR ALL TO "campusos_app" USING (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid) WITH CHECK (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "hostel_leaves_tenant_isolation" ON "hostel_leaves" AS PERMISSIVE FOR ALL TO "campusos_app" USING (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid) WITH CHECK (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "hostel_rooms_tenant_isolation" ON "hostel_rooms" AS PERMISSIVE FOR ALL TO "campusos_app" USING (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid) WITH CHECK (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "hostel_visitors_tenant_isolation" ON "hostel_visitors" AS PERMISSIVE FOR ALL TO "campusos_app" USING (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid) WITH CHECK (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid);
