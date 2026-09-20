"use client";

import { useState, useTransition } from "react";
import { previewChange, type ConfigFormKind, type ConfigResult } from "./actions";

/**
 * A settings form with an impact step in front of it.
 *
 * The sequence the governance requirement asks for: show the impact, require a
 * confirmation, record a reason, apply, audit. The important part is that the
 * confirmation is not decoration — `updateSettings` refuses a widening change
 * that arrives without `acknowledgeWidening`, so this component cannot be
 * bypassed by posting the form directly.
 *
 * Narrowing changes skip the extra step entirely. A person turning autonomy
 * *down* is applying the brake, and making them read a dialog first is exactly
 * the wrong friction to add.
 */
export function ChangeForm({
  kind,
  action,
  children,
  submitLabel = "Save",
  disabled = false,
  className,
}: {
  kind: ConfigFormKind;
  action: (formData: FormData) => Promise<ConfigResult>;
  children: React.ReactNode;
  submitLabel?: string;
  disabled?: boolean;
  className?: string;
}) {
  const [pending, startTransition] = useTransition();
  const [impact, setImpact] = useState<{ field: string; text: string }[] | null>(null);
  const [needsSecond, setNeedsSecond] = useState(false);
  const [result, setResult] = useState<ConfigResult | null>(null);
  const [form, setForm] = useState<FormData | null>(null);

  const reset = () => {
    setImpact(null);
    setNeedsSecond(false);
    setForm(null);
  };

  const onSubmit = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const data = new FormData(e.currentTarget);
    setResult(null);

    startTransition(async () => {
      const preview = await previewChange(kind, data);
      if (preview.status === "error") {
        setResult({ status: "error", message: preview.message });
        return;
      }
      if (preview.impact.length === 0) {
        setResult({ status: "noop" });
        return;
      }
      // Only a widening change gets the interstitial. Everything else is
      // audited just as carefully and applied straight away.
      if (!preview.needsConfirm) {
        setResult(await action(data));
        return;
      }
      setImpact(preview.impact);
      setNeedsSecond(preview.needsSecond);
      setForm(data);
    });
  };

  const confirm = () => {
    if (!form) return;
    const data = form;
    data.set("acknowledge", "on");
    startTransition(async () => {
      const out = await action(data);
      setResult(out);
      reset();
    });
  };

  return (
    <>
      <form onSubmit={onSubmit} className={className}>
        {children}
        <button type="submit" disabled={disabled || pending}>
          {pending ? "Checking…" : submitLabel}
        </button>
      </form>

      {impact ? (
        <div className="impact-panel" role="alertdialog" aria-label="Confirm change">
          <h3>This widens what the agent may do without a person</h3>
          <ul>
            {impact.map((i) => (
              <li key={i.field}>
                <code>{i.field}</code>
                <div>{i.text}</div>
              </li>
            ))}
          </ul>

          {needsSecond ? (
            <p className="sub">
              This tenant requires a second administrator. Confirming submits it
              for approval rather than applying it — and the person who approves
              it cannot be you.
            </p>
          ) : null}

          <div className="row">
            <button className="primary" onClick={confirm} disabled={pending}>
              {pending
                ? "Working…"
                : needsSecond
                  ? "Submit for approval"
                  : "I understand, apply it"}
            </button>
            <button onClick={reset} disabled={pending}>
              Cancel
            </button>
          </div>
        </div>
      ) : null}

      {result ? <ResultBanner result={result} onDismiss={() => setResult(null)} /> : null}
    </>
  );
}

/**
 * A plain form whose server action returns a result instead of nothing.
 *
 * Rollback and the second-administrator decision both produce an outcome
 * somebody needs to see — a new version number, or a refusal explaining that
 * you cannot approve your own proposal. A bare `<form action={...}>` requires
 * the action to return void, which would mean silently discarding exactly the
 * sentence the person is waiting for.
 */
export function ResultForm({
  action,
  children,
  className,
  confirm,
}: {
  action: (formData: FormData) => Promise<ConfigResult & { token?: string }>;
  children: React.ReactNode;
  className?: string;
  /** Shown in a browser confirm() before submitting, for destructive steps. */
  confirm?: string;
}) {
  const [pending, startTransition] = useTransition();
  const [result, setResult] = useState<(ConfigResult & { token?: string }) | null>(
    null,
  );

  return (
    <>
      <form
        className={className}
        onSubmit={(e) => {
          e.preventDefault();
          if (confirm && !window.confirm(confirm)) return;
          // `new FormData(form, submitter)` keeps the name/value of the button
          // that was pressed, which is how approve and reject share one form.
          const data = new FormData(
            e.currentTarget,
            (e.nativeEvent as SubmitEvent).submitter as HTMLElement | null,
          );
          setResult(null);
          startTransition(async () => setResult(await action(data)));
        }}
      >
        <fieldset disabled={pending} className="bare-fieldset">
          {children}
        </fieldset>
      </form>
      {result ? <ResultBanner result={result} onDismiss={() => setResult(null)} /> : null}
      {/*
        The one secret this console ever shows.
        An API key is stored as a hash, so this is the only moment it exists in
        readable form. It is deliberately not dismissed by clicking anywhere —
        unlike the banner above — because losing it means minting another one,
        and a person who clicks to dismiss a status message should not lose a
        credential by accident.
      */}
      {result && "token" in result && result.token ? (
        <div className="config-result warn" role="status">
          <strong>Copy this now. It is not stored and cannot be shown again.</strong>
          <br />
          <code style={{ userSelect: "all", wordBreak: "break-all" }}>
            {result.token}
          </code>
        </div>
      ) : null}
    </>
  );
}

function ResultBanner({
  result,
  onDismiss,
}: {
  result: ConfigResult & { token?: string };
  onDismiss: () => void;
}) {
  const [tone, text] = describe(result);
  return (
    <div className={`config-result ${tone}`} onClick={onDismiss} role="status">
      {text}
    </div>
  );
}

function describe(
  result: ConfigResult & { token?: string },
): ["ok" | "warn" | "bad", string] {
  switch (result.status) {
    case "applied":
      // Version 0 is the marker for an action that is audited but produces no
      // configuration snapshot — issuing a key, revoking one, resubscribing an
      // address. Claiming "saved as v0" would be nonsense.
      if (result.version === 0) {
        return ["ok", `Done. ${result.fields.join(", ")} — recorded in the audit log.`];
      }
      return [
        "ok",
        `Saved as configuration v${result.version}. ${result.fields.length} field${
          result.fields.length === 1 ? "" : "s"
        } changed, and the audit log has both values.`,
      ];
    case "noop":
      return ["ok", "Nothing changed."];
    case "proposed":
      return [
        "warn",
        "Submitted for a second administrator. It takes effect when somebody else approves it.",
      ];
    case "denied":
      return ["bad", result.message];
    case "confirm":
      return ["warn", "This change needs confirmation."];
    default:
      return ["bad", result.message];
  }
}
