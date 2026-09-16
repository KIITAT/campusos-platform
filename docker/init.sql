-- Runs once on a fresh volume (and via psql in CI).
--
-- Two roles on purpose:
--   postgres     -- owns the tables, runs migrations, BYPASSES RLS
--   campusos_app -- what the app connects as: no BYPASSRLS, owns nothing
--
-- A table's owner is exempt from its own RLS policies. Connecting the app as
-- the owner silently disables every tenant-isolation policy while all tests
-- still pass, so the app must never use the owner role.

create role campusos_app with login password 'campusos_app';

grant connect on database campusos to campusos_app;
grant usage on schema public to campusos_app;

-- existing objects (none on a fresh DB) + everything migrations create later
grant select, insert, update, delete on all tables in schema public to campusos_app;
grant usage, select on all sequences in schema public to campusos_app;
alter default privileges in schema public
  grant select, insert, update, delete on tables to campusos_app;
alter default privileges in schema public
  grant usage, select on sequences to campusos_app;
