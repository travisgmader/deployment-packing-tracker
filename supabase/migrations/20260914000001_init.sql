-- Deployment Packing Tracker — shared board schema
-- One master list; every signed-in member sees and edits the same statuses.

-- ---------------------------------------------------------------- profiles
create table if not exists public.profiles (
  id           uuid primary key references auth.users(id) on delete cascade,
  email        text,
  display_name text,
  created_at   timestamptz not null default now()
);

create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, email, display_name)
  values (
    new.id,
    new.email,
    coalesce(
      nullif(new.raw_user_meta_data->>'display_name', ''),
      initcap(replace(split_part(new.email, '@', 1), '.', ' '))
    )
  )
  on conflict (id) do nothing;
  return new;
end $$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ------------------------------------------------------------------- lists
create table if not exists public.lists (
  id         uuid primary key default gen_random_uuid(),
  slug       text unique not null,
  name       text not null,
  subtitle   text,
  kind       text not null check (kind in ('packing', 'tasks')),
  sort_order int  not null default 0
);

-- ------------------------------------------------------------------- items
create table if not exists public.items (
  id         uuid primary key default gen_random_uuid(),
  list_id    uuid not null references public.lists(id) on delete cascade,
  category   text not null default '',
  name       text not null,
  unit       text,
  qty        numeric,
  status     text not null default 'Need'
               check (status in ('Need','Ordered','Prepped','Packed','To Do','In Progress','Done')),
  notes      text,
  sort_order double precision not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id) on delete set null
);

create index if not exists items_list_sort_idx on public.items (list_id, sort_order);

-- --------------------------------------------------------------- activity
-- Who changed what, so a shared board doesn't turn into a mystery.
create table if not exists public.activity (
  id          bigserial primary key,
  item_id     uuid,
  item_name   text not null,
  list_slug   text,
  action      text not null,
  from_status text,
  to_status   text,
  actor       uuid references auth.users(id) on delete set null,
  actor_name  text,
  created_at  timestamptz not null default now()
);

create index if not exists activity_created_idx on public.activity (created_at desc);

create or replace function public.log_item_change()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  who   text;
  lslug text;
begin
  select coalesce(display_name, email, 'Someone') into who
    from public.profiles where id = auth.uid();
  who := coalesce(who, 'Someone');

  if tg_op = 'UPDATE' then
    new.updated_at := now();
    new.updated_by := auth.uid();

    select slug into lslug from public.lists where id = new.list_id;

    if new.status is distinct from old.status then
      insert into public.activity (item_id, item_name, list_slug, action, from_status, to_status, actor, actor_name)
      values (new.id, new.name, lslug, 'status', old.status, new.status, auth.uid(), who);
    elsif new.name is distinct from old.name
       or new.qty is distinct from old.qty
       or new.notes is distinct from old.notes
       or new.category is distinct from old.category
       or new.unit is distinct from old.unit then
      insert into public.activity (item_id, item_name, list_slug, action, actor, actor_name)
      values (new.id, new.name, lslug, 'edit', auth.uid(), who);
    end if;
    return new;

  elsif tg_op = 'INSERT' then
    new.updated_by := auth.uid();
    select slug into lslug from public.lists where id = new.list_id;
    insert into public.activity (item_id, item_name, list_slug, action, to_status, actor, actor_name)
    values (new.id, new.name, lslug, 'add', new.status, auth.uid(), who);
    return new;

  else
    select slug into lslug from public.lists where id = old.list_id;
    insert into public.activity (item_id, item_name, list_slug, action, actor, actor_name)
    values (old.id, old.name, lslug, 'delete', auth.uid(), who);
    return old;
  end if;
end $$;

drop trigger if exists items_log_iu on public.items;
create trigger items_log_iu
  before insert or update on public.items
  for each row execute function public.log_item_change();

drop trigger if exists items_log_d on public.items;
create trigger items_log_d
  after delete on public.items
  for each row execute function public.log_item_change();
