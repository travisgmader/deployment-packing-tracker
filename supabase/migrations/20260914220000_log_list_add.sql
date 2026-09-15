-- Log a newly created list once. Lists copied onto a brand-new board by
-- handle_new_user aren't "added" by anyone, so they stay out of the log.

create or replace function public.log_list_change()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  who text;
  n   int;
begin
  select coalesce(display_name, email, 'Someone') into who
    from public.profiles where id = auth.uid();
  who := coalesce(who, 'Someone');

  if tg_op = 'INSERT' then
    if new.board_id is null or pg_trigger_depth() > 1 then return new; end if;
    insert into public.activity (board_id, item_name, list_slug, action, actor, actor_name)
    values (new.board_id, new.name, new.slug, 'list_add', auth.uid(), who);
    return new;

  elsif tg_op = 'UPDATE' then
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

drop trigger if exists lists_log_i on public.lists;
create trigger lists_log_i
  after insert on public.lists
  for each row execute function public.log_list_change();

revoke execute on function public.log_list_change() from public, anon, authenticated;
