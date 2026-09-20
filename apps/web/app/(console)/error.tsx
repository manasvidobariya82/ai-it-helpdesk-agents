"use client";

/**
 * The console's error boundary.
 *
 * Its job is to make a refused action look like a refusal rather than a crash.
 * A person who lacks `security:update` should be told that, in those words, and
 * not shown a stack trace or bounced to a login form they are already past.
 *
 * Next.js strips server error messages before they reach the client in
 * production, so the message is matched on the digest-safe prefix the
 * authorization errors carry, and anything unrecognised falls through to a
 * generic message. Guessing at a cause is worse than admitting there isn't one.
 */
export default function ConsoleError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const message = error.message ?? "";
  const denied =
    /lacks [a-z]+:[a-z_]+/.test(message) ||
    /requires security:update/.test(message) ||
    /You do not have/.test(message) ||
    /You cannot/.test(message);

  return (
    <div className="panel">
      <div className="panel-head">
        <h2>{denied ? "Not allowed" : "Something went wrong"}</h2>
      </div>
      <div className="empty" style={{ textAlign: "left" }}>
        {denied ? (
          <>
            <p>{message}</p>
            <p className="sub">
              This is a permission, not a bug. Ask an administrator for the role
              that carries it, or have somebody who holds it make the change.
            </p>
          </>
        ) : (
          <>
            <p>
              The action failed.{" "}
              {message ? <code>{message}</code> : "No detail was returned."}
            </p>
            <p className="sub">
              Nothing was written unless the message says otherwise — the
              database work happens in one transaction per action.
            </p>
          </>
        )}
        <div className="row" style={{ marginTop: 12 }}>
          <button onClick={reset}>Try again</button>
          <a href="/">Back to the queue</a>
        </div>
      </div>
    </div>
  );
}
