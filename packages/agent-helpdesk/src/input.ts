import { redactForModel, type RedactionHit, type Ticket } from "@hd/core";
import { scanForInjection, wrapUntrusted, type InjectionScan } from "@hd/llm";

export interface PreparedInput {
  /** Redacted, fenced, ready to drop into a user message. */
  block: string;
  redactions: RedactionHit[];
  injection: InjectionScan;
}

/**
 * Everything a requester wrote goes through here before it reaches a model.
 *
 * Order matters: scan the raw text (so an injection attempt is detected even
 * if redaction would have mangled it), then redact, then fence. Redacting
 * first would let `ignore previous instructions, my email is a@b.com` lose the
 * part the scanner needs.
 */
export function prepareTicketInput(ticket: Pick<Ticket, "subject" | "body">): PreparedInput {
  const raw = `Subject: ${ticket.subject}\n\n${ticket.body}`;
  const injection = scanForInjection(raw);
  const { text, hits } = redactForModel(raw);
  const { text: block } = wrapUntrusted("ticket", text);

  return { block, redactions: hits, injection };
}

/** Same treatment for free text that is not a whole ticket (a thread reply). */
export function prepareText(label: string, raw: string): PreparedInput {
  const injection = scanForInjection(raw);
  const { text, hits } = redactForModel(raw);
  const { text: block } = wrapUntrusted(label, text);
  return { block, redactions: hits, injection };
}
