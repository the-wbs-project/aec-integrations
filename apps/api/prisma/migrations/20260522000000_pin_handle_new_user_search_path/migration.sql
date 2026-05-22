-- AECI-44: pin search_path on handle_new_user() SECURITY DEFINER function.
--
-- Without an explicit search_path, an attacker who can create objects in
-- a schema that appears earlier in the session's search_path could shadow
-- names referenced inside the function body. This is defense in depth —
-- the function already fully qualifies public.profiles — but makes the
-- policy uniform across every SECURITY DEFINER function in the project.
ALTER FUNCTION public.handle_new_user() SET search_path = public, pg_temp;
