-- 0011_purge_escape_hatch.sql
-- Let a tenant be deleted, without letting history be edited.
--
-- 0008 made `audit_events` and `config_versions` refuse every update and
-- delete. That is what an audit trail needs, and it had a consequence nobody
-- asked for: `delete from businesses where id = $1` cascades into both tables,
-- so the trigger refused it and a tenant became undeletable. Offboarding a
-- customer, a GDPR erasure request and tearing down a test fixture all hit the
-- same wall.
--
-- The fix is not to weaken the guard. It is to make the one legitimate case
-- announce itself: a delete is permitted only while `hd.purge` is set on the
-- current transaction, which nothing does by accident. An ordinary
-- `delete from audit_events` still fails, from the application's own
-- connection as much as from a psql prompt.
--
-- Editing history stays impossible in every case. There is no setting that
-- permits an update, because "correcting" an audit row is never the right
-- answer — a correcting entry is.

create or replace function refuse_mutation() returns trigger as $$
begin
  -- Deliberate, transaction-scoped, and greppable. `set local` means it cannot
  -- leak into the next statement on a pooled connection.
  if tg_op = 'DELETE'
     and coalesce(current_setting('hd.purge', true), '') = 'on'
  then
    return old;
  end if;

  raise exception
    'The % table is append-only. Row % cannot be changed or removed.',
    tg_table_name, old.id
    using hint =
      case tg_op
        when 'DELETE' then
          'Deleting history is only possible while purging a whole tenant. ' ||
          'Use purgeBusiness(), which sets hd.purge for one transaction.'
        else
          'Record a correcting entry instead of editing the history.'
      end;
end;
$$ language plpgsql;
