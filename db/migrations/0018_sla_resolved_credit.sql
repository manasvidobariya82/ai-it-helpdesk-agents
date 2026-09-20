-- 0018_sla_resolved_credit.sql
-- Time a ticket spends resolved or closed no longer counts against the desk
-- when it is reopened. D3 in docs/sla.md, decided on 2026-09-19.
--
-- A reopen used to start the new resolution clock on the deadline the old one
-- had. A requester who reopened three days after a fix that was on time landed
-- the desk an immediate breach for three days in which the ball was with the
-- requester, and since 0017 that breach was recorded for good.
--
-- `resolved` and `closed` now stop the resolution clock the way `awaiting_user`
-- stops both clocks. A reopen credits the time since `resolved_at`, so the new
-- clock starts with the margin the old one had when it was resolved. A ticket
-- that was resolved late is reopened exactly as late. The first-response clock
-- is not affected.

alter table tickets
  -- Minutes given back to the resolution clock for time spent resolved or
  -- closed, accumulated across every reopen, in the units of the clock it was
  -- measured on.
  --
  -- Separate from `sla_paused_minutes` because it belongs to one clock.
  -- `sla_paused_minutes` is credited to both clocks, and a restamp (a retriage,
  -- a priority change, a reopen) adds it to both windows. A first response
  -- still running on a resolved ticket was not stopped by the resolution, so it
  -- must not be handed that time on the next restamp. Every restamp adds this
  -- column to the resolution window only.
  add column sla_resolved_minutes int not null default 0;

-- No backfill. A ticket resolved now is credited from its `resolved_at` when it
-- is next reopened, whenever it was resolved. A ticket reopened before this
-- release keeps the clock that reopen gave it, and any breach it recorded stays
-- recorded, because a recorded result is not rewritten (0017).
