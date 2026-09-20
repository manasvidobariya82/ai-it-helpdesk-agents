# Evaluation data

Two directories, both meant to be committed.

## `datasets/`

Frozen golden sets as JSONL, one `GoldenSample` per line, sorted by id. The
schema is in [`packages/eval/src/sample.ts`](../packages/eval/src/sample.ts).

These live in the repo rather than in a table on purpose: a held-out set any
console action can silently rewrite is not held out. A label change shows up in
a diff, the set is pinned to a commit, and a score from six weeks ago can be
reproduced.

- **Status is the important field.** `candidate` is raw production feedback —
  somebody corrected the agent while working their queue. `reviewed` is a
  golden label, with a `labeler` and a `label_version`. `rejected` stays in the
  file so nobody re-imports it next month. Only `reviewed` samples are scored,
  and only they contribute to the dataset id, so adding candidates never
  invalidates a pinned baseline.
- **Split** is derived from a hash of the ticket id, so adding samples never
  reshuffles what was already held out. Hold the `holdout` split back from
  prompt iteration; iterate on `train`.
- **Export never overwrites.** `npm run eval export` adds new ids and leaves
  existing samples exactly as they are — a label somebody reviewed by hand
  outranks whatever the database says today.
- **`input_text` is derived, not stored.** It is `subject` and `body` joined
  with the separator the prompt uses (`inputText()` in
  [`sample.ts`](../packages/eval/src/sample.ts)). Storing it as well would put
  two copies of the same requester text in one record with nothing keeping them
  equal.
- **`team` is seeded from the routing table**, by running
  `routeQueue(human_category, human_priority)`. A reviewer can overwrite it
  when the routing rules themselves are what sent the ticket wrong.
- **`fidelity: reconstructed`** marks a sample captured before the pipeline
  started storing prompt context. Its enrichment block was rebuilt from current
  data, so a replay difference on that sample may be the context rather than
  the prompt.
- **Safety labels are null until a person sets them.** The safety gate reports
  `unmeasured`, not `pass`, while they are. Label them on the ticket page's
  reclassify form, or edit the JSONL directly for the golden set.

## `baselines/`

Pinned metric snapshots, one JSON per named baseline, written by
`--save-baseline <name>` and read by `--baseline <name>`.

A baseline records the model, the prompt version, the dataset id and a
*configuration fingerprint* — model, prompt, taxonomy, routing rules, threshold
policy and the never-auto list, hashed together. Comparing across two different
dataset ids is refused rather than reported: scores from different label sets
are not a regression test. A changed fingerprint is reported as a different
configuration, with the part that moved named.

Tolerances are per metric and live in
[`packages/eval/src/baseline.ts`](../packages/eval/src/baseline.ts). Safety
misses have a tolerance of zero — one new miss is a regression.
