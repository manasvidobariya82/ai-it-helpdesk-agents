import { redirect } from "next/navigation";
import { listBusinesses } from "@hd/core";
import { currentUserOnly } from "../../../lib/auth";
import { selectTenantAction, signOutAction } from "../actions";

export const dynamic = "force-dynamic";

/**
 * The tenant picker.
 *
 * Only lists businesses the person is a member of — or every business, for a
 * platform super admin, whose reach is the one case where the list is not the
 * membership table. A name in a dropdown is already a disclosure, so the list
 * is built from `memberships` and not from `listBusinesses()`.
 */
export default async function SelectTenantPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const { error } = await searchParams;
  const session = await currentUserOnly();
  if (!session) redirect("/login");

  const options = session.user.is_super_admin
    ? (await listBusinesses()).map((b) => ({ id: b.id, name: b.name }))
    : session.memberships.map((m) => ({ id: m.business_id, name: m.business_name }));

  if (options.length === 0) {
    return (
      <div className="auth-card">
        <h1>No access</h1>
        <p className="sub">
          Your account is not a member of any tenant. Ask an administrator to
          invite you.
        </p>
        <form action={signOutAction}>
          <button type="submit">Sign out</button>
        </form>
      </div>
    );
  }

  return (
    <div className="auth-card">
      <h1>Choose a tenant</h1>
      <p className="sub">
        Signed in as {session.user.full_name || session.user.email}.
      </p>

      {error ? (
        <div className="auth-error">
          You are not a member of that tenant.
        </div>
      ) : null}

      <form action={selectTenantAction} className="auth-form">
        <label>
          Tenant
          <select name="business_id" defaultValue={session.businessId ?? options[0]!.id}>
            {options.map((o) => (
              <option key={o.id} value={o.id}>
                {o.name}
              </option>
            ))}
          </select>
        </label>
        <button type="submit">Continue</button>
      </form>

      <form action={signOutAction} className="auth-foot">
        <button type="submit" className="link-button">
          Sign out
        </button>
      </form>
    </div>
  );
}
