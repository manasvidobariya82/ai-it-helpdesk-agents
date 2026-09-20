# Feature audit against the master list

The 43-module master feature list, checked against the repository on
2026-09-17. Every status below was verified by reading the code, the schema or
the tests — not by reading [roadmap.md](roadmap.md), which audits a different
and smaller list.

**Legend**

| | Meaning |
|---|---|
| ✅ | Implemented. Working, and where it matters, tested |
| ⚠️ | Partial. The substrate exists, the feature does not — the gap is named |
| 🟡 | Stub. Registered, wired, and honest at runtime that it is simulated |
| ❌ | Missing. Not started |

A note on ⚠️ versus ❌, because it is the distinction that makes this document
useful: ⚠️ means the next person has somewhere to start — a table, a type, a
function that already does half of it. ❌ means a blank file.

---

## Headline

**About 625 rows once every bulleted sub-list is counted: 237 implemented, 124
partial, 9 stubbed, 256 missing.** That is 38% implemented and 58% at least
started. Section-by-section tallies are under each table.

The shape of that result is more useful than the number. This repository is
**deep in a narrow column and empty either side of it**:

- **Agent safety, evaluation, tenancy and authorization are near-complete** —
  sections 21, 22, 29, 34 and 39 are the strongest in the build, and several are
  more thorough than the list asks for. Prompt injection, PII redaction, the
  risk-tier gate, approval expiry, calibration and the cross-tenant attack suite
  are all real and tested.
- **The ITSM surface around them is largely absent.** No chat agent (section 7),
  no troubleshooting agent (9), no problem management (15), no service catalog
  (17), no workflow engine (19). These are five whole modules at zero.
- **The ticket model is narrower than the list assumes.** No tags, no watchers,
  no attachments in storage, no severity. Comments and internal notes arrived
  with the conversation (section 4). Every ITSM product on the
  market has these; this one has an event log instead, which is better for
  answering "why did the agent do that" and worse for everything a human agent
  does hour to hour.

The one-line summary: **this is an AI triage-and-reply engine with
production-grade safety rails, not yet a helpdesk.** The engine is the hard
part and it is built. The helpdesk around it is mostly not.

### What this changes about the roadmap

[roadmap.md](roadmap.md) audits 255 features and reports 69 built. That document
is not wrong, but it scopes "the platform" to what this build set out to be. The
master list scopes it to what an enterprise ITSM tool is, and against that
denominator the figure is 38%, against the 27% the roadmap reports on its own
255 rows. Both numbers are true of the same repository; they differ because the
denominators do. If the goal is the master list, the roadmap's phase order
needs a sixth block it does not currently have — the human-agent surface
(comments, notes, tags, attachments) — because every AI feature in sections 7,
9 and 11 assumes a conversation model. That model now exists
([conversation.md](conversation.md)), and the product writes to it.

---

## 1. Authentication & Identity

| ID | Feature | Status | Evidence / gap |
|---|---|---|---|
| AUTH-01 | User registration | ⚠️ | `inviteUser` creates a user inside a tenant; no self-serve signup |
| AUTH-02 | User login | ✅ | `signIn`, `/login`, scrypt verify |
| AUTH-03 | Logout | ✅ | `signOutAction` → `revokeSession` |
| AUTH-04 | JWT authentication | ❌ | Deliberate. Opaque server-side sessions, because a JWT cannot be revoked |
| AUTH-05 | Refresh tokens | ❌ | Not applicable without JWT; sessions carry a TTL and a revocation column |
| AUTH-06 | Password hashing | ✅ | scrypt, `auth/password.ts` |
| AUTH-07 | Forgot password | ❌ | |
| AUTH-08 | Reset password | ❌ | `identity.reset_password` is a tool for *end-user directory accounts* — a different thing from console credentials |
| AUTH-09 | Change password | ❌ | |
| AUTH-10 | Email verification | ❌ | |
| AUTH-11 | Account activation/deactivation | ⚠️ | `removeMember` + `revokeAllSessionsFor`; `staff.active` exists; no disable flag on `users` |
| AUTH-12 | Session management | ✅ | `sessions` table, `resolveSession`, expiry |
| AUTH-13 | Multiple active sessions | ✅ | One row per session |
| AUTH-14 | Session revocation | ✅ | `revokeSession`, `revokeAllSessionsFor` |
| AUTH-15 | SSO | ❌ | |
| AUTH-16 | OAuth | ❌ | |
| AUTH-17 | MFA / 2FA | ❌ | Only appears as ticket subject text and a redaction pattern |
| AUTH-18 | API authentication | ✅ | `api_keys`: hashed, role-carrying, revocable, rate-limited |
| AUTH-19 | Service accounts | ⚠️ | API keys fill the role; no service-account identity type |
| AUTH-20 | Login audit logs | ✅ | `auditAnonymous` records attempts, including failures |

**✅ 8 · ⚠️ 3 · ❌ 9**

The gap worth naming: **seven of the nine missing items are one feature — an
account-lifecycle surface.** Registration, verification, forgot/reset/change
password are a single afternoon's work sharing one mail template and one signed
token, and the signed-token machinery already exists in `links.ts` for portal
and unsubscribe links.

---

## 2. RBAC & Permissions

| ID | Feature | Status | Evidence / gap |
|---|---|---|---|
| RBAC-01 | Role management | ⚠️ | Six roles fixed in `auth/permissions.ts`; assignable, not editable |
| RBAC-02 | Permission management | ⚠️ | 24 permissions, same file, same constraint |
| RBAC-03 | Role assignment | ✅ | `setRole`, `inviteUser`, both audited |
| RBAC-04 | User-level permissions | ❌ | Permissions come from the role only |
| RBAC-05 | Resource-level permissions | ⚠️ | Tenant scoping enforced in every query; no per-record ACL |
| RBAC-06 | Ticket permissions | ✅ | 7 ticket permissions, including `ticket_internal:read` for the desk's side of a conversation |
| RBAC-07 | Knowledge-base permissions | ✅ | `kb:read/create/update/publish` |
| RBAC-08 | Admin permissions | ✅ | |
| RBAC-09 | Agent permissions | ✅ | |
| RBAC-10 | Viewer permissions | ✅ | |
| RBAC-11 | Permission middleware | ✅ | `requirePermission`, `requireConsole`, `withApi` |
| RBAC-12 | Permission validation | ✅ | `permissions.test.ts`, `authorization.test.ts`, `tenant-scoping.test.ts` |
| RBAC-13 | Custom roles | ❌ | |
| RBAC-14 | Role hierarchy | ✅ | `grantableRoles` — you cannot grant what you do not hold |

