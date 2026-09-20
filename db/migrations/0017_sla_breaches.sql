-- 0017_sla_breaches.sql
-- A breach becomes a recorded fact instead of only a reading. D1 in
-- docs/sla.md.
--
-- Until now a breach existed only as whatever `slaStatus` said when somebody
-- asked. That answer comes from the deadline the row has now, and a running
-- clock's deadline can still move. Lowering the priority of an open ticket that
-- was already late restamped a later deadline, and the breach disappeared from
-- the console and from anything that might report on it. Nothing recorded that
-- it had happened, so "was this ticket's SLA ever breached" had no answer.
--
-- The rule these columns carry: a recorded SLA result is immutable historical
-- fact. Recalculation may start a new active clock, but it must not rewrite a
-- result already recorded.

alter table tickets
  -- The deadline the first-response clock missed, which is the instant it
  -- breached. Set once, by the first write or sweep that sees the breach, in
  -- the same transaction as its `sla_breach` event, and never cleared. The
  -- first response has one clock for the life of the ticket, so this is also
  -- that clock's current state.
  add column first_response_breached_at timestamptz,

  -- The same for the resolution target: the deadline missed by the first
  -- resolution clock that breached. Never cleared, including by a reopen, so it
  -- answers "was the resolution target ever missed" for the life of the ticket.
  add column resolution_breached_at timestamptz,

  -- Whether the current resolution clock has a recorded breach.
  --
  -- A separate column because the resolution target can have more than one
  -- clock. A reopen starts a new one, which can be on track while the old one
  -- stays breached in the column above. `slaStatus` and the restamps read this
  -- flag for the clock that is running now. A reopen clears it and never
  -- touches `resolution_breached_at`. If the new clock breaches too, that
  -- breach gets its own event and the first breach stays where it was.
  add column resolution_clock_breached boolean not null default false;

-- The breach sweep's candidates: clocks with no breach recorded that have not
-- been met. A met clock or a recorded breach leaves the index, so the sweep
-- scans only the clocks still running plus any late result it has not recorded
-- yet. It is a filter, not the decision: `slaStatus` decides, in TypeScript,
-- under the row lock.
create index tickets_first_response_unrecorded
  on tickets (business_id, first_response_due_at)
  where first_response_breached_at is null
    and (first_response_at is null or first_response_at > first_response_due_at);

create index tickets_resolution_unrecorded
  on tickets (business_id, resolution_due_at)
  where not resolution_clock_breached
    and (resolved_at is null or resolved_at > resolution_due_at);

-- There is deliberately no backfill here. Breaches from before this release,
-- open or closed, are recorded by the first sweeps after it, through the same
-- `slaStatus` the console reads, and each one gets its `sla_breach` event. A
-- SQL copy of that rule would be a second implementation of the SLA, which is
-- the defect 0015 existed to remove.
