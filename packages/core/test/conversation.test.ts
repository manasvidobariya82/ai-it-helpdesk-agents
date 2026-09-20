import { describe, expect, it } from "vitest";
import { conversationState, type ConversationMessage } from "../src/repos/conversations.js";

/**
 * The state of a conversation, folded from its messages (C12 in
 * docs/conversation.md). No database: the fold is pure, and whatever a
 * conversation's state is has to follow from its messages alone.
 */

type Row = Pick<ConversationMessage, "seq" | "kind" | "visibility" | "author_kind" | "created_at">;

const at = (minute: number) => new Date(Date.UTC(2026, 8, 19, 9, minute));
const row = (
  seq: number,
  author_kind: Row["author_kind"],
  visibility: Row["visibility"] = "public",
  kind: Row["kind"] = "message",
): Row => ({ seq, kind, visibility, author_kind, created_at: at(seq) });

describe("conversationState", () => {
  it("C12 is empty before anybody has written", () => {
    expect(conversationState([])).toEqual({
      messages: 0,
      public: 0,
      internal: 0,
      lastSeq: 0,
      lastPublicAt: null,
      lastPublicAuthor: null,
      awaiting: null,
    });
  });

  it("C12 waits on the desk after the requester writes, and on the requester after the desk replies", () => {
    const asked = [row(1, "requester")];
    expect(conversationState(asked).awaiting).toBe("desk");

    const answered = [...asked, row(2, "staff")];
    expect(conversationState(answered).awaiting).toBe("requester");

    // The agent and the system speak for the desk too.
    expect(conversationState([...asked, row(2, "ai")]).awaiting).toBe("requester");
    expect(conversationState([...asked, row(2, "system")]).awaiting).toBe("requester");
  });

  it("C12 gives no turn to notes, drafts or events", () => {
    // The requester wrote last in public. A note, the agent's draft and a
    // status change shown in the thread are the desk working, not answering.
    const s = conversationState([
      row(1, "requester"),
      row(2, "staff", "internal"),
      row(3, "ai", "internal", "draft"),
      row(4, "system", "public", "event"),
    ]);
    expect(s.awaiting).toBe("desk");
    expect(s.lastPublicAuthor).toBe("requester");
    expect(s.lastPublicAt).toEqual(at(1));
    expect(s.lastSeq).toBe(4);
    expect(s).toMatchObject({ messages: 4, public: 2, internal: 2 });
  });

  it("C2 C12 folds in seq order, whatever order the rows are handed in", () => {
    // The order is `seq`, never the order a caller happened to collect rows in.
    const s = conversationState([row(3, "staff"), row(1, "staff"), row(2, "requester")]);
    expect(s.awaiting).toBe("requester");
    expect(s.lastPublicAuthor).toBe("staff");
    expect(s.lastSeq).toBe(3);
  });
});