**✅ 9 · ⚠️ 3 · ❌ 2**

**Roles: 6 of your 12.** Present: `viewer`, `agent`, `manager`, `admin`,
`security_admin`, `super_admin`. Missing: IT Manager, Senior IT Agent, and the
four specialist agent roles (Security / Network / Hardware / Software), plus
Employee and Auditor. The specialists are cheap — `ROLE_PERMISSIONS` is one
table — but note that specialist *roles* and specialist *queues* are different
axes, and this build currently expresses "who handles networking" as
`staff.queue` rather than as a role.

Auditor is the interesting omission: it wants `audit:read` and
`analytics:read` with nothing else, and no existing role is that shape.

---

## 3. User / Employee Management

| ID | Feature | Status | Evidence / gap |
|---|---|---|---|
| USER-01 | Employee profile | ✅ | `requesters` |
| USER-02 | Employee ID | ⚠️ | `directory_id` holds the IdP object id; no HR employee number |
| USER-03 | Department | ✅ | `requesters.department` |
| USER-04 | Team | ⚠️ | `staff.queue` for agents; requesters have none |
| USER-05 | Manager | ❌ | Blocks manager-approval workflows (APP-02) |
| USER-06 | Job title | ✅ | `requesters.role` |
| USER-07 | Location | ❌ | |
| USER-08 | Contact information | ⚠️ | Email only; no phone |
| USER-09 | User status | ⚠️ | `staff.active`; requesters have no status |
| USER-10 | User preferences | ⚠️ | `notification_optouts` only |
| USER-11 | User timezone | ⚠️ | Timezone is per tenant in settings, not per person |
| USER-12 | Assigned assets | ✅ | `assets.requester_id` + `primaryAsset` enrichment |
| USER-13 | Ticket history | ✅ | `ticketsForRequester`, `recentTicketsFor` |
| USER-14 | User activity history | ⚠️ | `audit_events` covers console users; requesters are not tracked |
| USER-15 | User search | ⚠️ | `findRequesterByEmail` is exact-match; no search UI |
| USER-16 | Bulk user import | ❌ | Seed script only |
| USER-17 | Bulk user update | ❌ | |

**✅ 5 · ⚠️ 8 · ❌ 4**

**USER-05 is load-bearing.** Without a manager relationship there is no manager
approval, which is the most common approval type in an IT service catalog — so
this one missing column blocks a chunk of sections 17 and 18.

---

## 4. Ticket Management

| ID | Feature | Status | Evidence / gap |
|---|---|---|---|
| TKT-01 | Create ticket | ✅ | `intakeMessage` — one door for email, portal and API |
| TKT-02 | Update ticket | ⚠️ | Status, classification and assignment only; no general field edit |
| TKT-03 | Delete ticket | ❌ | Deliberate: the event log is append-only |
| TKT-04 | View ticket | ✅ | |
| TKT-05 | Search tickets | ✅ | `listTickets({search})`, exposed on the API |
| TKT-06 | Filter tickets | ✅ | status, priority, category |
| TKT-07 | Sort tickets | ⚠️ | Fixed ordering; no sort parameter |
| TKT-08 | Ticket status | ✅ | 8-value enum |
| TKT-09 | Ticket priority | ✅ | P1–P4 |
| TKT-10 | Ticket severity | ❌ | Priority carries both axes today |
| TKT-11 | Ticket category | ✅ | |
| TKT-12 | Ticket subcategory | ✅ | Free text, ≤ 60 chars |
| TKT-13 | Ticket assignment | ✅ | `assigned_to`, `bulkAssign`, notified |
| TKT-14 | Team assignment | ⚠️ | Escalation routes to a queue; no team column on the ticket |
| TKT-15 | Ticket comments | ✅ | The conversation ([conversation.md](conversation.md)): requester messages from intake, replies from the agent and the console, read by the console, the portal and the API. Older tickets are copied in (D4) |
| TKT-16 | Internal notes | ✅ | The console's note form writes `internal` messages, readable only with `ticket_internal:read`, which the portal lacks |
| TKT-17 | Attachments | ⚠️ | Metadata per message, in order, in `conversation_attachments`, from intake's opening messages and replies; no storage, upload or download |
| TKT-18 | Ticket history | ✅ | `ticket_events`, append-only, enforced by trigger |
| TKT-19 | Activity timeline | ✅ | Ticket detail page |
| TKT-20 | Ticket tags | ❌ | |
| TKT-21 | Ticket watchers | ❌ | |
| TKT-22 | Ticket followers | ❌ | |
| TKT-23 | Ticket linking | ⚠️ | `parent_incident_id` and `merged_into_id` only — two fixed relations, not a link table |
| TKT-24 | Ticket merging | ✅ | `mergeInto`, proposed by the agent, decided by a person |
| TKT-25 | Ticket splitting | ❌ | |
| TKT-26 | Ticket duplication | ⚠️ | Duplicate *detection* is built; cloning a ticket is not |
| TKT-27 | Reopen ticket | ✅ | `reopened_count`, `reopened` status |
| TKT-28 | Close ticket | ✅ | |
| TKT-29 | Resolve ticket | ✅ | |
| TKT-30 | Bulk ticket actions | ✅ | `bulkAssign`, `bulkStatus` |

**✅ 18 · ⚠️ 6 · ❌ 6**

**TKT-15 was the most consequential gap in the entire audit.** There was no
comment or conversation model on a ticket — only an event log plus an outbound
mail queue. That is excellent for auditing an agent and poor for two humans
working a ticket together, and it is the reason sections 7 (chat), 11 (copilot)
and much of 9 (troubleshooting) could not be built as specified: they all assume
a threaded conversation to read from and write into.

It now exists ([conversation.md](conversation.md)), and intake, replies, drafts
and the console write to it. What is left of the old gap is stored attachments
(TKT-17).

---

## 5. Ticket Status Workflow

Your proposed states: NEW → TRIAGED → ASSIGNED → IN PROGRESS → WAITING FOR USER
→ WAITING FOR APPROVAL → ESCALATED → RESOLVED → CLOSED.

Built: `new`, `triaged`, `awaiting_user`, `awaiting_approval`, `in_progress`,
`resolved`, `closed`, `reopened`.

Two differences worth a decision rather than a patch. **`assigned` is not a
status** — assignment is a column, so a ticket can be assigned in any state,
which is more expressive than a status that assignment overwrites. **`escalated`
is not a status either** — it is a `resolution_path`, so "escalated" and "in
progress" are independent facts rather than one overwriting the other. Both
choices look like omissions on the list and are defensible as built; adopting
your list literally would lose information.

