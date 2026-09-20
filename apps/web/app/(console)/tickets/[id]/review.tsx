"use client";

import { useState, useTransition } from "react";
import { sendDraft } from "./actions";

/**
 * The phase-3 workflow: the agent writes, a person reads it, edits if needed,
 * and clicks send. Editing before sending is the point - the edits are the
 * signal that tells you whether the draft was actually usable.
 */
export function ReviewPanel({
  ticketId,
  draft,
  draftId,
  canSend,
  canOverride,
}: {
  ticketId: string;
  draft: string;
  /** The draft message, so the reply records what it was made from. Null for a draft from before the conversation. */
  draftId: string | null;
  /** `action:execute`. Without it the draft is readable and not sendable. */
  canSend: boolean;
  canOverride: boolean;
}) {
  const [body, setBody] = useState(draft);
  const [pending, startTransition] = useTransition();
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const edited = body !== draft;

  if (sent) {
    return (
      <div className="draft-box">Sent, and the ticket is marked resolved.</div>
    );
  }

  // Read-only for anyone without `action:execute`. The server action checks the
  // same permission, so this only decides whether a button is worth showing.
  if (!canSend) {
    return (
      <div>
        <div className="draft-box">{draft}</div>
        <p className="sub">
          You can read this draft but not send it. Sending a reply needs
          <code> action:execute</code>
          {canOverride ? "; you can still correct the classification below." : "."}
        </p>
      </div>
    );
  }

  return (
    <div>
      <textarea
        value={body}
        onChange={(e) => setBody(e.target.value)}
        spellCheck={false}
      />
      <div className="row" style={{ marginTop: 10 }}>
        <button
          className="primary"
          disabled={pending || body.trim().length === 0}
          onClick={() =>
            startTransition(async () => {
              setError(null);
              try {
                await sendDraft(ticketId, body, draftId);
                setSent(true);
              } catch (err) {
                setError(err instanceof Error ? err.message : String(err));
              }
            })
          }
        >
          {pending ? "Sending…" : "Send and resolve"}
        </button>
        <button disabled={!edited || pending} onClick={() => setBody(draft)}>
          Revert edits
        </button>
        {edited ? <span className="sub">edited</span> : null}
      </div>
      {error ? (
        <p className="sub" style={{ color: "var(--danger)" }}>
          {error}
        </p>
      ) : null}
    </div>
  );
}
