# SLA clocks: states and transitions

This page defines what an SLA clock reports and what can change it. The code is
[`sla.ts`](../packages/core/src/sla.ts), which holds the arithmetic,
`slaStatus` and `unrecordedBreaches`, and
[`tickets.ts`](../packages/core/src/repos/tickets.ts), which holds `setStatus`,
`applyTriage`, `overrideClassification`, `markFirstResponse` and
`recordSlaBreaches`, the only five places that write the clock columns. Every
transition and invariant below has an ID, and the tests that pin it carry that
ID in their names, so `grep T7` finds both the rule and its proof.

If this page and the code disagree, one of them has a bug. Behaviour that is
pinned but not agreed is marked **current behaviour**, and it is listed under
[Decisions](#decisions). There is none at the moment: D1 to D3 are decided.

## The rule

> **A recorded SLA result is immutable historical fact. Recalculation may
> create a new active clock, but it must not rewrite a previously recorded
> result.**

A clock is either running or it has a result. While it runs, its deadline can
move: a pause, a retriage or a change of priority can all change it. A clock
gets its result in one of two ways. Its outcome arrives (the first response, or
the resolution), or its deadline passes first and the breach is recorded. From
then on the result is history. Nothing makes it read differently, and no
restamp moves its deadline.

A pause gives time back only to a clock that was stopped, and only for the time
before its outcome. Reopening a ticket starts a new resolution clock, stamped
again, and the old clock's result stays where it was recorded. The new clock is
given back the time the ticket spent resolved or closed, so it starts with the
margin the old one had when it was resolved (D3).

"What is the clock doing now" and "what happened to it" are separate answers.
`slaStatus` gives the first, for the console, the portal and the API. The
`*_breached_at` columns and the `sla_breach` events give the second, and reports
read them. The two cannot disagree about what counts as a breach, because a
breach is recorded exactly when `slaStatus` reports one.

---

## What is stored

Every ticket has two clocks, first response and resolution. Each clock has its
own columns, and the pause columns are shared:

| Column | Meaning |
|---|---|
| `first_response_due_at`, `resolution_due_at` | The deadline. It moves when a pause ends, when a first response is recorded during a pause (that clock only), on a retriage, when a person changes the priority, and when a reopen starts a new resolution clock (which is credited the time spent resolved, and stamped for the priority the ticket has by then), and at no other time. A clock whose outcome is recorded keeps its deadline through a pause and through a priority change. A clock whose breach is recorded keeps it through a priority change (T15). |
| `first_response_warn_at`, `resolution_warn_at` | When the clock becomes `due_soon`. A share of the window (`sla_warning_at_percent`), stamped once and moved with the deadline. |
| `first_response_at`, `resolved_at` | The outcome. Once set, it decides the clock, unless a breach was recorded first. `resolved_at` is cleared on reopen. |
| `first_response_breached_at`, `resolution_breached_at` | The deadline each target first missed, which is the instant it breached. Set once, by the first write or sweep that sees the breach, in the same transaction as an `sla_breach` event. Never cleared, not even by a reopen. Reports read these. |
| `resolution_clock_breached` | Whether the resolution clock running now has a recorded breach. Set with the breach, and cleared by a reopen, which starts a new clock. The first response has one clock for the life of the ticket, so it needs no flag. |
| `sla_paused_at` | When the current pause began. Null while the clock runs. |
| `sla_paused_minutes` | The total time given back across every pause, in the units the clock runs in. Credited to both clocks. |
| `sla_resolved_minutes` | The total time given back to the resolution clock for time spent `resolved` or `closed`, across every reopen, in the units the clock runs in. Credited to the resolution clock only: a resolution does not stop the first-response clock (D3). |

P1 runs on calendar time and the other priorities on business hours, per tenant
(`sla.calendar_priorities`). A pause is always measured in the units of the
clock it pauses.

## What a clock reports

`slaStatus` is the only function that decides a clock's state. The console, the
ticket page, the portal and the REST API all call it, and the warning sweep
reads the same stored instants. For each clock it applies these rules in order:

1. If there is no deadline, the clock is **`none`**.
2. If an outcome is recorded, the clock is **`met`** when the outcome is at or
   before the deadline and no breach is recorded, and **`breached`** otherwise.
   This result is final (I4).
3. The **read instant** is `sla_paused_at` when the clock is paused, and now
   otherwise.
4. If a breach is recorded, or the deadline is a whole minute or more before
   the read instant, the clock is **`breached`**. `minutesToNearest` is the
   deadline minus the read instant, so a paused breach does not grow.
5. If the clock is paused, it is **`paused`**, with no countdown.
6. If now is at or after the warning instant, the clock is **`due_soon`**. A
   ticket with no warning instant stays `on_track` until it breaches.
7. Otherwise it is **`on_track`**.

Rule 3 was added on 2026-09-19. Before that, a paused clock was compared with
the wall clock, and T6 and T7 below did not hold. The recorded breach in rules 2
and 4 came later the same day, with D1. Before it, a downgrade could give a
late clock a later deadline, and the reading went back to a countdown.

## Recording a breach

`unrecordedBreaches` returns every clock that `slaStatus` reports as `breached`
and whose breach is not recorded yet. For the resolution clock, "recorded" means
recorded on the clock running now (`resolution_clock_breached`). Five writers
record, each under the ticket's row lock, and each in one transaction with the
`sla_breach` event:

- `setStatus`, `markFirstResponse`, `overrideClassification` and `applyTriage`
  record whatever the locked row shows before they change it, and whatever
  their change produced after it (T17, I10).
- `recordSlaBreaches` records the clocks that breached while nobody was writing
  to their ticket. The breach sweep calls it every minute for each candidate
  `ticketsWithUnrecordedBreaches` returns. The sweep is also the backfill for
  tickets that breached before breaches were recorded at all.

Each `sla_breach` event is a `note` with this payload:

| Field | Meaning |
|---|---|
| `clock` | `first_response` or `resolution` |
| `breached_at` | The deadline the clock missed, which is the instant it breached. The event's own `created_at` is when it was recorded. |
| `priority` | The priority the clock was running at |
| `outcome_at` | The late response or resolution that decided it, or null for a clock that was still running when its breach was seen |
| `paused` | Seen while the clock was stopped, which means it breached before the pause began |
| `recorded_by` | `sweep`, `status_change`, `first_response`, `reclassification` or `retriage` |

The actor is always `system`. A person whose priority change was the first write
to see a breach did not cause it.

A reopen writes an `sla_clock` event, `action: "restarted"`, with the old
clock's result as `previous` and the time credited for being resolved as
`resolved_minutes`. It comes before anything the new clock records, so a replay
can tell the new clock's breach from the old one's, and summing
`resolved_minutes` rebuilds `sla_resolved_minutes`. The `sla_restamp` event a
reopen writes when the deadline moves carries the total as `resolved_minutes`,
beside the pause total in `credit_minutes`.

## Transitions

"Paused" means the status is `awaiting_user`. The pause columns change only
inside `setStatus`, together with a `sla_pause` event in the same transaction.
All five writers read the row `for update` inside their transaction, so a
resume, a priority change, a retriage, a first response and the breach sweep run
one after the other. Whichever goes second works from what the first wrote.
Each one computes what it writes from the row it locked, `applyTriage`
included: its stamp is computed under the lock, not by the pipeline before the
model call.

| ID | From | Event | To | What moves |
|---|---|---|---|---|
| T1 | `none` | First triage stamps the clocks | `on_track`, or a later state if triage itself was slow | Deadlines and warnings are stamped from `created_at` for the priority |
| T2 | `on_track` | The wall clock reaches the warning instant | `due_soon` | Nothing |
| T3 | `due_soon` | The wall clock passes the deadline | `breached` | Nothing. The next write or sweep records the breach (T17) |
| T4 | `on_track`, `due_soon` | The status enters `awaiting_user` | `paused` | `sla_paused_at` is set to now |
| T5 | `breached` | The status enters `awaiting_user` | `breached`, with lateness frozen | `sla_paused_at` is set to now, and the breach is recorded if nothing had recorded it yet (T17) |
| T6 | `paused` | Time passes, including past the stored deadline | `paused`, unchanged | Nothing |
| T7 | `paused` | The status leaves `awaiting_user` for any other status | `on_track` or `due_soon`, with the margin it had when it stopped. A clock whose outcome is recorded is unchanged (I4) | The deadlines and warnings of every clock still running move forward by the wait. A clock whose outcome is recorded keeps its deadline, and the resume event lists it as `settled`. `sla_paused_minutes` grows by the wait, `sla_paused_at` is cleared, and a resume event is logged |
| T8 | `breached` while paused | The status leaves `awaiting_user` | `breached`, exactly as late as before | The same as T7. A breached clock with no outcome yet still moves, by exactly the time it was stopped, and its recorded breach keeps it `breached` wherever that puts the deadline |
| T9 | `on_track`, `due_soon` | The first response (first-response clock), or `resolved` or `closed` (resolution clock), arrives in time | `met` | `first_response_at` or `resolved_at` |
| T10 | `breached` | The same, but late | `breached`, final | The same as T9, and the breach is recorded in the same transaction if nothing had recorded it yet |
| T11 | `paused` | The ticket is `resolved` or `closed` straight from `awaiting_user` | `met` or `breached`, final | T7 first, then the outcome is judged against the moved deadline |
| T12 | `paused` | A first response is recorded while paused | The first-response clock is decided: `met` if it had not breached when it stopped, `breached` if it had. The resolution clock stays `paused` | `first_response_at`. The first-response deadline and warning move forward by the part of the pause before the response, with an `sla_pause` `credited` event, unless the clock had breached when it stopped or its breach is recorded, in which case they stay where they are. `sla_paused_minutes` does not change, because the resume credits the whole pause to the resolution clock |
| T13 | `met`, `breached` (final) | The ticket is reopened, meaning any status out of `resolved` or `closed` | A new resolution clock with the margin the old one had when it was resolved: `on_track` or `due_soon` if it was met, `breached` if it was late. A priority change while resolved puts it on the new priority's window instead (D3) | The time since `resolved_at` is measured in the units of the current priority's clock and added to `sla_resolved_minutes`. `resolved_at` and `resolution_clock_breached` are cleared, and an `sla_clock` `restarted` event records the old clock's result and the credit. `resolution_breached_at` is kept. The new clock is stamped from `created_at` for the current priority plus `sla_paused_minutes` and `sla_resolved_minutes`, with an `sla_restamp` event when that moves it. The first-response clock does not move. If the new clock's deadline has already gone, which happens when the old clock was resolved late or the priority was raised while resolved, it is breached at once and records its own breach (T17) |
| T14 | any | A retriage | Unchanged if the priority is unchanged. A settled clock keeps its result (I4) | Any breach the locked row shows is recorded first (T17). Running clocks are then restamped from `created_at` plus the locked row's `sla_paused_minutes`, so a resume that committed while the model was running is carried, and a clock whose outcome or breach is recorded keeps its deadline. If the ticket is paused and the new status is not `awaiting_user`, T7 runs through `setStatus` |
| T15 | any | A person changes the priority in the console | Running clocks: whatever the new stamp says. Settled clocks: unchanged (I4) | Any breach the locked row shows is recorded first (T17). Running clocks are then restamped from `created_at` for the new priority plus `sla_paused_minutes`, and a clock whose outcome or breach is recorded keeps its deadline. An `sla_restamp` event in the same transaction records what moved and which clocks were kept as settled. An upgrade onto a deadline that has already gone is recorded after the restamp. An open pause stays open, and T7 credits it on resume. A change of category alone moves nothing (D2) |
| T16 | `paused` | The status is set to `awaiting_user` again | `paused` | Nothing. The original `sla_paused_at` is kept |
| T17 | `breached`, not recorded | Any clock writer, or the breach sweep, reads the row under its lock | `breached`, recorded | `*_breached_at` is set to the missed deadline, `resolution_clock_breached` too for the resolution clock, and an `sla_breach` event is written, in one transaction. A writer records before its own change and again after it. A clock already recorded records nothing more |

T8 has one sub-minute case on business-hours clocks. Suppose a ticket was due at
closing time and paused later that evening. It was late by the calendar but by
zero working minutes. On resume it gets back the working time the requester held
it, counted from the next opening, so its deadline lands exactly on the resume
instant. The deadline alone reads `due_soon` for under a minute there, and until
D1 the console showed exactly that. The pause recorded the breach as it began
(T5), so the ticket now reads `breached` throughout. The business-time lateness
is preserved exactly: zero before and zero after.

A first response recorded during a pause like that is credited nothing.
Crediting it would put the deadline exactly on the response and record `met`,
against a breach the console had reported since the evening before. A clock
that had breached when it stopped, or whose breach is recorded, is credited
nothing, so the response is recorded as `breached` (T12, I8).

## Invariants

| ID | Invariant |
|---|---|
| I1 | A stopped clock does not change. While the clock is paused, neither its state nor its minutes depend on the wall clock. |
| I2 | If a running clock has reported a breach, any pause and resume leaves it reporting that breach, from the resume instant on. |
| I3 | A pause never hides a breach: `breached` outranks `paused`. |
| I4 | A recorded result is final until the ticket is reopened. A result is recorded when the outcome arrives or when the breach is recorded, whichever comes first. Neither a priority change (T14, T15) nor a pause (T7, T12) changes it, so the result a clock reads when its result is recorded is the result it reads afterwards. A reopen starts a new resolution clock and leaves the old clock's result where it was recorded. |
| I5 | A clock with no recorded result has the stamp for the ticket's current priority, counted from `created_at` and extended by `sla_paused_minutes`, and the resolution clock by `sla_resolved_minutes` as well. A clock whose result is recorded keeps the deadline it was settled against, except that a breached clock still waiting for its outcome is moved by a pause, by exactly the time it was stopped (T8). |
| I6 | Every deadline movement caused by a pause (including a first response credited during one), by a person changing the priority, or by a reopen restamp is on the event log, written in the same transaction as the columns. So is every recorded breach (`sla_breach`) and every reopen that starts a new resolution clock (`sla_clock`). |
| I7 | Only `awaiting_user` stops the clock. Waiting on an approver, or on the desk's own work, is the desk's time. |
| I8 | A pause credits a clock only for time it was stopped before its outcome was recorded. A first response recorded during a pause is `breached` exactly when the clock had breached before it stopped. |
| I9 | A recorded breach is never cleared. `first_response_breached_at` and `resolution_breached_at` are set once and never cleared, not even by a reopen. A clock whose breach is recorded reads `breached` whatever its deadline or outcome says, until a reopen starts a new resolution clock. Each clock records its breach exactly once: a second evaluation, a retry or a concurrent sweep records nothing more. |
| I10 | No change can hide a breach before it is recorded. Every clock writer records what its locked row shows before it changes anything, and the sweep records the rest within a minute. |
| I11 | Time a ticket spends `resolved` or `closed` never counts against the resolution clock. A reopen gives it back, so the new clock's margin at the reopen is the old clock's margin at the resolution, early or late. It never counts for or against the first-response clock either, which a resolution does not stop. |

## Which tests pin what

| ID | Tests |
|---|---|
| T1–T3 | `sla.test.ts`: "the SLA state machine" T1–T3, and "SLA status" and "due soon" |
| T4 | `sla.test.ts` T4; `sla-pause.integration`: "stops the clock on the way in" |
| T5, I3 | `sla.test.ts` T5 T8 I2 and T5 T6 T17; `sla-pause.integration`: "stays breached through a pause"; `sla-adversarial.integration` E; `sla-breach.integration` T5 T17 and T5 T8 I9, for each clock |
| T6, I1 | `sla.test.ts` T6 I1, T6 T7, T5 T6 T17, and "does not call a deadline that passes while the clock is stopped a breach"; `sla-adversarial.integration` E2; `sla-breach.integration` "the breach sweep" T6 |
| T7 | `sla.test.ts` T7 (twice), T7 I4, and "pausing the clock" (including "leaves a clock whose outcome is recorded where it was"); `sla-pause.integration`: "gives the time back on the way out", and under "a first response and a pause" T7 I4 and "T7 a resume waiting on a first response"; `sla-adversarial.integration` F, F2, F3, G, J |
| T8, I2 | `sla.test.ts` T5 T8 I2, I2 (a grid of pause and resume instants on a business clock, read at the resume instant), and T8 I2 (late only after closing); `sla-pause.integration`: "is still breached after the time is given back"; `sla-breach.integration` T5 T8 I9, for each clock |
| T9, T10, I4 | `sla.test.ts` T9, T10 I4, T7 I4 and the three T12 I4 tests; `sla-pause.integration`: T14 I4, T15 I4, T15 I4 T13, and T7 I4 and T12 I4 under "a first response and a pause"; `sla-breach.integration` T10 T17, for each clock |
| T11 | `sla.test.ts` T11; `sla-pause.integration`: "restarts when the ticket is resolved straight out of the pause" and T11 (closing); `sla-adversarial.integration` D |
| T12, I8 | `sla.test.ts`: T12, T12 I4 (twice), T12 I8 (a recorded breach), and on the business clock T12 I4 (a grid of pause, response and resume instants) and "T12 a first response late only in the hours after closing"; `sla-pause.integration` "a first response and a pause": both T12 I4 tests, a second response, and a response racing a resume; `sla-adversarial.integration` T12 I6 |
| T13, I11 | `sla.test.ts` T13 D3 (the credit, and a weekend on the business clock), T13 I5 D3 (a later restamp keeps it), T13 I9 (a new clock after a priority change) and T13 I9 D3 (the margin kept, met and late); `sla-pause.integration`: T15 I4 T13 (the restamp) and "T13 a reopen moves nothing when nothing changed while it was resolved"; `sla-breach.integration` "a reopen": T13 I9, and T13 I9 D3 for a reopen days after an on-time resolution and for one resolved late; `replay.integration` "reconstructs the time credited for being resolved across two reopens" |
| T14, I5 | `sla.test.ts` T14 I5 (twice); `sla-pause.integration`: "a retriage landing on a paused ticket", including a retriage waiting on a resume and the two at once in either order, and T15 I5; `pipeline.integration`: "keeps the SLA credit a ticket has earned when it is retriaged" and "keeps the credit of a reply that lands while the model is thinking"; `sla-breach.integration` T14 I9 (twice), for each clock, and under "a breach and a writer at once" a retriage waiting on an upgrade that breached, recorded (T14 I9) and not yet recorded (T14 T17) |
| T15 | `sla-pause.integration`: "a human reclassification" (the restamp and its event, the credit, an open pause, settled clocks, a category-only change, and a priority change racing a resume in both orders); `sla-adversarial.integration` T15 I6; `sla.test.ts` T15 I9 (three) and T15 T17; `sla-breach.integration` T15 I9 (three for each clock) and "a downgrade waiting on the sweep" |
| T16 | `sla-pause.integration`: "does not restart the pause when the same status is set twice"; `sla-adversarial.integration` A, A2 |
| T17, I9, I10 | `sla.test.ts` T17 I9 (recorded once), T17 (a late answer or resolution), I9 (reads breached); `sla-breach.integration`: for each clock, T17 (recorded at the deadline), I9 (a second evaluation), and the "records a breach nobody had recorded" tests for a downgrade, a pause and a retriage; "the breach sweep"; "I9 a sweep, a downgrade and a resolution at once"; `replay.integration` "recorded breaches" |
| I6 | `sla-adversarial.integration`: "leaves no pause unexplained on the timeline", "moves nothing when the event cannot be written", T15 I6 and T12 I6; `sla-pause.integration` T14 and T15; `sla-breach.integration` I6 I9, for each clock; `replay.integration` "recorded breaches" |
| I7 | `sla-pause.integration` I7 |

---

## Decisions

These are product rules rather than defects. While one is open, its current
behaviour is pinned by a test named **DOCUMENTS CURRENT BEHAVIOUR**, so changing
it takes a deliberate decision. All three below are decided, and no test
carries that name now.

### D1: Is a breach a recorded fact, or only the current reading? (decided 2026-09-19)

**Decided: a recorded fact.** Until then a breach existed only as whatever
`slaStatus` said when somebody asked. Lowering the priority of an open ticket
that was already late restamped a later deadline, and the breach was gone from
the console and from anything that might report on it. SLA reporting had
nowhere to read "was this ticket ever breached" from (SLA-09 in the
[feature audit](feature-audit.md)).

Each target now has a `*_breached_at` column, set once by the first write or
sweep that sees the breach, with an `sla_breach` event in the same transaction,
and never cleared. Every clock writer records what its locked row shows before
it changes anything (I10), so no change can hide a breach first. A clock whose
breach is recorded reads `breached` from then on (I9), and it keeps the
deadline it missed through a priority change or a retriage. Keeping it there
means an upgrade cannot make the clock read later than it was, and a downgrade
cannot put a failed clock back into a countdown.

The resolution target can have more than one clock, because a reopen starts a
new one. So `resolution_clock_breached` says whether the clock running now has
breached. A reopen clears that flag and never touches `resolution_breached_at`.
If the new clock breaches too, it records its own event, and the first breach of
the target stays the first.

Two consequences follow:

- The T8 case no longer blinks. A ticket late only in the hours after closing
  used to read `due_soon` for the first minute after a resume. It now reads
  `breached` throughout.
- Under D3's behaviour at the time, a reopen onto a deadline that passed while
  the ticket was resolved recorded a breach that stayed recorded. D3 has since
  been decided, and a reopen no longer does that.

Not included here: a breach notification, and the compliance report that reads
these columns (SLA-09 and SLA-13 in the feature audit).

### D2: Should a change of priority move the deadlines? (decided 2026-09-19)

**Decided: yes, on both paths.** Until then they disagreed. A retriage
restamped the deadlines from `created_at` for the new priority (T14), while a
person correcting the priority in the console changed only the priority. So a
P3 that a person re-marked as P1 kept a P3 deadline.

Both now restamp from `created_at` and carry the credit, because the ticket was
always that priority. The console path logs an `sla_restamp` event in the same
transaction, so the replay can explain the moved deadline (T15, I6).

**Also decided that day: a settled result stays settled.** A clock whose outcome
is already recorded keeps its deadline, on both paths. Without that, a reviewer
relabelling closed tickets for the calibration table could turn a target the
desk met into a breach, or erase one. A reopen unsettles the resolution clock
and stamps it for the priority the ticket has by then (T13). Since D1, a
recorded breach settles a clock in the same way, so a downgrade can no longer
un-report a breach on a clock that is still running.

### D3: Does time spent resolved count against the desk after a reopen? (decided 2026-09-19)

**Decided: no.** Until then it did. Reopening cleared `resolved_at` and started
a new resolution clock, stamped from `created_at` like the old one, so it had
the deadline the old one had. A requester who reopened three days after a fix
that was on time landed the desk an immediate breach for days in which the desk
was waiting on the requester. Since D1 that breach was permanent: the reopen
recorded it at once, with `breached_at` set to a moment when the ticket was
resolved.

`resolved` and `closed` now stop the resolution clock, because the ball is with
the requester, as it is in `awaiting_user`. A reopen credits the time since
`resolved_at`, so the new clock starts with the margin the old one had when it
was resolved (T13, I11). A ticket resolved late is reopened exactly as late, and
its new clock records its own breach at once, as before.

Three details were decided with it:

- **Closed is the same as resolved.** A requester's reply reopens a closed
  ticket too, and the follow-up sweep closes resolved tickets after a day by
  default. If closing ended the clock for good, most reopens would fall back to
  the old behaviour. `resolved_at` survives a close, so the credit runs from the
  resolution to the reopen, however much of it the ticket spent closed.
- **The first-response clock is not affected.** A resolution does not stop it.
  In almost every case it has settled long before, and when it has not, the
  desk still owes a response. So the credit has its own column,
  `sla_resolved_minutes`, rather than going into `sla_paused_minutes`, which
  every restamp gives to both clocks.
- **Nothing recorded before is rewritten.** A breach an earlier reopen recorded
  under the old rule stays recorded, as D1 requires. There is no backfill: a
  ticket resolved now is credited from its `resolved_at` whenever it is next
  reopened.

The pause columns were not reused. `sla_paused_at` means the status is
`awaiting_user`, and the console, the warning sweep, the breach sweep and the
first-response clock all read it that way. `resolved_at` already marks the
start of the stop.

---

## Known limits

- **A priority change that crosses clocks.** `sla_paused_minutes` and
  `sla_resolved_minutes` count in the units of the clock they were measured on.
  A retriage or a person that moves a ticket between the calendar clock (P1)
  and business hours carries those totals across as a plain count of minutes.
  The result is exact whenever the clock type is unchanged, which covers every
  retriage that keeps its priority and every change within P2–P4.
- **A breach on a ticket nobody touches is recorded up to a minute late.** The
  reading shows it at once, and the record waits for the next write or the
  sweep. `breached_at` is the missed deadline either way, so reports are exact.
  Only the event's timestamp is late.
- **A breach from before 0017** is recorded by the sweep against the deadline
  the row has now. If a breached clock was paused and resumed before 0017, the
  pause moved its deadline, so its `breached_at` is that moved deadline rather
  than the one it first missed.