| Feature | Status | Evidence / gap |
|---|---|---|
| Custom statuses | ❌ | Postgres enum |
| Status transitions | ⚠️ | `setStatus` applies and logs; no declarative transition table |
| Transition validation | ⚠️ | Validated at call sites, not centrally |
| Workflow rules | ❌ | |
| Automatic status updates | ✅ | Pipeline drives them; a dead-lettered reply reverts to `triaged` |
| Resolution codes | ⚠️ | `resolution_path` (5 values) is close, but it records *who* resolved it, not *how* |
| Closure reasons | ❌ | |

**✅ 1 · ⚠️ 3 · ❌ 3**

---

## 6. AI Ticket Triage Agent

| ID | Feature | Status | Evidence / gap |
|---|---|---|---|
| AI-TRIAGE-01 | Intent detection | ⚠️ | Category prediction does the job; no separate intent field |
| AI-TRIAGE-02 | Category prediction | ✅ | Constrained decoding against an enum |
| AI-TRIAGE-03 | Subcategory prediction | ✅ | |
| AI-TRIAGE-04 | Priority prediction | ✅ | |
| AI-TRIAGE-05 | Severity prediction | ❌ | No severity axis |
| AI-TRIAGE-06 | Department prediction | ❌ | |
| AI-TRIAGE-07 | Team prediction | ⚠️ | `routeQueue` maps category → queue by table, not by model |
| AI-TRIAGE-08 | Agent recommendation | ❌ | Routes to a queue, never to a person |
| AI-TRIAGE-09 | SLA classification | ✅ | `computeSla` from priority and business hours |
| AI-TRIAGE-10 | Duplicate detection | ✅ | `duplicate_of_hint`, proposed not applied |
| AI-TRIAGE-11 | Related-ticket detection | ✅ | `recentTicketsFor`, `activeIncidents` |
| AI-TRIAGE-12 | Sentiment detection | ❌ | |
| AI-TRIAGE-13 | Urgency detection | ✅ | Expressed as priority |
| AI-TRIAGE-14 | Entity extraction | ⚠️ | `affected_system` only; enrichment resolves requester and asset by lookup, not NER |
| AI-TRIAGE-15 | Ticket summarization | ⚠️ | `reasoning` (≤ 400 chars) explains the decision; not a ticket summary |
| AI-TRIAGE-16 | Missing-information detection | ✅ | `missing_info`, drives the clarify path |
| AI-TRIAGE-17 | Auto-tagging | ❌ | Needs TKT-20 first |

**✅ 8 · ⚠️ 4 · ❌ 5**

This module is the best-built in the repository and goes beyond the list in one
way the list does not ask for: `is_security_sensitive` and
`is_destructive_request` are separate booleans that the decision branch treats
as hard gates regardless of confidence, and `validateTriage` rejects a
security-sensitive ticket classified P3/P4 before it reaches the database.

---

## 7. AI Helpdesk Chat Agent

**All 18 features ❌.** No chat interface, no conversation model, no
multi-turn state. Zero matches for "chat" anywhere in the source.

The nearest thing is the requester portal (`/portal/new` and a signed status
link), which is a form and a status page rather than a conversation.

No longer blocked by TKT-15: the conversation is where a chat agent's turns
would go ([conversation.md](conversation.md)). A conversation that starts before
its ticket is listed there under "Not yet".

---

## 8. RAG / Knowledge Base

| ID | Feature | Status | Evidence / gap |
|---|---|---|---|
| KB-01 | Knowledge-base creation | ✅ | `kb_documents`, `kb_chunks` |
| KB-02 | Document upload | ⚠️ | `npm run kb:ingest` from a folder; no upload UI |
| KB-03 | PDF support | ❌ | |
| KB-04 | DOCX support | ❌ | |
| KB-05 | TXT support | ⚠️ | Works through the markdown path; not a declared format |
| KB-06 | Markdown support | ✅ | The only first-class format |
| KB-07 | URL ingestion | ❌ | `source_url` is stored but never fetched |
| KB-08 | Document parsing | ⚠️ | Markdown only |
| KB-09 | Text cleaning | ⚠️ | Chunking normalises; no dedicated cleaning stage |
| KB-10 | Chunking | ✅ | `chunkDocument` |
| KB-11 | Embeddings | ✅ | `hash` (local, deterministic) or `openai` |
| KB-12 | Vector database | ✅ | pgvector |
| KB-13 | Semantic search | ✅ | `retrieve` |
| KB-14 | Hybrid search | ❌ | Vector only |
| KB-15 | Metadata filtering | ⚠️ | `categories` column exists; retrieval does not filter on it |
| KB-16 | Reranking | ❌ | |
| KB-17 | Context retrieval | ✅ | `formatExcerpts` into the prompt |
| KB-18 | Source citations | ✅ | Cited in drafts and shown in the console |
| KB-19 | Document versioning | ⚠️ | Supersession by `content_hash`; no version history |
| KB-20 | Document deletion | ❌ | No delete function |
| KB-21 | Document update | ⚠️ | Re-ingest supersedes |
| KB-22 | Access-controlled documents | ⚠️ | Tenant-scoped and `kb:read`-gated; no per-document ACL |
| KB-23 | Knowledge-base categories | ✅ | |
| KB-24 | FAQ management | ❌ | |
| KB-25 | Article management | ⚠️ | List and stats; no editor |
| KB-26 | Article feedback | ❌ | |
| KB-27 | Search analytics | ❌ | |
| KB-28 | Failed-search detection | ❌ | The groundedness gate knows when retrieval was too weak to answer — it just does not record it as a knowledge gap |

**✅ 9 · ⚠️ 9 · ❌ 10**

KB-28 is the cheap win here: the decision branch already computes "retrieval was
insufficient" on every ticket and throws the fact away. Persisting it is a
handful of lines and gives you knowledge-gap detection (ADV-08) nearly free.

---

## 9. AI Troubleshooting Agent

**All 15 features ❌.** No decision trees, no playbooks, no diagnostic steps, no
verification loop. Zero matches for "troubleshoot" in the source.

What exists adjacent to it: runbooks in the knowledge base, and a drafted reply
that may quote troubleshooting steps from one. That is retrieval, not a
troubleshooting agent — nothing tracks which step the user is on, whether it
worked, or what to try next.

This is the largest single module missing, and the most valuable one left.

---

## 10. AI Agent Orchestrator

