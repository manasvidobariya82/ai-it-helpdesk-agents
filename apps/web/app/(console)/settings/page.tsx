import {
  can,
  classifyField,
  configHistory,
  currentConfigVersion,
  env,
  grantableRoles,
  listConfigVersions,
  listApiKeys,
  listCredentials,
  listOptouts,
  listTenantUsers,
  pendingConfigRequests,
  policyFor,
  TicketCategory,
  type ConfigChangeRequest,
  type ConfigVersion,
  type ApiKeySummary,
  type CredentialSummary,
  type Optout,
  type TenantUser,
} from "@hd/core";
import { currentTenant, fmtDate } from "../../../lib/tenant";
import { ChangeForm, ResultForm } from "./change-form";
import {
  decideProposal,
  deleteCredentialAction,
  inviteUserAction,
  putCredentialAction,
  removeMemberAction,
  issueApiKey,
  resubscribe,
  revokeKey,
  rollbackToVersion,
  setRoleAction,
  updateCategoryPolicy,
  updateGeneral,
  updateModeOverride,
  updateNotifications,
} from "./actions";

export const dynamic = "force-dynamic";

const AUTONOMY_COPY: Record<string, string> = {
  off: "Classify only. A human writes every reply.",
  suggest: "Draft into the review queue. Nothing sends.",
  reply: "Send unattended above the confidence threshold.",
  act: "Also run whitelisted safe_write tools.",
};

/**
 * Tenant configuration.
 *
 * Every change on this page produces an immutable numbered version and one
 * audit row per changed field, with both values, the actor and a reason.
 * Critical fields — anything governing what the agent may do without a person —
 * additionally need `security:update`, a written reason, and, when the change
 * widens autonomy, an explicit confirmation after reading the impact.
 */
