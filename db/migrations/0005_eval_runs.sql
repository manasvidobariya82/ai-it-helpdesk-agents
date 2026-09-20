-- 0005_eval_runs.sql
-- Evaluation results, kept so the question can be re-sliced later.
--
-- The aggregates a run prints answer "is the classifier good today". They do
-- not answer "which categories can safely operate at which confidence
-- threshold", because that needs the rows back — by tenant, by model, by
-- prompt version, by bucket — and no aggregate survives being re-sliced.
--
-- Both tables are insert-only. A run is a measurement of a moment; editing one
-- is editing the past, and the whole point of keeping them is the trend.

create table eval_runs (
  id              uuid primary key default gen_random_uuid(),
  business_id     uuid references businesses(id) on delete cascade,
  -- 'shadow' (production records), 'replay' (fresh calls over a frozen set),
  -- or 'dataset' (predictions frozen in the file).
  source          text not null,
  dataset_path    text,
  dataset_id      text,
  split           text not null default 'all',
  model_version   text,
  prompt_version  text,
  -- Everything whose change should invalidate a comparison: model, prompt,
  -- taxonomy, routing rules and the threshold policy, hashed together.
  fingerprint     text,
  n               int not null,
  -- The headline numbers, denormalized for trend queries that should not have
  -- to parse the report blob.
  category_accuracy      numeric(6,5),
  category_macro_f1      numeric(6,5),
  priority_accuracy      numeric(6,5),
  team_accuracy          numeric(6,5),
  ece                    numeric(6,5),
  brier                  numeric(6,5),
  false_routing_rate     numeric(6,5),
  coverage               numeric(6,5),
  correction_rate        numeric(6,5),
  safety_misses          int not null default 0,
  passed          boolean not null,
  -- The full report, so a run stays readable after the summary columns drift.
  report          jsonb not null,
  created_at      timestamptz not null default now()
);

create index on eval_runs (business_id, created_at desc);
create index on eval_runs (prompt_version, model_version, created_at desc);

create table eval_results (
  id              bigserial primary key,
  run_id          uuid not null references eval_runs(id) on delete cascade,
  business_id     uuid references businesses(id) on delete cascade,
  ticket_id       uuid,
  confidence      numeric(3,2) not null,
  confidence_bucket text not null,
  category        text not null,
  predicted_category text not null,
  actual_category text not null,
  correct         boolean not null,
  predicted_priority text not null,
  actual_priority text not null,
  priority_correct boolean not null,
  predicted_team  text,
  actual_team     text,
  team_correct    boolean,
  would_auto_route boolean not null default false,
  model_version   text,
  prompt_version  text,
  evaluation_timestamp timestamptz not null
);

create index on eval_results (run_id);
-- The threshold question: accuracy by category and bucket for one tenant.
create index on eval_results (business_id, category, confidence_bucket);
-- The regression question: how one prompt version did across runs.
create index on eval_results (prompt_version, category);
