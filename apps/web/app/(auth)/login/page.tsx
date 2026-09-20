import { redirect } from "next/navigation";
import { currentSession } from "../../../lib/auth";
import { safeNext } from "../../../lib/safe-next";
import { signInAction } from "../actions";

export const dynamic = "force-dynamic";

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; next?: string }>;
}) {
  const { error, next: rawNext } = await searchParams;
  const next = safeNext(rawNext);
  if (await currentSession()) redirect(next);

  return (
    <div className="auth-card">
      <h1>Helpdesk agent console</h1>
      <p className="sub">Sign in to continue.</p>

      {error ? (
        // One message for every failure mode. Telling somebody the address was
        // not found tells them which addresses are registered.
        <div className="auth-error">That email and password did not match.</div>
      ) : null}

      <form action={signInAction} className="auth-form">
        <input type="hidden" name="next" value={next} />
        <label>
          Email
          <input
            type="email"
            name="email"
            autoComplete="username"
            required
            autoFocus
          />
        </label>
        <label>
          Password
          <input
            type="password"
            name="password"
            autoComplete="current-password"
            required
          />
        </label>
        <button type="submit">Sign in</button>
      </form>

      <p className="sub auth-foot">
        No account yet? A tenant administrator invites you from Settings →
        People. On a fresh install, <code>npm run db:seed</code> prints the
        starting credentials.
      </p>
    </div>
  );
}
