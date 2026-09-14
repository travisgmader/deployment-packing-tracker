-- Per-person boards. Every member belongs to exactly one board and sees only
-- that board's items and activity. The members already here keep sharing the
-- original board; anyone added later starts on a board of their own, pre-filled
-- from a snapshot of the original with nothing checked off.
--
-- A board is named by the id of the member it was created for — it has no
-- table of its own, because the only thing a board has is its rows.

-- ---------------------------------------------------------------- profiles
alter table public.profiles add column if not exists board_id uuid;

update public.profiles
   set board_id = (select id from public.profiles order by created_at limit 1)
 where board_id is null;

alter table public.profiles alter column board_id set not null;

create or replace function public.my_board()
returns uuid language sql stable security definer set search_path = public as $$
  select board_id from public.profiles where id = auth.uid()
$$;

-- ------------------------------------------------------------ items/activity
alter table public.items    add column if not exists board_id uuid;
alter table public.activity add column if not exists board_id uuid;

update public.items
   set board_id = (select id from public.profiles order by created_at limit 1)
 where board_id is null;
update public.activity
   set board_id = (select id from public.profiles order by created_at limit 1)
 where board_id is null;

alter table public.items alter column board_id set default public.my_board();
alter table public.items alter column board_id set not null;

create index if not exists items_board_idx    on public.items (board_id, list_id, sort_order);
create index if not exists activity_board_idx on public.activity (board_id, created_at desc);

-- ---------------------------------------------------------------- template
-- What a new board starts with. Statuses aren't stored: every row starts at
-- the first step of its list's flow.
create table if not exists public.template_items (
  id         uuid primary key default gen_random_uuid(),
  list_id    uuid not null references public.lists(id) on delete cascade,
  category   text not null default '',
  name       text not null,
  unit       text,
  qty        numeric,
  notes      text,
  sort_order double precision not null default 0
);

-- No policies: only the signup trigger (security definer) reads it.
alter table public.template_items enable row level security;

insert into public.template_items (list_id, category, name, unit, qty, notes, sort_order)
select list_id, category, name, unit, qty, notes, sort_order
  from public.items
 where board_id = (select id from public.profiles order by created_at limit 1)
   and not exists (select 1 from public.template_items);

-- ------------------------------------------------------------------ signup
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, email, display_name, board_id)
  values (
    new.id,
    new.email,
    coalesce(
      nullif(new.raw_user_meta_data->>'display_name', ''),
      initcap(replace(split_part(new.email, '@', 1), '.', ' '))
    ),
    new.id
  )
  on conflict (id) do nothing;

  if found then
    insert into public.items (board_id, list_id, category, name, unit, qty, status, notes, sort_order)
    select new.id, t.list_id, t.category, t.name, t.unit, t.qty,
           case l.kind when 'tasks' then 'To Do' else 'Need' end,
           t.notes, t.sort_order
      from public.template_items t
      join public.lists l on l.id = t.list_id;
  end if;
  return new;
end $$;

-- --------------------------------------------------------------- activity log
-- Same as 20260914000004, plus board_id on every entry. Rows inserted by the
-- signup trigger aren't logged, so a new board doesn't open on 195 "added" lines.
create or replace function public.log_item_change()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  who   text;
  lslug text;
  oslug text;
begin
  select coalesce(display_name, email, 'Someone') into who
    from public.profiles where id = auth.uid();
  who := coalesce(who, 'Someone');

  if tg_op = 'UPDATE' then
    new.updated_at := now();
    new.updated_by := auth.uid();

    select slug into lslug from public.lists where id = new.list_id;

    if new.list_id is distinct from old.list_id then
      select slug into oslug from public.lists where id = old.list_id;
      insert into public.activity (board_id, item_id, item_name, list_slug, from_list, action, from_status, to_status, actor, actor_name)
      values (new.board_id, new.id, new.name, lslug, oslug, 'move', old.status, new.status, auth.uid(), who);
    elsif new.status is distinct from old.status then
      insert into public.activity (board_id, item_id, item_name, list_slug, action, from_status, to_status, actor, actor_name)
      values (new.board_id, new.id, new.name, lslug, 'status', old.status, new.status, auth.uid(), who);
    elsif new.name is distinct from old.name
       or new.qty is distinct from old.qty
       or new.notes is distinct from old.notes
       or new.category is distinct from old.category
       or new.unit is distinct from old.unit then
      insert into public.activity (board_id, item_id, item_name, list_slug, action, actor, actor_name)
      values (new.board_id, new.id, new.name, lslug, 'edit', auth.uid(), who);
    end if;
    return new;

  elsif tg_op = 'INSERT' then
    new.updated_by := auth.uid();
    if pg_trigger_depth() > 1 then return new; end if;
    select slug into lslug from public.lists where id = new.list_id;
    insert into public.activity (board_id, item_id, item_name, list_slug, action, to_status, actor, actor_name)
    values (new.board_id, new.id, new.name, lslug, 'add', new.status, auth.uid(), who);
    return new;

  else
    select slug into lslug from public.lists where id = old.list_id;
    insert into public.activity (board_id, item_id, item_name, list_slug, action, actor, actor_name)
    values (old.board_id, old.id, old.name, lslug, 'delete', auth.uid(), who);
    return old;
  end if;
end $$;

-- ---------------------------------------------------------------- policies
drop policy if exists items_all on public.items;
drop policy if exists items_board on public.items;
create policy items_board on public.items
  for all to authenticated
  using (board_id = (select public.my_board()))
  with check (board_id = (select public.my_board()));

drop policy if exists activity_select on public.activity;
create policy activity_select on public.activity
  for select to authenticated using (board_id = (select public.my_board()));

-- You see the people on your own board, nobody else.
drop policy if exists profiles_select on public.profiles;
create policy profiles_select on public.profiles
  for select to authenticated using (board_id = (select public.my_board()));

-- Profiles are created by the signup trigger, and board_id must never be
-- self-assigned — otherwise anyone could move themselves onto another board.
drop policy if exists profiles_insert_own on public.profiles;
revoke insert, update on public.profiles from anon, authenticated;
grant update (display_name) on public.profiles to authenticated;

-- The five lists are shared structure; nobody edits them from the app.
drop policy if exists lists_all on public.lists;
drop policy if exists lists_select on public.lists;
create policy lists_select on public.lists
  for select to authenticated using (true);

-- ---------------------------------------------------------------- grants
-- Trigger functions are never called directly; Postgres checks EXECUTE when a
-- trigger is created, not when it fires.
revoke execute on function public.handle_new_user() from public, anon, authenticated;
revoke execute on function public.log_item_change() from public, anon, authenticated;

-- my_board() runs inside the items/activity/profiles policies and the items
-- default, so signed-in members need it; visitors don't.
revoke execute on function public.my_board() from public, anon;
grant  execute on function public.my_board() to authenticated;
