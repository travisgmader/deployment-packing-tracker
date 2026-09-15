-- Lists belong to a board: renaming or deleting a list changes only that board.
-- Rows with no board (board_id is null) are the starter set copied for new accounts.

alter table public.lists    add column if not exists board_id uuid;
alter table public.activity add column if not exists detail text;

-- Slugs only need to be unique within a board, and within the starter set.
alter table public.lists drop constraint if exists lists_slug_key;
create unique index if not exists lists_board_slug_key    on public.lists (board_id, slug) where board_id is not null;
create unique index if not exists lists_template_slug_key on public.lists (slug)           where board_id is null;
create index        if not exists lists_board_idx         on public.lists (board_id, sort_order);

-- Repointing existing items at their board's own lists is housekeeping, not
-- somebody moving things — keep it out of the activity log.
alter table public.items disable trigger items_log_iu;

do $$
declare
  main_board uuid := (select board_id from public.profiles order by created_at limit 1);
  b uuid;
begin
  if exists (select 1 from public.lists where board_id is not null) then
    return;  -- already migrated
  end if;
  if main_board is null then
    raise exception 'no profiles yet: cannot decide which board owns the existing lists';
  end if;

  -- The existing lists stay exactly as they are (same ids) on the first board.
  update public.lists set board_id = main_board where board_id is null;

  -- Starter set for new accounts, and the template now points at it.
  insert into public.lists (board_id, slug, name, subtitle, kind, sort_order)
  select null, slug, name, subtitle, kind, sort_order
    from public.lists where board_id = main_board;

  update public.template_items t
     set list_id = tl.id
    from public.lists ol, public.lists tl
   where t.list_id = ol.id and ol.board_id = main_board
     and tl.board_id is null and tl.slug = ol.slug;

  -- Every other board gets its own copies, and its items move onto them.
  for b in
    select board_id from public.profiles
    union
    select board_id from public.items
  loop
    continue when b = main_board;

    insert into public.lists (board_id, slug, name, subtitle, kind, sort_order)
    select b, slug, name, subtitle, kind, sort_order
      from public.lists where board_id is null;

    update public.items i
       set list_id = nl.id
      from public.lists ol, public.lists nl
     where i.board_id = b and i.list_id = ol.id
       and nl.board_id = b and nl.slug = ol.slug;
  end loop;
end $$;

alter table public.items enable trigger items_log_iu;

alter table public.lists alter column board_id set default public.my_board();

-- An item can only sit on a list from its own board.
create or replace function public.check_item_list_board()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if not exists (select 1 from public.lists where id = new.list_id and board_id = new.board_id) then
    raise exception 'That list is not on this board' using errcode = '23514';
  end if;
  return new;
end $$;

drop trigger if exists items_list_board on public.items;
create trigger items_list_board
  before insert or update of list_id, board_id on public.items
  for each row execute function public.check_item_list_board();

-- Members read and manage only their own board's lists.
drop policy if exists lists_select on public.lists;
drop policy if exists lists_all    on public.lists;
drop policy if exists lists_board  on public.lists;
create policy lists_board on public.lists
  for all to authenticated
  using (board_id = (select public.my_board()))
  with check (board_id = (select public.my_board()));

-- A new board gets its own copy of the starter lists, then the starter items.
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
    insert into public.lists (board_id, slug, name, subtitle, kind, sort_order)
    select new.id, slug, name, subtitle, kind, sort_order
      from public.lists where board_id is null;

    insert into public.items (board_id, list_id, category, name, unit, qty, status, notes, sort_order)
    select new.id, bl.id, t.category, t.name, t.unit, t.qty,
           case tl.kind when 'tasks' then 'To Do' else 'Need' end,
           t.notes, t.sort_order
      from public.template_items t
      join public.lists tl on tl.id = t.list_id
      join public.lists bl on bl.board_id = new.id and bl.slug = tl.slug;
  end if;
  return new;
end $$;

-- Item logging: unchanged from the boards migration, except that deleting a
-- whole list isn't logged item by item (log_list_change records it once).
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
    if lslug is null then
      return old;   -- the whole list is being deleted
    end if;
    insert into public.activity (board_id, item_id, item_name, list_slug, action, actor, actor_name)
    values (old.board_id, old.id, old.name, lslug, 'delete', auth.uid(), who);
    return old;
  end if;
end $$;

-- One activity entry per list rename, description edit, or delete.
create or replace function public.log_list_change()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  who text;
  n   int;
begin
  select coalesce(display_name, email, 'Someone') into who
    from public.profiles where id = auth.uid();
  who := coalesce(who, 'Someone');

  if tg_op = 'UPDATE' then
    if new.board_id is null then return new; end if;   -- starter set, not anyone's board
    if new.name is distinct from old.name then
      insert into public.activity (board_id, item_name, list_slug, action, detail, actor, actor_name)
      values (new.board_id, new.name, new.slug, 'list_rename', old.name, auth.uid(), who);
    elsif new.subtitle is distinct from old.subtitle then
      insert into public.activity (board_id, item_name, list_slug, action, actor, actor_name)
      values (new.board_id, new.name, new.slug, 'list_edit', auth.uid(), who);
    end if;
    return new;
  else
    if old.board_id is null then return old; end if;
    -- BEFORE DELETE, so the items are still there to count.
    select count(*) into n from public.items where list_id = old.id;
    insert into public.activity (board_id, item_name, list_slug, action, detail, actor, actor_name)
    values (old.board_id, old.name, old.slug, 'list_delete',
            n || case when n = 1 then ' item' else ' items' end, auth.uid(), who);
    return old;
  end if;
end $$;

drop trigger if exists lists_log_u on public.lists;
create trigger lists_log_u
  after update on public.lists
  for each row execute function public.log_list_change();

drop trigger if exists lists_log_d on public.lists;
create trigger lists_log_d
  before delete on public.lists
  for each row execute function public.log_list_change();

-- Trigger functions are never called directly (same policy as the boards migration).
revoke execute on function public.handle_new_user()       from public, anon, authenticated;
revoke execute on function public.log_item_change()       from public, anon, authenticated;
revoke execute on function public.log_list_change()       from public, anon, authenticated;
revoke execute on function public.check_item_list_board() from public, anon, authenticated;
