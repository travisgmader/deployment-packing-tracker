-- Row-level security: signed-in members share one board; anonymous visitors get nothing.

alter table public.profiles enable row level security;
alter table public.lists    enable row level security;
alter table public.items    enable row level security;
alter table public.activity enable row level security;

-- profiles: everyone signed in can see who else is on the board; you edit only your own.
drop policy if exists profiles_select on public.profiles;
create policy profiles_select on public.profiles
  for select to authenticated using (true);

drop policy if exists profiles_update_own on public.profiles;
create policy profiles_update_own on public.profiles
  for update to authenticated using (id = auth.uid()) with check (id = auth.uid());

drop policy if exists profiles_insert_own on public.profiles;
create policy profiles_insert_own on public.profiles
  for insert to authenticated with check (id = auth.uid());

-- lists: readable by all members, editable by all members.
drop policy if exists lists_all on public.lists;
create policy lists_all on public.lists
  for all to authenticated using (true) with check (true);

-- items: the shared board — any member can read and change anything.
drop policy if exists items_all on public.items;
create policy items_all on public.items
  for all to authenticated using (true) with check (true);

-- activity: readable by members; only the triggers write to it.
drop policy if exists activity_select on public.activity;
create policy activity_select on public.activity
  for select to authenticated using (true);

-- Realtime: push item and activity changes to everyone with the page open.
alter table public.items    replica identity full;
alter table public.activity replica identity full;

do $$
begin
  if not exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    create publication supabase_realtime;
  end if;
end $$;

do $$
begin
  begin
    alter publication supabase_realtime add table public.items;
  exception when duplicate_object then null;
  end;
  begin
    alter publication supabase_realtime add table public.activity;
  exception when duplicate_object then null;
  end;
  begin
    alter publication supabase_realtime add table public.lists;
  exception when duplicate_object then null;
  end;
end $$;