export default async function SettingsPage() {
  const tenant = await currentTenant("/settings");
  const { ctx, settings } = tenant;

  const mayEdit = can(ctx, "config:update");
  const mayEditSecurity = can(ctx, "security:update");
  const maySeeCredentials = can(ctx, "security:read");
  const maySeeHistory = can(ctx, "audit:read");

  const [version, versions, proposals, users, credentials, history, optouts, apiKeys] =
    await Promise.all([
      currentConfigVersion(ctx),
      listConfigVersions(ctx, 15),
      mayEdit ? pendingConfigRequests(ctx) : Promise.resolve([] as ConfigChangeRequest[]),
      mayEdit ? listTenantUsers(ctx) : Promise.resolve([] as TenantUser[]),
      maySeeCredentials
        ? listCredentials(ctx)
        : Promise.resolve([] as CredentialSummary[]),
      maySeeHistory ? configHistory(ctx, 15) : Promise.resolve([]),
      listOptouts(ctx, 50),
      maySeeCredentials ? listApiKeys(ctx) : Promise.resolve([] as ApiKeySummary[]),
    ]);

  const roles = grantableRoles(ctx);

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Settings</h1>
          <div className="sub">
            {tenant.business.name} · configuration{" "}
            <strong>v{version?.version ?? "—"}</strong> · deployment mode{" "}
            <code>{env.AGENT_MODE}</code>
            {mayEdit ? "" : " · read only"}
          </div>
        </div>
      </div>

      {/* --- pending second-approver proposals ---------------------------- */}
      {proposals.length > 0 ? (
        <div className="panel">
          <div className="panel-head">
            <h2>Waiting for a second administrator</h2>
            <span className="sub">
              You cannot approve a change you proposed yourself.
            </span>
          </div>
          {proposals.map((p) => (
            <Proposal key={p.id} proposal={p} mine={p.requested_by === ctx.actorId} />
          ))}
        </div>
      ) : null}

      {/* --- autonomy ---------------------------------------------------- */}
      <div className="panel">
        <div className="panel-head">
          <h2>Autonomy by category</h2>
          <span className="sub">
            {mayEditSecurity
              ? "Widening shows its impact and asks you to confirm. Every change is versioned and audited."
              : "Requires security:update. You can read these but not change them."}
          </span>
        </div>

        <table>
          <thead>
            <tr>
              <th>Category</th>
              <th>Autonomy</th>
              <th>Threshold</th>
              <th>Reason for the change</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {TicketCategory.options.map((category) => {
              const policy = policyFor(settings, category);
              const locked = settings.never_auto_categories.includes(category);
              if (locked) {
                return (
                  <tr key={category}>
                    <td>
                      <strong>{category}</strong>
                      <div className="sub">
                        Never automated. No measured accuracy opens this one.
                      </div>
                    </td>
                    <td colSpan={4}>
                      <span className="chip p1">human only</span>
                    </td>
                  </tr>
                );
              }
              return (
                <tr key={category}>
                  <td>
                    <strong>{category}</strong>
                    <div className="sub">{AUTONOMY_COPY[policy.autonomy]}</div>
                  </td>
                  <td colSpan={4}>
                    <ChangeForm
                      kind="category"
                      action={updateCategoryPolicy}
                      disabled={!mayEditSecurity}
                      className="row"
                    >
                      <input type="hidden" name="category" value={category} />
                      <select
                        name="autonomy"
                        defaultValue={policy.autonomy}
                        disabled={!mayEditSecurity}
                      >
                        {Object.keys(AUTONOMY_COPY).map((level) => (
                          <option key={level} value={level}>
                            {level}
                          </option>
                        ))}
                      </select>
                      <input
                        type="number"
                        name="confidence_threshold"
                        step="0.01"
                        min="0"
                        max="1"
                        defaultValue={policy.confidence_threshold}
                        disabled={!mayEditSecurity}
                        style={{ width: 80 }}
                        aria-label={`${category} confidence threshold`}
                      />
                      <input
                        type="text"
                        name="reason"
                        placeholder="Approved after evaluation run #184"
                        disabled={!mayEditSecurity}
                        style={{ width: 260 }}
                        aria-label={`${category} reason`}
                      />
                    </ChangeForm>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* --- kill switch -------------------------------------------------- */}
      <div className="panel">
        <div className="panel-head">
          <h2>Mode override</h2>
          <span className="sub">
            Narrows autonomy only. A tenant cannot exceed the deployment mode,
            and turning it on never waits for a second signature.
          </span>
        </div>
        <ChangeForm
          kind="mode"
          action={updateModeOverride}
          disabled={!mayEditSecurity}
          className="form-grid"
          submitLabel="Save override"
        >
          <label>
            Override
            <select
              name="agent_mode_override"
              defaultValue={settings.agent_mode_override ?? ""}
              disabled={!mayEditSecurity}
            >
              <option value="">No override (follow deployment)</option>
              <option value="shadow">shadow — send nothing</option>
              <option value="assist">assist — draft only</option>
              <option value="auto">auto — as configured per category</option>
            </select>
          </label>
          <label>
            Reason
            <input
              type="text"
              name="reason"
              defaultValue={settings.agent_mode_override_reason ?? ""}
              placeholder="Why the override is on"
              disabled={!mayEditSecurity}
            />
          </label>
        </ChangeForm>
      </div>

      {/* --- general ------------------------------------------------------ */}
      <div className="panel">
        <div className="panel-head">
          <h2>General</h2>
          <span className="sub">
            Audited and versioned like everything else. The brakes below are
            classified critical, because raising a limit is loosening a guard.
          </span>
        </div>
        <ChangeForm
          kind="general"
          action={updateGeneral}
          disabled={!mayEdit}
          className="form-grid"
        >
          <label>
            Signature
            <input
              type="text"
              name="signature"
              defaultValue={settings.signature}
              disabled={!mayEdit}
            />
          </label>
          <label>
            Follow-up / auto-close after (hours)
            <input
              type="number"
              name="followup_hours"
              min="1"
              max="168"
              defaultValue={settings.followup_hours}
              disabled={!mayEdit}
            />
          </label>
          <label>
            Max clarifying rounds
            <input
              type="number"
              name="max_clarify_rounds"
              min="0"
              max="3"
              defaultValue={settings.max_clarify_rounds}
              disabled={!mayEdit}
            />
          </label>
          <label>
            Agent runs per requester per hour
            <input
              type="number"
              name="max_agent_runs_per_requester_hour"
              min="1"
              defaultValue={settings.max_agent_runs_per_requester_hour}
              disabled={!mayEdit}
            />
          </label>
          <label>
            Agent runs per tenant per hour
            <input
              type="number"
              name="max_agent_runs_per_tenant_hour"
              min="1"
              defaultValue={settings.max_agent_runs_per_tenant_hour}
              disabled={!mayEdit}
            />
          </label>
          <label className="checkbox">
            <input
              type="checkbox"
              name="scrub_secrets_at_rest"
              defaultChecked={settings.scrub_secrets_at_rest}
              disabled={!mayEdit}
            />
            Scrub credentials out of ticket bodies at intake
          </label>
          <label className="checkbox">
            <input
              type="checkbox"
              name="require_dual_control_for_widening"
              defaultChecked={settings.require_dual_control_for_widening}
              disabled={!mayEdit}
            />
            Require a second administrator to widen autonomy
          </label>
          <label>
            Reason
            <input type="text" name="reason" disabled={!mayEdit} />
          </label>
        </ChangeForm>
      </div>

      {/* --- notifications ------------------------------------------------ */}
      <div className="panel">
        <div className="panel-head">
          <h2>Notifications</h2>
          <span className="sub">
            These default to on: an unsent notification is a person not finding
            out. Volume is meant to be solved by the people receiving them —
            every notification carries an unsubscribe link, and an individual
            choice is recorded below rather than here.
          </span>
        </div>
        <ChangeForm
          kind="notifications"
          action={updateNotifications}
          disabled={!mayEdit}
          className="form-grid"
        >
          {/*
            The master switch and the approval notice are classified critical.
            Silencing either means the agent runs with less human visibility,
            which this codebase treats as a widening change — so it needs
            `security:update`, a reason, and a confirmation after reading the
            impact. The other three are ordinary preferences.
          */}
          <label className="checkbox">
            <input
              type="checkbox"
              name="notify_enabled"
              defaultChecked={settings.notifications.enabled}
              disabled={!mayEditSecurity}
            />
            Send notifications at all
            {mayEditSecurity ? "" : " (needs security:update)"}
          </label>
          <label className="checkbox">
            <input
              type="checkbox"
              name="notify_approval"
              defaultChecked={settings.notifications.approval}
              disabled={!mayEditSecurity}
            />
            Approval requests, to whoever can decide them
            {mayEditSecurity ? "" : " (needs security:update)"}
          </label>
          <label className="checkbox">
            <input
              type="checkbox"
              name="notify_assignment"
              defaultChecked={settings.notifications.assignment}
              disabled={!mayEdit}
            />
            Assignment, to the person who got the ticket
          </label>
          <label className="checkbox">
            <input
              type="checkbox"
              name="notify_sla_warning"
              defaultChecked={settings.notifications.sla_warning}
              disabled={!mayEdit}
            />
            SLA warnings, to the assignee or the queue
          </label>
          <label className="checkbox">
            <input
              type="checkbox"
              name="notify_escalation"
              defaultChecked={settings.notifications.escalation}
              disabled={!mayEdit}
            />
            Escalations, to the queue the agent handed it to
          </label>
          <label className="checkbox">
            <input
              type="checkbox"
              name="notify_resolution"
              defaultChecked={settings.notifications.resolution}
              disabled={!mayEdit}
            />
            Resolution, to the requester when a person closes their ticket
          </label>
          <label>
            Warn with this much of the SLA window left (%)
            <input
              type="number"
              name="sla_warning_at_percent"
              min="1"
              max="50"
              defaultValue={settings.notifications.sla_warning_at_percent}
              disabled={!mayEdit}
            />
          </label>
          <label>
            Fallback address for escalations and approvals
            <input
              type="text"
              name="ops_address"
              placeholder="nobody — the ticket records that instead"
              defaultValue={settings.notifications.ops_address ?? ""}
              disabled={!mayEdit}
            />
          </label>
          <label>
            Reason
            <input type="text" name="reason" disabled={!mayEdit} />
          </label>
        </ChangeForm>
      </div>

      {/* --- who has opted out -------------------------------------------- */}
      <div className="panel">
        <div className="panel-head">
          <h2>Opted out</h2>
          <span className="sub">
            Somebody used the unsubscribe link in a notification. Deliberately
            not part of the configuration snapshot: rolling settings back to last
            week must not resubscribe a person who unsubscribed yesterday.
          </span>
        </div>
        {optouts.length === 0 ? (
          <div className="empty">
            Nobody has unsubscribed. Every notification carries the link.
          </div>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Address</th>
                <th>Stopped</th>
                <th>Who</th>
                <th>When</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {optouts.map((o: Optout) => (
                <tr key={o.id}>
                  <td>
                    <span className="path">{o.email}</span>
                  </td>
                  <td>
                    <span className="chip">
                      {o.kind === "all" ? "everything" : o.kind}
                    </span>
                  </td>
                  <td className="sub">
                    {o.source === "self" ? "themselves" : o.created_by}
                  </td>
                  <td className="sub">{fmtDate(o.created_at)}</td>
                  <td>
                    {mayEdit ? (
                      <ResultForm
                        action={async (formData: FormData) => {
                          "use server";
                          return resubscribe(
                            o.email,
                            o.kind,
                            String(formData.get("reason") ?? ""),
                          );
                        }}
                        confirm={`Send notifications to ${o.email} again?`}
                      >
                        <input
                          type="text"
                          name="reason"
                          placeholder="Why"
                          style={{ width: 130 }}
                          required
                        />
                        <button type="submit">Resubscribe</button>
                      </ResultForm>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* --- api keys ------------------------------------------------------ */}
      {maySeeCredentials ? (
        <div className="panel">
          <div className="panel-head">
            <h2>API keys</h2>
            <span className="sub">
              A key acts with a role, resolved through the same permission table
              the console uses — so a <code>viewer</code> key can read tickets
              and cannot create one, and no key is more capable than a person
              with that role. The tenant comes from the key, never from the
              request. Only the hash is stored, so the token is shown once.
            </span>
          </div>
          {apiKeys.length === 0 ? (
            <div className="empty">
              No keys. <code>/api/v1/tickets</code> refuses every request until
              there is one.
            </div>
          ) : (
            <table>
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Key</th>
                  <th>Role</th>
                  <th>Used</th>
                  <th>Created</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {apiKeys.map((k: ApiKeySummary) => (
                  <tr key={k.id} className={k.revoked_at ? "sub" : undefined}>
                    <td>
                      {k.name}
                      {k.revoked_at ? (
                        <div className="sub">
                          revoked {fmtDate(k.revoked_at)}
                        </div>
                      ) : k.expires_at ? (
                        <div className="sub">expires {fmtDate(k.expires_at)}</div>
                      ) : null}
                    </td>
                    <td>
                      <span className="path">{k.token_prefix}…</span>
                    </td>
                    <td>
                      <span className="chip">{k.role}</span>
                    </td>
                    <td className="sub">
                      {k.request_count} request{k.request_count === 1 ? "" : "s"}
                      {k.last_used_at ? (
                        <div>last {fmtDate(k.last_used_at)}</div>
                      ) : (
                        <div>never used</div>
                      )}
                    </td>
                    <td className="sub">
                      {fmtDate(k.created_at)}
                      <div>{k.created_by}</div>
                    </td>
                    <td>
                      {mayEditSecurity && !k.revoked_at ? (
                        <ResultForm
                          action={async (formData: FormData) => {
                            "use server";
                            return revokeKey(
                              k.id,
                              String(formData.get("reason") ?? ""),
                            );
                          }}
                          confirm={`Revoke ${k.name}? Anything using it stops working immediately.`}
                        >
                          <input
                            type="text"
                            name="reason"
                            placeholder="Why"
                            style={{ width: 120 }}
                            required
                          />
                          <button className="danger" type="submit">
                            Revoke
                          </button>
                        </ResultForm>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}

          {mayEditSecurity ? (
            <div className="panel-body">
              <ResultForm action={issueApiKey} className="form-grid">
                <label>
                  Name
                  <input
                    type="text"
                    name="name"
                    placeholder="Monitoring integration"
                    required
                  />
                </label>
                <label>
                  Role
                  <select name="role" defaultValue="viewer">
                    {roles.map((r) => (
                      <option key={r} value={r}>
                        {r}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  Expires after (days, 0 for never)
                  <input type="number" name="expires_days" min="0" defaultValue={0} />
                </label>
                <button className="primary" type="submit">
                  Create key
                </button>
              </ResultForm>
              <div className="sub">
                Roles you can issue are the ones you could grant to a person.
                Creating and revoking keys are both audited.
              </div>
            </div>
          ) : null}
        </div>
      ) : null}

      {/* --- versions ----------------------------------------------------- */}
      <div className="panel">
        <div className="panel-head">
          <h2>Configuration versions</h2>
          <span className="sub">
            Immutable. A rollback creates a new version rather than removing one.
          </span>
        </div>
        {versions.length === 0 ? (
          <div className="empty">No versions recorded yet.</div>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Version</th>
                <th>When</th>
                <th>Who</th>
                <th>What changed</th>
                <th>Reason</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {versions.map((v) => (
                <VersionRow
                  key={v.id}
                  version={v}
                  canRollback={mayEdit && v.status !== "current"}
                />
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* --- people ------------------------------------------------------- */}
      {mayEdit ? (
        <div className="panel">
          <div className="panel-head">
            <h2>People</h2>
            <span className="sub">
              You can only grant roles whose permissions you hold yourself.
            </span>
          </div>
          <table>
            <thead>
              <tr>
                <th>Name</th>
                <th>Email</th>
                <th>Role</th>
                <th>Last sign-in</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {users.map((u) => (
                <tr key={u.user_id}>
                  <td>
                    {u.full_name}
                    {u.is_super_admin ? (
                      <span className="chip p1"> platform</span>
                    ) : null}
                  </td>
                  <td className="sub">{u.email}</td>
                  <td>
                    <form action={setRoleAction} className="row">
                      <input type="hidden" name="user_id" value={u.user_id} />
                      <select
                        name="role"
                        defaultValue={u.role}
                        disabled={u.user_id === ctx.actorId}
                      >
                        {[...new Set([u.role, ...roles])].map((r) => (
                          <option key={r} value={r}>
                            {r}
                          </option>
                        ))}
                      </select>
                      <button type="submit" disabled={u.user_id === ctx.actorId}>
                        Set
                      </button>
                    </form>
                  </td>
                  <td className="sub">{fmtDate(u.last_login_at)}</td>
                  <td>
                    <form action={removeMemberAction}>
                      <input type="hidden" name="user_id" value={u.user_id} />
                      <button
                        className="danger"
                        type="submit"
                        disabled={u.user_id === ctx.actorId}
                      >
                        Remove
                      </button>
                    </form>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          <form action={inviteUserAction} className="form-grid">
            <label>
              Email
              <input type="email" name="email" required />
            </label>
            <label>
              Full name
              <input type="text" name="full_name" required />
            </label>
            <label>
              Role
              <select name="role" defaultValue="viewer">
                {roles.map((r) => (
                  <option key={r} value={r}>
                    {r}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Initial password (min 12 characters)
              <input type="password" name="password" minLength={12} />
            </label>
            <button type="submit">Invite</button>
          </form>
        </div>
      ) : null}

      {/* --- credentials -------------------------------------------------- */}
      {maySeeCredentials ? (
        <div className="panel">
          <div className="panel-head">
            <h2>Integration credentials</h2>
            <span className="sub">
              Encrypted at rest. Never shown after saving, and never returned by
              a listing — reading one needs <code>credentials:read</code> and
              writes an audit row.
            </span>
          </div>
          {credentials.length === 0 ? (
            <div className="empty">No integrations configured.</div>
          ) : (
            <table>
              <thead>
                <tr>
                  <th>Provider</th>
                  <th>Label</th>
                  <th>Secret</th>
                  <th>Rotated</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {credentials.map((c) => (
                  <tr key={c.id}>
                    <td>
                      <strong>{c.provider}</strong>
                    </td>
                    <td className="sub">{c.label || "—"}</td>
                    <td>
                      <code>{c.hint}</code>
                    </td>
                    <td className="sub">{fmtDate(c.updated_at)}</td>
                    <td>
                      <form action={deleteCredentialAction}>
                        <input type="hidden" name="provider" value={c.provider} />
                        <button
                          className="danger"
                          type="submit"
                          disabled={!can(ctx, "credentials:update")}
                        >
                          Delete
                        </button>
                      </form>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}

          <form action={putCredentialAction} className="form-grid">
            <label>
              Provider
              <input
                type="text"
                name="provider"
                placeholder="entra"
                required
                disabled={!can(ctx, "credentials:update")}
              />
            </label>
            <label>
              Label
              <input
                type="text"
                name="label"
                disabled={!can(ctx, "credentials:update")}
              />
            </label>
            <label>
              Secret
              <input
                type="password"
                name="secret"
                required
                disabled={!can(ctx, "credentials:update")}
              />
            </label>
            <button type="submit" disabled={!can(ctx, "credentials:update")}>
              Save credential
            </button>
          </form>
        </div>
      ) : null}

      {/* --- recent field changes ----------------------------------------- */}
      {maySeeHistory ? (
        <div className="panel">
          <div className="panel-head">
            <h2>Recent configuration changes</h2>
            <span className="sub">
              Full log, with search and filters, at <a href="/audit">/audit</a>.
            </span>
          </div>
          {history.length === 0 ? (
            <div className="empty">Nothing changed yet.</div>
          ) : (
            <table>
              <thead>
                <tr>
                  <th>When</th>
                  <th>Who</th>
                  <th>Setting</th>
                  <th>Change</th>
                  <th>Reason</th>
                  <th>v</th>
                </tr>
              </thead>
              <tbody>
                {history.map((h) => (
                  <tr key={h.id}>
                    <td className="sub">{fmtDate(h.created_at)}</td>
                    <td>
                      {h.actor_email ?? h.actor_type}
                      <div className="sub">{h.actor_role ?? "—"}</div>
                    </td>
                    <td>
                      <code>{h.field ?? h.resource_id}</code>
                      {h.field && classifyField(h.field) === "critical" ? (
                        <span className="chip p2"> critical</span>
                      ) : null}
                    </td>
                    <td>
                      <code>{JSON.stringify(h.old_value)}</code> →{" "}
                      <code>{JSON.stringify(h.new_value)}</code>
                    </td>
                    <td className="sub">{h.reason ?? "—"}</td>
                    <td className="sub">
                      {h.config_version ? `v${h.config_version}` : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      ) : null}
    </>
  );
}

function VersionRow({
  version,
  canRollback,
}: {
  version: ConfigVersion;
  canRollback: boolean;
}) {
  const critical = version.summary.filter((c) => c.risk === "critical");
  return (
    <tr>
      <td>
        <strong>v{version.version}</strong>
        {version.status === "current" ? (
          <span className="chip p3"> current</span>
        ) : null}
        {version.source === "rollback" ? (
          <div className="sub">rolled back to v{version.restored_from}</div>
        ) : null}
      </td>
      <td className="sub">{fmtDate(version.created_at)}</td>
      <td className="sub">{version.actor_email ?? version.source}</td>
      <td className="sub">
        {version.summary.length === 0
          ? "—"
          : `${version.summary.length} field${version.summary.length === 1 ? "" : "s"}`}
        {critical.length > 0 ? (
          <span className="chip p2"> {critical.length} critical</span>
        ) : null}
      </td>
      <td className="sub">{version.reason ?? "—"}</td>
      <td>
        {canRollback ? (
          <ResultForm
            action={rollbackToVersion}
            className="row"
            confirm={`Roll the configuration back to v${version.version}? This creates a new version; nothing is deleted.`}
          >
            <input type="hidden" name="version" value={version.version} />
            {/* Rollback goes through the same gates: a rollback to a more
                permissive configuration widens autonomy exactly as much as
                typing those values in would. */}
            <input type="hidden" name="acknowledge" value="on" />
            <input
              type="text"
              name="reason"
              placeholder="Why roll back"
              required
              style={{ width: 160 }}
              aria-label={`Reason for rolling back to v${version.version}`}
            />
            <button type="submit">Roll back</button>
          </ResultForm>
        ) : null}
      </td>
    </tr>
  );
}

function Proposal({
  proposal,
  mine,
}: {
  proposal: ConfigChangeRequest;
  mine: boolean;
}) {
  return (
    <div className="proposal">
      <div>
        <strong>{proposal.requested_by_email ?? "someone"}</strong> proposed{" "}
        {proposal.summary.length} change
        {proposal.summary.length === 1 ? "" : "s"} against v{proposal.base_version}
        <div className="sub">{proposal.reason}</div>
        <ul className="sub">
          {proposal.summary.map((c) => (
            <li key={c.field}>
              <code>{c.field}</code>: {JSON.stringify(c.old_value)} →{" "}
              {JSON.stringify(c.new_value)}{" "}
              {c.direction === "widening" ? (
                <span className="chip p1">widening</span>
              ) : null}
            </li>
          ))}
        </ul>
      </div>

      {mine ? (
        <span className="sub">
          You proposed this. Somebody else has to approve it.
        </span>
      ) : (
        <ResultForm action={decideProposal} className="row">
          <input type="hidden" name="request_id" value={proposal.id} />
          <input
            type="text"
            name="decision_reason"
            placeholder="Note (optional)"
            style={{ width: 160 }}
            aria-label="Decision note"
          />
          <button className="primary" type="submit" name="decision" value="approve">
            Approve
          </button>
          <button className="danger" type="submit" name="decision" value="reject">
            Reject
          </button>
        </ResultForm>
      )}
    </div>
  );
}