| Feature | Status | Evidence / gap |
|---|---|---|
| Agent registration | ❌ | One pipeline, not a registry |
| Agent routing | ❌ | |
| Agent selection | ❌ | |
| Agent handoff | ❌ | |
| Agent state | ⚠️ | `agent_runs` records a run; no resumable state |
| Shared context | ❌ | |
| Memory | ⚠️ | `recentTicketsFor` gives per-requester history; no agent memory store |
| Tool calling | ✅ | `packages/tools`, registry-based |
| Function calling | ✅ | Constrained decoding, `callStructured` |
| Workflow execution | ⚠️ | Fixed pipeline (enrich → triage → retrieve → decide → draft → write back) |
| Retry handling | ✅ | Gateway retry on validation failure; BullMQ retries with backoff |
| Timeout handling | ⚠️ | Health checks time out; model calls rely on the SDK default |
| Error recovery | ⚠️ | Dead-letter + ticket reverts to `triaged` for a human |
| Agent permissions | ✅ | `agentContext` — cannot hold `config:update` or `action:approve`, asserted by test |
| Human-in-the-loop | ✅ | Approval queue, risk tiers, expiry |
| Execution tracing | ✅ | `ticket_events` + `tool_calls` + `agent_runs` |
| Agent logs | ✅ | Same |

**✅ 7 · ⚠️ 5 · ❌ 5**

The honest reading: **this is a pipeline, not an orchestrator**, and the
orchestration primitives that exist (tool calling, permissions, tracing,
human-in-the-loop) are the ones that make a future orchestrator safe. The five
❌s are the routing layer. Given there is exactly one agent today, building a
registry now would be architecture ahead of need — the roadmap is right to have
this late.

---

## 11. Human Agent Copilot

| ID | Feature | Status | Evidence / gap |
|---|---|---|---|
| COPILOT-01 | Ticket summary | ❌ | |
| COPILOT-02 | Conversation summary | ❌ | No longer blocked: `threadFor` is the thread to summarise |
| COPILOT-03 | Suggested response | ✅ | The draft, reviewable before send |
| COPILOT-04 | Suggested troubleshooting | ❌ | |
| COPILOT-05 | Knowledge recommendations | ✅ | Retrieved excerpts shown with the draft |
| COPILOT-06 | Similar tickets | ✅ | `recentTicketsFor` |
| COPILOT-07 | Root-cause suggestions | ❌ | |
| COPILOT-08 | Next-best action | ⚠️ | The decision and the rule that fired are shown; not phrased as a recommendation |
| COPILOT-09 | Tone adjustment | ❌ | |
| COPILOT-10 | Response generation | ✅ | |
| COPILOT-11 | Grammar correction | ❌ | |
| COPILOT-12 | Translation | ❌ | |
| COPILOT-13 | Ticket notes generation | ❌ | No longer blocked: a generated note would be an `ai` internal message |
| COPILOT-14 | Resolution summary | ❌ | |

**✅ 4 · ⚠️ 1 · ❌ 9**

---

## 12. Escalation Management

| ID | Feature | Status | Evidence / gap |
|---|---|---|---|
| ESC-01 | Manual escalation | ✅ | |
| ESC-02 | Automatic escalation | ✅ | `ticket.escalate`, driven by the decision branch |
| ESC-03 | SLA-based escalation | ⚠️ | SLA *warning* notifies; it does not escalate |
| ESC-04 | Priority-based escalation | ✅ | Routing table |
| ESC-05 | Severity-based escalation | ❌ | No severity |
| ESC-06 | AI-confidence escalation | ✅ | Below threshold → human. The core safety rule |
| ESC-07 | Repeated-failure escalation | ✅ | `clarify_count`, `reopened_count` |
| ESC-08 | Security escalation | ✅ | `is_security_sensitive` escalates at any confidence |
| ESC-09 | Manager escalation | ❌ | Blocked by USER-05 |
| ESC-10 | Escalation history | ✅ | Event log |
| ESC-11 | Escalation rules | ⚠️ | Routing table in tenant settings; not a rule engine |
| ESC-12 | Escalation notifications | ✅ | To the receiving queue, fix labelled unverified |

**✅ 8 · ⚠️ 2 · ❌ 2**

---

## 13. SLA Management

| ID | Feature | Status | Evidence / gap |
|---|---|---|---|
| SLA-01 | SLA policies | ✅ | Per tenant, per priority |
| SLA-02 | Response SLA | ✅ | |
| SLA-03 | Resolution SLA | ✅ | |
| SLA-04 | Priority-based SLA | ✅ | Restamped from `created_at` when the priority changes, by a retriage or by hand |
| SLA-05 | Business hours | ✅ | `addBusinessMinutes`, timezone-aware |
| SLA-06 | Holidays | ✅ | `hours.holidays` |
| SLA-07 | SLA countdown | ✅ | `slaStatus`, `minutesToNearest` |
| SLA-08 | SLA warning | ✅ | At a configurable share of each ticket's own window |
| SLA-09 | SLA breach | ⚠️ | Recorded once per clock, with a permanent `*_breached_at` and an `sla_breach` event; no breach notification |
| SLA-10 | SLA pause | ✅ | Stops on `awaiting_user`, measured in the units the clock runs in. The resolution clock also stops while `resolved` or `closed`, and a reopen gives the time back |
| SLA-11 | SLA resume | ✅ | Restarts on the way out, including on a requester's reply; cycles accumulate |
| SLA-12 | SLA escalation | ⚠️ | See ESC-03 |
| SLA-13 | SLA reports | ⚠️ | Analytics shows related figures; no SLA compliance report, though the breach columns it would read now exist |

**✅ 10 · ⚠️ 3 · ❌ 0**

**Both SLA defects are fixed.** They were the only entries in this audit that
were bugs rather than gaps, and both made a number on screen wrong.

The clock now stops on `awaiting_user` and restarts on the way out, crediting
the time in the units the clock runs in — a business-hours ticket that waits
over a weekend is credited working hours, not calendar ones. Repeated cycles
accumulate into `sla_paused_minutes`, a duplicate status write cannot reset the
pause, and the resume is guarded on the pause it read.

"Due soon" now has one definition. It was computed at `Math.max(15, 0)` in
`slaStatus` — a flat fifteen minutes, second argument never filled in — and as a
share of the window in the notification SQL, so the console and the email
disagreed. `warningLeadMinutes` is now the only definition, applied once by
`computeSla` and stored as `*_warn_at`, which every reader compares against.

Breaches are now recorded facts (D1 in [sla.md](sla.md)): set once, never
cleared, and each with its `sla_breach` event. What remains ⚠️ here is a breach
notification (SLA-09), SLA-driven escalation (SLA-12), and a compliance report
(SLA-13), which now has the columns it would read.

---

## 14. Incident Management

