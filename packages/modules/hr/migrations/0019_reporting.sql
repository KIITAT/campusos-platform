-- P2-05: hr publishes its staff list as a reporting dataset (MG-57, decisions 488, 489).
-- No contact data, identifiers, bank details or pay: those stay in hr's own screens.
-- Pre-flight: none. Adds only.
-- Rollback: DROP VIEW IF EXISTS reporting.hr_staff;
CREATE SCHEMA IF NOT EXISTS reporting;
--> statement-breakpoint
GRANT USAGE ON SCHEMA reporting TO campusos_app;
--> statement-breakpoint
CREATE VIEW reporting.hr_staff WITH (security_invoker = true) AS
  SELECT s.employee_code, s.name, s.designation, s.department, s.employment::text AS employment,
         s.joined_on, s.left_on,
         (s.left_on IS NULL OR s.left_on >= (now() AT TIME ZONE 'Asia/Kolkata')::date) AS active
    FROM public.hr_staff s;
--> statement-breakpoint
GRANT SELECT ON reporting.hr_staff TO campusos_app;
--> statement-breakpoint
COMMENT ON VIEW reporting.hr_staff IS '{"label":"Staff","module":"hr","roles":["institution_admin","super_admin"]}';
--> statement-breakpoint
COMMENT ON COLUMN reporting.hr_staff.employee_code IS '{"label":"Employee code","kind":"text"}';
--> statement-breakpoint
COMMENT ON COLUMN reporting.hr_staff.name IS '{"label":"Name","kind":"text"}';
--> statement-breakpoint
COMMENT ON COLUMN reporting.hr_staff.designation IS '{"label":"Designation","kind":"text"}';
--> statement-breakpoint
COMMENT ON COLUMN reporting.hr_staff.department IS '{"label":"Department","kind":"text"}';
--> statement-breakpoint
COMMENT ON COLUMN reporting.hr_staff.employment IS '{"label":"Employment","kind":"text"}';
--> statement-breakpoint
COMMENT ON COLUMN reporting.hr_staff.joined_on IS '{"label":"Joined","kind":"date"}';
--> statement-breakpoint
COMMENT ON COLUMN reporting.hr_staff.left_on IS '{"label":"Left","kind":"date"}';
--> statement-breakpoint
COMMENT ON COLUMN reporting.hr_staff.active IS '{"label":"Active","kind":"bool"}';
