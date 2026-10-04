CREATE TABLE "transport_vehicles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"institution_id" uuid NOT NULL,
	"registration" text NOT NULL,
	"capacity" integer NOT NULL,
	CONSTRAINT "transport_vehicle_capacity" CHECK (capacity between 1 and 200)
);--> statement-breakpoint
ALTER TABLE "transport_vehicles" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "transport_routes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"institution_id" uuid NOT NULL,
	"name" text NOT NULL,
	"vehicle_id" uuid NOT NULL
);--> statement-breakpoint
ALTER TABLE "transport_routes" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "transport_stops" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"institution_id" uuid NOT NULL,
	"route_id" uuid NOT NULL,
	"name" text NOT NULL,
	"position" integer NOT NULL,
	CONSTRAINT "transport_stop_order" CHECK (position > 0)
);--> statement-breakpoint
ALTER TABLE "transport_stops" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "transport_assignments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"institution_id" uuid NOT NULL,
	"route_id" uuid NOT NULL,
	"stop_id" uuid NOT NULL,
	"student_id" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"release_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"released_at" timestamp with time zone,
	CONSTRAINT "transport_assignment_state" CHECK (status in ('active','released') and ((status = 'released') = (released_at is not null)))
);--> statement-breakpoint
ALTER TABLE "transport_assignments" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE UNIQUE INDEX "transport_vehicle_registration" ON "transport_vehicles" USING btree ("institution_id","registration");--> statement-breakpoint
CREATE UNIQUE INDEX "transport_vehicles_tenant_id" ON "transport_vehicles" USING btree ("institution_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "transport_route_vehicle" ON "transport_routes" USING btree ("vehicle_id");--> statement-breakpoint
CREATE UNIQUE INDEX "transport_routes_tenant_id" ON "transport_routes" USING btree ("institution_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "transport_stop_position" ON "transport_stops" USING btree ("route_id","position");--> statement-breakpoint
CREATE UNIQUE INDEX "transport_stops_route_id" ON "transport_stops" USING btree ("route_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "transport_student_active" ON "transport_assignments" USING btree ("institution_id","student_id") WHERE status = 'active';--> statement-breakpoint
ALTER TABLE "transport_vehicles" ADD CONSTRAINT "transport_vehicles_institution_id_institutions_id_fk" FOREIGN KEY ("institution_id") REFERENCES "public"."institutions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transport_routes" ADD CONSTRAINT "transport_routes_institution_id_institutions_id_fk" FOREIGN KEY ("institution_id") REFERENCES "public"."institutions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transport_routes" ADD CONSTRAINT "transport_routes_institution_id_vehicle_id_transport_vehicles_institution_id_id_fk" FOREIGN KEY ("institution_id","vehicle_id") REFERENCES "public"."transport_vehicles"("institution_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transport_stops" ADD CONSTRAINT "transport_stops_institution_id_institutions_id_fk" FOREIGN KEY ("institution_id") REFERENCES "public"."institutions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transport_stops" ADD CONSTRAINT "transport_stops_institution_id_route_id_transport_routes_institution_id_id_fk" FOREIGN KEY ("institution_id","route_id") REFERENCES "public"."transport_routes"("institution_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transport_assignments" ADD CONSTRAINT "transport_assignments_institution_id_institutions_id_fk" FOREIGN KEY ("institution_id") REFERENCES "public"."institutions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transport_assignments" ADD CONSTRAINT "transport_assignments_student_id_users_id_fk" FOREIGN KEY ("student_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transport_assignments" ADD CONSTRAINT "transport_assignments_institution_id_route_id_transport_routes_institution_id_id_fk" FOREIGN KEY ("institution_id","route_id") REFERENCES "public"."transport_routes"("institution_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transport_assignments" ADD CONSTRAINT "transport_assignments_route_id_stop_id_transport_stops_route_id_id_fk" FOREIGN KEY ("route_id","stop_id") REFERENCES "public"."transport_stops"("route_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE POLICY "transport_vehicles_tenant_isolation" ON "transport_vehicles" AS PERMISSIVE FOR ALL TO "campusos_app" USING (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid) WITH CHECK (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "transport_routes_tenant_isolation" ON "transport_routes" AS PERMISSIVE FOR ALL TO "campusos_app" USING (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid) WITH CHECK (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "transport_stops_tenant_isolation" ON "transport_stops" AS PERMISSIVE FOR ALL TO "campusos_app" USING (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid) WITH CHECK (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "transport_assignments_tenant_isolation" ON "transport_assignments" AS PERMISSIVE FOR ALL TO "campusos_app" USING (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid) WITH CHECK (institution_id = nullif(current_setting('app.institution_id', true), '')::uuid);