| ID | Feature | Status | Evidence / gap |
|---|---|---|---|
| INC-01 | Create incident | ⚠️ | `is_incident` flag on a ticket; no creation flow |
| INC-02 | Incident classification | ⚠️ | Inherits ticket category |
| INC-03 | Major incident | ⚠️ | Expressed as P1 + `is_incident` |
| INC-04 | Incident severity | ❌ | |
| INC-05 | Incident assignment | ✅ | Ticket assignment |
| INC-06 | Incident timeline | ✅ | Event log |
| INC-07 | Link tickets | ✅ | `parent_incident_id` |
| INC-08 | Detect related tickets | ✅ | Active incidents in the triage context |
| INC-09 | Incident communication | ❌ | No mass-notify to affected requesters |
| INC-10 | Incident resolution | ✅ | |
| INC-11 | Incident postmortem | ❌ | |
| INC-12 | Incident report | ❌ | |
| INC-13 | AI incident detection | ✅ | `duplicate_of_hint` against open incidents |

**✅ 6 · ⚠️ 3 · ❌ 4**

INC-09 is the notable one: the system can tell that forty tickets are the same
outage and cannot tell those forty people anything. The outbound queue and the
notification catalogue between them are most of what a broadcast needs.

---

## 15. Problem Management

**All 10 features ❌.** No `problems` table, no known-error database, no
workaround tracking, no recurring-issue detection.

---

## 16. Asset Management / CMDB

| ID | Feature | Status | Evidence / gap |
|---|---|---|---|
| ASSET-01 | Asset inventory | ✅ | `assets` |
| ASSET-02 | Asset registration | ⚠️ | Seed only; no UI or import |
| ASSET-03 | Asset assignment | ✅ | `requester_id` |
| ASSET-04 | Asset transfer | ❌ | |
| ASSET-05 | Asset history | ❌ | |
| ASSET-06 | Hardware information | ⚠️ | `kind`, `os`, `metadata` — no CPU/RAM/serial |
| ASSET-07 | Software information | ❌ | |
| ASSET-08 | License tracking | ❌ | |
| ASSET-09 | Warranty tracking | ❌ | |
| ASSET-10 | Asset status | ⚠️ | `last_seen_at` only |
| ASSET-11 | Device relationships | ❌ | |
| ASSET-12 | Configuration items | ❌ | |
| ASSET-13 | CMDB | ❌ | |
| ASSET-14 | Asset search | ⚠️ | By requester during enrichment; no search |
| ASSET-15 | Asset import | ❌ | |

**✅ 2 · ⚠️ 4 · ❌ 9**

The asset table exists to answer one question during triage — "what machine does
this person use" — and does that well. It is not a CMDB and nothing pretends it
is.

---

## 17. Service Catalog

**All 8 features ❌.** No catalog, no categories, no request forms, no dynamic
forms, no request tracking.

The portal form at `/portal/new` is free text, not a catalog item. Note the
dependency chain: a service catalog needs approval workflows (section 18, mostly
built) and manager relationships (USER-05, missing).

---

## 18. Approval Workflow

| ID | Feature | Status | Evidence / gap |
|---|---|---|---|
| APP-01 | Approval request | ✅ | `action_requests`, raised by the risk gate |
| APP-02 | Manager approval | ⚠️ | Anyone with `action:approve`; not the requester's manager |
| APP-03 | IT approval | ✅ | |
| APP-04 | Multi-level approval | ⚠️ | Second approver exists for autonomy widening only, not for tool actions |
| APP-05 | Approval rules | ✅ | Risk tiers + per-tenant whitelist |
| APP-06 | Approve | ✅ | Re-verifies tenant, status, deadline and exact arguments |
| APP-07 | Reject | ✅ | |
| APP-08 | Request changes | ❌ | |
| APP-09 | Approval timeout | ✅ | `approval_expiry_hours`, swept and re-checked at use |
| APP-10 | Approval history | ✅ | Audited |
| APP-11 | Automatic routing | ⚠️ | Notifies everyone holding the permission; no routing rules |

**✅ 7 · ⚠️ 3 · ❌ 1**

Stronger than the list asks for in one respect: approval is checked *at
execution*, not at queue time, and an expired or argument-mismatched approval
fails in the same statement that reads it.

---

## 19. Automation / Workflow Engine

| Feature | Status | | Feature | Status |
|---|---|---|---|---|
| Workflow builder | ❌ | | API actions | ❌ |
| Trigger | ❌ | | Email actions | ⚠️ |
| Condition | ❌ | | Ticket actions | ⚠️ |
| Action | ❌ | | Assignment actions | ❌ |
| Branching | ❌ | | Approval actions | ⚠️ |
| Sequential actions | ❌ | | AI actions | ⚠️ |
| Parallel actions | ❌ | | Retry | ✅ |
| Scheduled actions | ⚠️ | | Error handling | ✅ |
| Webhooks | ⚠️ | | Workflow logs | ❌ |
| | | | Workflow versioning | ❌ |

**✅ 2 · ⚠️ 6 · ❌ 11**

The ⚠️s are all "the action exists, nothing can compose it". Every verb a
workflow engine would call — send mail, set status, assign, request approval,
run the agent — is a tested function today. What is missing is the layer that
lets an administrator arrange them without a deploy. That makes this module
unusually cheap for its size, and it is the highest-leverage ❌ block after
section 9.

---

## 20. Auto-Remediation

| Action | Status | Note |
|---|---|---|
| Password reset | 🟡 | `identity.reset_password`, returns `{simulated: true}` |
| Account unlock | 🟡 | `identity.unlock_account` |
| User access provisioning | 🟡 | `identity.add_to_group` (sensitive tier) |
| Device health check | 🟡 | `mdm.asset_status` |
| Restart service | ❌ | |
| Clear cache | ❌ | |
| Reset network | ❌ | |
| VPN reset | ❌ | |
| Software restart | ❌ | |
| Diagnostic collection | ❌ | |

**🟡 4 · ❌ 6**

**The execution gate you specified is fully built**, and this is the part of the
repository that most exceeds the list:

```
LLM → chosen by table, never by the model (actions.ts maps category → ≤1 tool)
    → registry lookup (unknown name = no tool, not a guess)
    → permission check (agentContext cannot hold config or approve permissions)
    → policy check (risk tier + per-tenant whitelist)
    → approval if required (expiring, argument-bound, re-verified at execution)
    → execution
    → audit log (tool_calls + ticket_events + audit_events)
```

Fourteen tools are registered across five risk tiers (`read`, `safe_write`,
`sensitive`, `internal`, `destructive`). The four remediations above are stubs
that say so at runtime; the gate around them is real and tested.

---

## 21. Security

