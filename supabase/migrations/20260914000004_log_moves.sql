-- Record moves between lists in the activity log.
alter table public.activity add column if not exists from_list text;

alter table public.activity drop constraint if exists activity_action_check;

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
      insert into public.activity (item_id, item_name, list_slug, from_list, action, from_status, to_status, actor, actor_name)
      values (new.id, new.name, lslug, oslug, 'move', old.status, new.status, auth.uid(), who);
    elsif new.status is distinct from old.status then
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
