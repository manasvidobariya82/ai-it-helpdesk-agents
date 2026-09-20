-- 0009_approval_expiry.sql
-- Make `expired` mean something, and make an approval actually authorize.
--
-- Two problems, one of which is worse than it looks.
--
-- The stated one: `approval_status` has had an `expired` value since 0002 and
-- nothing ever set it. A request raised on Friday afternoon sat `pending` all
-- weekend and was as executable on Monday as it had been at the moment the
-- agent asked. "Reset this person's password" is a reasonable action to approve
-- within the hour and an unreasonable one to approve three days later, by which
-- time nobody remembers the ticket.
--
-- The one found while fixing it: the risk gate in the tool registry unlocked on
-- `Boolean(ctx.approvalId)`. Any non-empty string in that field ran a
-- destructive tool — a rejected approval's id, another tenant's id, or the word
-- "yes". The gate checked that an approval id was *present*, never that it was
-- *valid*. The columns below are what makes checking possible; the check itself
-- is in `assertApprovalUsable`.

alter table action_requests
  -- Null on rows that predate this migration; they are treated as expired,
  -- because an approval whose deadline is unknown is not one to act on.
  add column expires_at timestamptz,
  -- The arguments the approver actually saw, hashed. Execution compares against
  -- it, so an approval for "reset alice@example.com" cannot be replayed to
  -- reset somebody else — the id is a capability for one specific call.
  add column args_hash text;

create index on action_requests (status, expires_at) where status = 'pending';

-- Existing pending rows get a deadline rather than being left ambiguous. One
-- hour from the migration is deliberately short: anything already waiting has
-- been waiting too long, and re-raising is cheap.
update action_requests
   set expires_at = now() + interval '1 hour'
 where status = 'pending' and expires_at is null;
