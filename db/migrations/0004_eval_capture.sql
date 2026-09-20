-- 0004_eval_capture.sql
-- Make every shadow record self-contained enough to evaluate and to replay.
--
-- Two things were missing. First, attribution: the prompt registry stamps a
-- version on every call so that a drop in accuracy can be blamed on a prompt
-- edit rather than on a model swap, but triage_shadow never stored either, so
-- the attribution stopped at the event log. Second, the prompt input:
-- enrichment is time-dependent, and a replay that re-enriches from today's
-- database is scoring the classifier against a prompt it was never given.

alter table triage_shadow
  add column agent_model          text,
  add column agent_prompt_version text,
  -- The rendered context vars, exactly as they went into the user message.
  -- Ticket subject and body are NOT duplicated here: they live on `tickets`,
  -- they are the largest part of the payload, and copying them would put a
  -- second unredacted copy of requester text in a second table.
  add column prompt_vars          jsonb,
  -- The safety slice, both sides of it. The agent's flags were previously
  -- reachable only by digging the triage event payload out of the timeline,
  -- which is not a join anything should have to do to answer "did we ever
  -- miss a security ticket". Human columns are null until somebody labels
  -- them, and the harness reports an unlabelled slice as unmeasured rather
  -- than passing: a gate that passes on an empty set is worse than no gate.
  add column agent_security_sensitive boolean,
  add column agent_destructive        boolean,
  add column human_security_sensitive boolean,
  add column human_destructive        boolean;

-- Evaluation always reads the reconciled rows for one tenant over a window.
create index on triage_shadow (business_id, reconciled_at desc)
  where reconciled_at is not null;

-- Attribution queries: "did accuracy move when we shipped triage@2026-09-13.2".
create index on triage_shadow (business_id, agent_prompt_version, recorded_at desc);
