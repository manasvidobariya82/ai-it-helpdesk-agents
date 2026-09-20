-- 0015_sla_pause.sql
-- Two SLA defects, both of which made a number on screen wrong.
--
-- **The clock never stopped.** `computeSla` stamped both deadlines once from
-- `created_at` and nothing adjusted them afterwards, so a ticket parked in
-- `awaiting_user` kept burning its resolution budget while the requester — not
-- the service desk — held the ball. Every ticket where the agent asked a
-- clarifying question was measured against time nobody here controlled, which
-- makes the resolution SLA figure a measure of requester responsiveness rather
-- than of service.
--
-- **"Due soon" meant two different things.** The console badge fired at a flat
-- 15 minutes for every priority; the warning email fired at a share of the
-- window. So a P4 with a three-day target was `on_track` in the console while
-- the email said it was at risk, and a P1 with a fifteen-minute target was
-- `due_soon` from the moment it arrived.
--
-- The columns below fix the first by making the pause a fact about the ticket,
-- and the second by storing the instant the warning is due so that every reader
-- — console, portal, API and the sweep — is looking at one number computed in
-- one place.

alter table tickets
  -- When the current pause began; null whenever the clock is running. Nothing
  -- writes "not paused": the column is cleared, so a ticket that resumes twice
  -- cannot be left holding a stale start.
  add column sla_paused_at timestamptz,

  -- Business minutes this ticket has spent paused, accumulated across every
  -- cycle. Kept separately from the shifted deadlines because a deadline says
  -- "when", and an SLA review needs "how much of this was us".
  add column sla_paused_minutes int not null default 0,

  -- When each clock enters its warning window.
  --
  -- Stored rather than derived, and that is the decision worth defending. The
  -- threshold is a share of a window measured in *business* minutes, which
  -- Postgres cannot compute without reimplementing the working-hours calendar
  -- in SQL — and a second implementation of an SLA calculation is exactly the
  -- bug this migration exists to remove. So it is computed once, in TypeScript,
  -- at the same moment the deadline is, and every reader compares against the
  -- same instant.
  --
  -- The consequence, stated rather than discovered later: changing
  -- `sla_warning_at_percent` applies to tickets stamped after the change, not
  -- to open ones. That matches how the deadline itself already behaves — a
  -- ticket is measured against the policy that applied when it was triaged.
  add column first_response_warn_at timestamptz,
  add column resolution_warn_at timestamptz;

-- The sweep's query: open tickets whose warning instant has passed. Partial,
-- because resolved and closed tickets are never scanned and there is no reason
-- to carry them in the index.
create index tickets_sla_warn on tickets (business_id, resolution_warn_at)
  where status not in ('resolved', 'closed');

-- Backfill, so open tickets do not all become "not warned yet" at deploy time.
--
-- Deliberately the *old* arithmetic — a flat share of the calendar span between
-- creation and the deadline — because that is what these tickets were stamped
-- under, and inventing a business-hours window for them retroactively would
-- change deadlines somebody is already working to. New tickets, and any ticket
-- that pauses and resumes, get the correct calculation.
update tickets t
   set first_response_warn_at = t.first_response_due_at
         - ((t.first_response_due_at - t.created_at)
             * (coalesce(
                  (b.settings -> 'notifications' ->> 'sla_warning_at_percent')::numeric,
                  20) / 100))
  from businesses b
 where b.id = t.business_id
   and t.first_response_due_at is not null;

update tickets t
   set resolution_warn_at = t.resolution_due_at
         - ((t.resolution_due_at - t.created_at)
             * (coalesce(
                  (b.settings -> 'notifications' ->> 'sla_warning_at_percent')::numeric,
                  20) / 100))
  from businesses b
 where b.id = t.business_id
   and t.resolution_due_at is not null;

-- Tickets already sitting in `awaiting_user` when this migration runs.
--
-- Without this they are stranded in the old behaviour permanently: their
-- `sla_paused_at` is null, so the resume path never fires when they finally
-- move, and they are never credited for any of the time they spent waiting —
-- including the time they spend waiting *after* the deploy.
--
-- The start instant comes from the event log where the log can supply it, which
-- is the only honest source for "when did this ticket start waiting". Where it
-- cannot, it falls back to now(), which under-credits rather than over-credits.
-- A migration that invents time the desk did not earn is worse than one that
-- misses some.
--
-- "Where the log can supply it" is narrower than "the last move into
-- awaiting_user", because before this release not every transition was logged.
-- A requester's reply took a ticket out of `awaiting_user` without writing a
-- status change, and the agent's clarifying question put one back in without
-- writing one either. So a logged pause followed by a reply and an unlogged
-- re-entry would have its current pause dated from the first one — crediting
-- the stretch in between, when the desk held the ticket. The rule is therefore:
-- find the most recent event that could have changed whether the ticket was
-- waiting (any status change, or an inbound reply), and trust it only if it is
-- itself the move into `awaiting_user`. Anything else means the current pause
-- began at some unrecorded moment after it.
update tickets t
   set sla_paused_at = coalesce(
         (select case
                   when e.kind = 'status_change'
                    and e.payload ->> 'status' = 'awaiting_user'
                   then e.created_at
                 end
            from ticket_events e
           where e.ticket_id = t.id
             and (e.kind = 'status_change'
                  or (e.kind = 'reply' and e.payload ->> 'inbound' = 'true'))
           order by e.created_at desc, e.id desc
           limit 1),
         now())
 where t.status = 'awaiting_user'
   and t.sla_paused_at is null;
