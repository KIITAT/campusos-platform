-- Whether an address belongs to somebody at another institution.
--
-- Inviting a guardian has to know it -- an account belongs to one institution,
-- so an address that is somebody's elsewhere cannot be invited here -- and the
-- module that invites runs as the application role, under row level security,
-- which hides every other institution's users. That is right, and it is not to
-- be widened. So the one question is answered here instead, by a function that
-- runs as its owner and says yes or no: no name, no institution, no role
-- crosses the boundary, only the fact the caller has to act on.
--
-- "Here" is the tenant the transaction is already scoped to, not an argument,
-- so a caller cannot ask about an institution it is not acting in. With no
-- tenant set it answers null.
--
-- An accepted, live invitation from another institution counts as taken too:
-- two institutions both inviting one address would leave it signing in to
-- neither.

CREATE OR REPLACE FUNCTION campusos_address_taken_elsewhere(address text)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  WITH here AS (SELECT nullif(current_setting('app.institution_id', true), '')::uuid AS id)
  SELECT CASE WHEN (SELECT id FROM here) IS NULL THEN NULL ELSE EXISTS (
    SELECT 1 FROM users
     WHERE lower(email) = lower(trim(address))
       AND institution_id IS DISTINCT FROM (SELECT id FROM here)
  ) OR EXISTS (
    SELECT 1 FROM invitations
     WHERE email = lower(trim(address))
       AND institution_id <> (SELECT id FROM here)
       AND accepted_at IS NOT NULL
       AND revoked_at IS NULL
  ) END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION campusos_address_taken_elsewhere(text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION campusos_address_taken_elsewhere(text) TO campusos_app;