| ID | Feature | Status | Evidence / gap |
|---|---|---|---|
| SEC-01 | RBAC | ✅ | |
| SEC-02 | MFA | ❌ | |
| SEC-03 | Encryption | ⚠️ | Integration secrets encrypted at rest (`CREDENTIALS_KEY`); no column or disk encryption |
| SEC-04 | Secret management | ✅ | `integration_credentials`, audited on every read |
| SEC-05 | Audit logs | ✅ | `audit_events`, immutable at the database level |
| SEC-06 | IP restrictions | ❌ | IP is recorded, never enforced |
| SEC-07 | Rate limiting | ✅ | Agent-run limits and per-key HTTP limits |
| SEC-08 | API security | ✅ | Hashed keys, tenant-from-credential, 404-across-tenants |
| SEC-09 | Input validation | ✅ | Zod at every boundary |
| SEC-10 | File validation | ❌ | No file handling |
| SEC-11 | Malware scanning | ❌ | |
| SEC-12 | Prompt injection protection | ✅ | `wrapUntrusted` + `scanForInjection` |
| SEC-13 | Data leakage protection | ✅ | `redactForModel`, `redactPayload` |
| SEC-14 | PII detection | ✅ | |
| SEC-15 | Sensitive-data masking | ✅ | Two policies: scrub at rest, redact to model |
| SEC-16 | Tenant isolation | ✅ | 77 cross-tenant attack tests + structural tests |
| SEC-17 | Security incident escalation | ✅ | Hard gate, confidence-independent |

**✅ 12 · ⚠️ 1 · ❌ 4**

