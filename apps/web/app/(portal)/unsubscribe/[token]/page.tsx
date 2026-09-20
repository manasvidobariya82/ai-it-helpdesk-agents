import {
  getBusiness,
  NotificationKind,
  optOut,
  systemContext,
  verifyUnsubscribeToken,
} from "@hd/core";

export const dynamic = "force-dynamic";

/**
 * The unsubscribe link at the bottom of every staff notification.
 *
 * No session, deliberately. The people who most need this are the ones who
 * cannot sign in — a member of staff reading mail on a phone, somebody whose
 * console account was never created — and a preferences page behind a login is
 * a preferences page that does not work for them. The authorization is the
 * signed token: it names the tenant, the address and the kind, and it is
 * verified before anything is written.
 *
 * Acting on a GET is a deliberate exception to the usual rule. Mail clients do
 * not POST, link scanners that prefetch are the reason the standard has
 * `List-Unsubscribe-Post`, and the worst case here is that somebody stops
 * receiving email they can have switched back on by asking. That is the right
 * side of the trade: the alternative is a form that half of recipients never
 * reach, and an unsubscribe link that does not work is what turns a
 * notification system into a spam complaint.
 */
export default async function UnsubscribePage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  const claim = verifyUnsubscribeToken(decodeURIComponent(token));

  if (!claim) {
    return (
      <Shell title="That link is not valid">
        <p>
          It may have been truncated by a mail client, or the signing secret has
          been rotated since it was sent. Nothing has been changed.
        </p>
        <p className="sub">
          Reply to any notification and ask to be taken off the list, and
          somebody will do it from the console.
        </p>
      </Shell>
    );
  }

  // The tenant comes out of the signed token, never out of the URL as a
  // separate parameter — the same rule the intake webhook and the bounce
  // endpoint follow.
  const business = await getBusiness(claim.businessId);
  if (!business) {
    return (
      <Shell title="That link is not valid">
        <p>Nothing has been changed.</p>
      </Shell>
    );
  }

  const kind = claim.kind === "all" ? "all" : NotificationKind.parse(claim.kind);
  const ctx = systemContext(business.id, { requestId: "unsubscribe" });
  const changed = await optOut(ctx, {
    email: claim.email,
    kind,
    reason: "unsubscribe link",
    source: "self",
  });

  return (
    <Shell title={changed ? "Done — you are unsubscribed" : "You were already unsubscribed"}>
      <p>
        <strong>{claim.email}</strong> will no longer receive{" "}
        {kind === "all" ? (
          <>any notifications</>
        ) : (
          <>
            <code>{kind}</code> notifications
          </>
        )}{" "}
        from {business.name}.
      </p>
      <p className="sub">
        This does not affect replies about your own tickets, and it does not
        change anything for anybody else. To reverse it, ask the service desk —
        putting an address back on the list is recorded with a reason, which is
        why there is no button for it here.
      </p>
    </Shell>
  );
}

function Shell({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <main className="portal">
      <div className="panel">
        <div className="panel-head">
          <h2>{title}</h2>
        </div>
        <div className="panel-body">{children}</div>
      </div>
    </main>
  );
}
