-- Recovered from supabase_migrations.schema_migrations (applied remotely by another session).

-- Trigger functions are never called directly; Postgres checks EXECUTE when a
-- trigger is created, not when it fires.
revoke execute on function public.handle_new_user() from public, anon, authenticated;
revoke execute on function public.log_item_change() from public, anon, authenticated;

-- my_board() runs inside the items/activity/profiles policies and the items
-- default, so signed-in members need it; visitors don't.
revoke execute on function public.my_board() from public, anon;
grant  execute on function public.my_board() to authenticated;