The strongest module in the build. Three of the four ❌s (file validation,
malware scanning, and most of encryption's remainder) are downstream of
attachments not existing.

---

## 22. AI Safety / Guardrails

| Feature | Status | | Feature | Status |
|---|---|---|---|---|
| Prompt injection detection | ✅ | | PII masking | ✅ |
| Jailbreak protection | ⚠️ | | Human approval | ✅ |
| Hallucination reduction | ✅ | | AI action limits | ✅ |
| RAG grounding | ✅ | | Max tool executions | ✅ |
| Source verification | ⚠️ | | Restricted tools | ✅ |
| Confidence thresholds | ✅ | | Tool permission system | ✅ |
| Output validation | ✅ | | Conversation abuse protection | ❌ |
| Sensitive info filtering | ✅ | | | |

**✅ 12 · ⚠️ 2 · ❌ 1**

Jailbreak protection is ⚠️ rather than ✅ because the defence is structural —
untrusted content is delimited and the model's output is constrained to a schema
— rather than a jailbreak classifier. That is the better design and it is worth
being precise that no classifier exists.

---

## 23. Notification System

**Channels — 1 of 6.** Email ✅. In-app ❌, Slack ❌, Teams ❌, SMS ❌, push ❌.

**Events — 5 of 11.**

| Event | Status | | Event | Status |
|---|---|---|---|---|
| Ticket created | ❌ | | Escalation | ✅ |
| Ticket assigned | ✅ | | Approval request | ✅ |
| Ticket updated | ❌ | | Incident | ❌ |
| Comment added | ❌ | | Resolution | ✅ |
| SLA warning | ✅ | | Closure | ❌ |
| SLA breach | ❌ | | | |

The consent machinery underneath is more developed than the channel list:
per-tenant policy (versioned and audited), per-person opt-outs that survive a
configuration rollback, per-kind deduplication, and signed unsubscribe links
that work without a login. Adding a channel is easier than adding that was.

---

## 24. Search

| Target | Status | | Capability | Status |
|---|---|---|---|---|
| Tickets | ✅ | | Full-text search | ⚠️ ILIKE, not tsvector |
| Users | ⚠️ exact email | | Semantic search | ✅ knowledge base only |
| Assets | ❌ | | Filters | ✅ |
| Knowledge articles | ✅ semantic | | Search suggestions | ❌ |
| Incidents | ⚠️ via tickets | | Search history | ❌ |
| Problems | ❌ | | Saved searches | ❌ |
| Service requests | ❌ | | | |

No global search. Each surface searches itself.

---

## 25. Dashboards

| Dashboard | Status | Note |
|---|---|---|
| Employee | ⚠️ | Portal status page for one ticket via a signed link; no "my tickets" view |
| Agent | ✅ | Queue with SLA risk, unassigned, confidence, bulk actions |
| Admin | ⚠️ | Analytics covers AI performance well; no agent workload or SLA compliance |

---

## 26. Analytics

**Ticket analytics:** volume ✅, resolution time ⚠️, response time ⚠️, first-contact
resolution ❌, reopen rate ✅, escalation rate ✅, SLA breach rate ❌.

**AI analytics:** resolution rate ✅, containment ✅, human handoff ✅, confidence ✅,
RAG retrieval quality ⚠️, answer accuracy ✅, user feedback ⚠️, hallucination
reports ❌, tool execution success ✅, agent failure rate ✅.

The AI half is genuinely strong — accuracy per category, precision/recall/F1, a
confusion matrix, calibration with expected calibration error against a ≤ 0.05
gate, Wilson-bounded threshold sweeps and a regression baseline. The ticket half
is thinner than a service desk manager would expect.

---

## 27. AI Analytics Agent

**❌.** Analytics are rendered, never narrated. No driver identification, no
pattern detection, no recommendation.

---

## 28. Feedback System

| Feature | Status | Note |
|---|---|---|
| Ticket rating | ❌ | |
| AI response rating | ❌ | |
| 👍 / 👎 | ❌ | |
| Feedback reason | ⚠️ | An override carries a reason |
| Resolution rating | ❌ | |
| Agent rating | ❌ | |
| Knowledge article rating | ❌ | |
| Feedback analytics | ✅ | Human correction rate by confidence bucket |

The loop that exists is **agent correction**, not user satisfaction: when a
person reclassifies a ticket, that becomes a `triage_shadow` row and feeds
calibration. It is the more rigorous signal and it is not a substitute for
asking the requester whether their problem was solved.

---

## 29. Audit & Compliance

| Feature | Status | | Feature | Status |
|---|---|---|---|---|
| User activity logs | ✅ | | AI tool calls | ✅ |
| Admin activity | ✅ | | Automation execution | ✅ |
| Ticket changes | ✅ | | Approval history | ✅ |
| Permission changes | ✅ | | Data access logs | ⚠️ secret reads only |
| Login history | ✅ | | Export logs | ❌ |
| AI decisions | ✅ | | Security logs | ✅ |

**✅ 10 · ⚠️ 1 · ❌ 1**

Both `audit_events` and `config_versions` refuse updates and deletes at the
database level, including from the application's own connection.

---

## 30. API

**Endpoints — 1 of 21.** `/tickets` ✅ (list, read, create). Everything else —
`/auth`, `/users`, `/roles`, `/permissions`, `/comments`, `/attachments`,
`/knowledge`, `/search`, `/incidents`, `/problems`, `/assets`, `/services`,
`/approvals`, `/sla`, `/notifications`, `/analytics`, `/ai`, `/agents`,
`/workflows`, `/audit` — ❌.

Plus two non-`/v1` routes: the intake webhook and the delivery-event webhook.

**Advanced:**

| Feature | Status | | Feature | Status |
|---|---|---|---|---|
| API keys | ✅ | | Rate limits | ✅ per key per minute |
| OAuth | ❌ | | Pagination | ✅ limit/offset/next_offset |
| Webhooks | ⚠️ inbound only | | Filtering | ✅ |
| API versioning | ⚠️ `/v1` in the path, no policy | | Sorting | ❌ |
| | | | OpenAPI documentation | ❌ |

The per-request scaffolding (`withApi`) is the reusable part: auth, tenant,
rate limit, error shape and request log are solved once, so each additional
endpoint is the handler and nothing else.

---

## 31. Integrations

| Integration | Status | | Integration | Status |
|---|---|---|---|---|
| Email (SMTP / Postmark) | ✅ | | Jira | ❌ |
| Entra ID / Azure AD | 🟡 | | ServiceNow | ❌ |
| Okta | 🟡 | | Zendesk / Freshservice | ❌ |
| Google Workspace | 🟡 | | AWS / Azure / GCP | ❌ |
| Microsoft 365 | 🟡 | | GitHub / GitLab | ❌ |
| Intune / Jamf | 🟡 | | Active Directory / LDAP | ❌ |
| Slack / Teams | ❌ | | Monitoring systems | ❌ |

Email is the only real one, and it is real in both directions — inbound webhook
and folder poller, outbound SMTP or Postmark with retry, dead-lettering, bounce
parsing and per-tenant suppression.

---

## 32. Monitoring & Observability

| Feature | Status | | Feature | Status |
|---|---|---|---|---|
| Application logs | ⚠️ console | | Vector DB latency | ❌ |
| Error logs | ⚠️ console + event log | | Tool execution logs | ✅ |
| API latency | ✅ per request | | Workflow execution logs | ✅ agent runs |
| Database monitoring | ⚠️ connection count | | Health checks | ✅ |
| Agent execution logs | ✅ | | Readiness checks | ✅ |
| LLM latency | ✅ | | Liveness checks | ⚠️ folded into `/healthz` |
| Token usage | ✅ | | | |
| LLM cost | ✅ | | | |
| RAG retrieval latency | ❌ | | | |

**✅ 8 · ⚠️ 5 · ❌ 2**

No aggregation and no exporter — logs go to the console and to Postgres, which
is fine for one deployment and not for several.

---

## 33. AI Model Management

| Feature | Status | | Feature | Status |
|---|---|---|---|---|
| Model selection | ⚠️ env var | | Retry | ✅ |
| Model configuration | ⚠️ env var | | Timeout | ⚠️ SDK default |
| Temperature | ⚠️ per call site | | Token tracking | ✅ `llm_usage` |
| Max tokens | ⚠️ per call site | | Cost tracking | ✅ per tenant, with a daily cap |
| Embedding model | ✅ hash or openai | | Model performance | ✅ the eval harness |
| LLM provider | ⚠️ Anthropic only | | Prompt versioning | ✅ registry + fingerprint |
| Model fallback | ❌ | | | |

**✅ 5 · ⚠️ 7 · ❌ 1**

Prices for five Claude models are in `models.ts`. Multi-provider would need a
gateway abstraction that does not exist — today `client()` returns an
`Anthropic` instance directly.

---

## 34. Multi-Tenant Architecture

| Feature | Status | | Feature | Status |
|---|---|---|---|---|
| Organizations | ✅ | | Tenant settings | ✅ versioned + audited |
| Tenants | ✅ | | Tenant workflows | ❌ no workflows to scope |
| Tenant isolation | ✅ 77 attack tests | | Tenant AI configuration | ✅ |
| Tenant users | ✅ memberships | | Tenant API keys | ✅ |
| Tenant roles | ✅ | | Tenant billing | ❌ |
| Tenant knowledge bases | ✅ | | Tenant usage limits | ⚠️ cost cap + rate limits, no quotas |

**✅ 9 · ⚠️ 1 · ❌ 2**

---

## 35. Admin Configuration

| Configurable | Status | | Configurable | Status |
|---|---|---|---|---|
| Categories | ⚠️ enum in code | | Assignment rules | ✅ routing table |
| Priorities | ⚠️ enum in code | | Escalation rules | ✅ |
| Severities | ❌ | | Notification rules | ✅ |
| Statuses | ❌ enum in database | | AI settings | ✅ thresholds, autonomy, mode |
| SLA | ✅ | | Knowledge bases | ⚠️ CLI ingest |
| Roles | ⚠️ fixed | | Workflows | ❌ |
| Permissions | ⚠️ fixed | | Service catalog | ❌ |
| Teams | ⚠️ `staff.queue` | | Approval rules | ✅ |

**✅ 6 · ⚠️ 6 · ❌ 4**

Everything that governs *agent autonomy* is configurable at runtime with
versioning, audit, direction-aware authorization and rollback. Everything that
governs *taxonomy* is a deploy.

---

## 36. Data Management

| Feature | Status | | Feature | Status |
|---|---|---|---|---|
| Import users | ⚠️ seed script | | Data retention | ❌ |
| Import tickets | ❌ | | Data deletion | ⚠️ `purgeBusinessUnaudited` |
| Export tickets | ⚠️ eval export only | | Archive tickets | ❌ |
| CSV export | ❌ | | Document deletion | ❌ |
| JSON export | ✅ JSONL | | User deletion | ⚠️ membership removal |
| Database backup | ❌ | | | |
| Restore | ❌ | | | |

**✅ 1 · ⚠️ 5 · ❌ 6**

No backup or restore is the one that should worry an operator most, given the
event log is the system of record and cannot be reconstructed from anywhere
else.

---

## 37. Performance & Reliability

| Feature | Status | | Feature | Status |
|---|---|---|---|---|
| Pagination | ✅ | | Retry mechanism | ✅ |
| Lazy loading | ❌ | | Circuit breaker | ❌ |
| Caching | ❌ | | Rate limiting | ✅ |
| Redis | ✅ | | Request timeout | ⚠️ |
| Background jobs | ✅ BullMQ, 4 queues | | LLM timeout | ⚠️ SDK default |
| Queue system | ✅ | | Graceful degradation | ✅ |
| Async processing | ✅ | | Health checks | ✅ |
| Database indexing | ✅ | | Error handling | ✅ |
| Connection pooling | ✅ | | | |

**✅ 11 · ⚠️ 2 · ❌ 3**

Graceful degradation is better than most builds: no model key, no Redis and no
mail transport each degrade to a named, honest state rather than an error.

Measured: **p95 intake → enqueued is 67ms against a 2s target** at 500 messages
and concurrency 20, and 237ms at 2,000 messages and concurrency 50, with no
failures. `npm run bench:intake`.

---

## 38. Testing

| Backend | Status | | AI | Status |
|---|---|---|---|---|
| Unit tests | ✅ | | RAG evaluation | ❌ |
| Integration tests | ✅ | | Retrieval evaluation | ❌ |
| API tests | ⚠️ data layer, not HTTP | | Answer evaluation | ⚠️ triage only |
| Authentication tests | ✅ | | Hallucination tests | ⚠️ groundedness gate tested |
| RBAC tests | ✅ | | Prompt injection tests | ✅ |
| Database tests | ✅ | | Tool-use tests | ✅ |
| Tenant-isolation tests | ✅ 77 | | Agent workflow tests | ✅ pipeline integration |
| | | | Regression tests | ✅ pinned baseline |

**Frontend: all ❌.** No component tests, no E2E, no accessibility tests.

498 tests pass today. The distribution is the point: the backend and the agent
are covered thoroughly, the browser is covered not at all.

---

## 39. AI Evaluation

| Metric | Status | | Agent metric | Status |
|---|---|---|---|---|
| Retrieval precision | ❌ | | Task success rate | ⚠️ resolution path |
| Retrieval recall | ❌ | | Tool success rate | ✅ |
| Context relevance | ❌ | | Average steps | ❌ |
| Answer relevance | ⚠️ | | Failure rate | ✅ |
| Faithfulness | ⚠️ groundedness gate | | Latency | ✅ |
| Hallucination rate | ❌ | | Cost | ✅ |
| Resolution rate | ✅ | | | |
| Escalation rate | ✅ | | | |
| User satisfaction | ❌ | | | |

**✅ 6 · ⚠️ 4 · ❌ 5**

Classification evaluation is thorough — accuracy, per-class F1, calibration,
ECE, Wilson-bounded thresholds, regression gating. **RAG evaluation is the hole:
nothing measures retrieval quality**, which matters because the groundedness
threshold in `businesses.settings` is currently a guess in exactly the way the
confidence threshold used to be before the harness existed.

---

## 40. Advanced AI Features

**15 of 16 ❌.** The exception is similar-ticket clustering (⚠️, via duplicate
detection and active-incident matching).

Missing: predictive routing, predictive incident detection, anomaly detection,
root-cause analysis, automatic problem creation, automatic article generation,
knowledge-gap detection, trend prediction, intent prediction, proactive support,
device failure prediction, AI postmortems, AI SOPs, AI reports, autonomous
remediation.

Correctly last. Note that knowledge-gap detection is nearly free once KB-28 is
recorded, and automatic article generation becomes reasonable once there is a
corpus of resolved tickets with human-verified replies.

---

## 41. Mobile / Responsive

| Feature | Status |
|---|---|
| Responsive UI | ⚠️ readable on a phone; not designed for one |
| Mobile ticket creation | ⚠️ the portal form works |
| Mobile AI chat | ❌ |
| Push notifications | ❌ |
| Mobile ticket management | ❌ |
| Mobile approval | ⚠️ the approvals page renders |
| Mobile agent dashboard | ❌ |

---

## 42. UI / UX

| Feature | Status | | Feature | Status |
|---|---|---|---|---|
| Dashboard | ✅ | | Analytics dashboard | ✅ |
| Sidebar navigation | ✅ permission-filtered | | Dark mode | ❌ |
| Global search | ❌ | | Responsive design | ⚠️ |
| Ticket table | ✅ | | Loading states | ⚠️ |
| Ticket detail page | ✅ | | Empty states | ✅ |
| AI chat interface | ❌ | | Error states | ✅ |
| Knowledge-base interface | ⚠️ read-only | | Toast notifications | ⚠️ inline results |
| Agent workspace | ✅ | | Confirmation dialogs | ✅ server-side |
| Admin panel | ✅ | | | |

**✅ 10 · ⚠️ 5 · ❌ 3**

---

## 43. Enterprise / Governance

| Feature | Status | | Feature | Status |
|---|---|---|---|---|
| Organization policies | ⚠️ tenant settings | | Data residency | ❌ |
| Data retention policies | ❌ | | Custom branding | ❌ |
| AI usage policies | ✅ | | Custom domains | ❌ |
| Approval policies | ✅ | | Tenant configuration | ✅ |
| Access policies | ✅ | | Usage limits | ⚠️ |
| Audit compliance | ✅ | | AI cost controls | ✅ |

**✅ 6 · ⚠️ 3 · ❌ 3**

---

## What to build next

Ordered by leverage rather than by section number. The first two unblock the
most other rows.

**1. A ticket conversation model (TKT-15, TKT-16, TKT-17) — built, bar stored attachments.**
Comments, internal notes, attachments. This is the keystone: sections 7, 9 and
11 — 47 features between them — cannot be built as specified without somewhere
to put turns. It is also what makes the product usable by a human agent, which
today it barely is. The model and its invariants are in
[conversation.md](conversation.md), and every writer and reader now uses it.

**2. ~~The two SLA defects~~ — done.** Both fixed: the clock pauses on
`awaiting_user` and credits the time in the units it runs in, and "due soon" has
one definition shared by the console, the portal, the API and the warning sweep.
See section 13. The two P1 exit criteria that were unproven were closed at the
same time — event-log replay and intake latency at 10× volume.

**3. The account lifecycle (AUTH-07 to AUTH-10).** Seven ❌s collapse into one
feature, and the signed-token machinery already exists.

**4. RAG evaluation (section 39).** The groundedness threshold is an unmeasured
guess. The harness that would measure it is built — it needs retrieval metrics
alongside the classification ones.

**5. The workflow engine (section 19).** Every verb exists and is tested; what
is missing is composition. Unusually cheap for an 11-❌ block.

**6. Manager relationships (USER-05).** One column that unblocks manager
approval, which unblocks a service catalog.

**Deliberately not next:** the orchestrator (section 10) with one agent to
orchestrate, and section 40 in general. Both are the temptation the roadmap
already warns about.
