import { redirect } from "next/navigation";
import { z } from "zod";
import { intakeMessage, listBusinesses, portalContext } from "@hd/core";

export const dynamic = "force-dynamic";

/**
 * The web widget / portal form.
 *
 * Same door as email: it builds an InboundMessage and hands it to
 * intakeMessage, so dedupe, identity resolution, secret scrubbing and the
 * audit trail are identical. A second intake path with its own rules is how
 * channels drift apart.
 */
async function submit(formData: FormData): Promise<void> {
  "use server";

  const businesses = await listBusinesses();
  const business = businesses[0];
  if (!business) throw new Error("no tenant configured");

  const email = String(formData.get("email") ?? "").trim().toLowerCase();
  const subject = String(formData.get("subject") ?? "").trim();
  const body = String(formData.get("body") ?? "").trim();
  const name = String(formData.get("name") ?? "").trim();

  if (!email || !subject || !body) {
    redirect("/portal/new?error=missing");
  }
  if (!z.email().safeParse(email).success) {
    redirect("/portal/new?error=email");
  }

  // The tenant comes from the deployment, not from the form. A hidden field
  // naming a business would be the browser choosing the tenant again.
  const ctx = portalContext(business.id);

  await intakeMessage(ctx, {
    source: "widget",
    // Widget submissions have no Message-ID, so idempotency is per submission.
    source_message_id: `widget-${crypto.randomUUID()}`,
    requester_email: email,
    requester_name: name || null,
    subject,
    body,
    attachments: [],
    received_at: new Date(),
    meta: { via: "portal_form" },
  });

  // Never the portal link. This form is unauthenticated and the address in it
  // is whatever somebody typed, so redirecting to that address's portal would
  // hand their whole ticket history — and every reply in it — to anyone who
  // knows their email. The link is a capability, and it reaches its owner the
  // only way that proves ownership: in mail sent to that address.
  redirect("/portal/new?sent=1");
}

export default async function NewTicketPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; sent?: string }>;
}) {
  const { error, sent } = await searchParams;

  return (
    <div className="portal">
      <h1>Raise a ticket</h1>
      <p className="sub" style={{ marginTop: 0 }}>
        IT support. Tell us what is broken and what you were doing when it broke.
      </p>

      {error === "missing" ? (
        <div className="alert">Email, subject and description are all required.</div>
      ) : null}
      {error === "email" ? (
        <div className="alert">That does not look like an email address.</div>
      ) : null}
      {sent ? (
        <div className="alert warn">
          Ticket received. We will email you as it progresses, and those emails
          carry the link to your tickets.
        </div>
      ) : null}

      <form className="portal-card" action={submit}>
        <div className="field">
          <label htmlFor="email">Work email</label>
          <input id="email" name="email" type="text" required placeholder="you@company.example" />
        </div>
        <div className="field">
          <label htmlFor="name">Your name</label>
          <input id="name" name="name" type="text" placeholder="Optional" />
        </div>
        <div className="field">
          <label htmlFor="subject">What is the problem?</label>
          <input id="subject" name="subject" type="text" required placeholder="One line" />
        </div>
        <div className="field">
          <label htmlFor="body">Details</label>
          <textarea
            id="body"
            name="body"
            required
            placeholder="What happened, what you expected, any error message shown on screen, and when it started."
          />
          <span className="hint">
            Do not include your password. If you already have, say so — we will scrub
            it and ask you to change it.
          </span>
        </div>
        <button className="primary" type="submit">
          Send to IT
        </button>
      </form>
    </div>
  );
}
