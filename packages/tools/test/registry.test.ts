import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

// The registry logs every call to Postgres. These tests are about the risk
// gate, not the audit trail, so only the log is stubbed — the authorization
// helpers are the real ones, because a mocked `requirePermission` would make
// the permission half of the gate untestable.
const approvalStub = vi.hoisted(() => ({
  value: { ok: true } as
    | { ok: true; request: unknown }
    | { ok: false; reason: "not_found" | "not_approved" | "expired" | "args_changed" },
}));

vi.mock("@hd/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@hd/core")>();
  return {
    ...actual,
    logToolCall: vi.fn(async () => {}),
    // Stubbed because these tests are about the gate, not about Postgres. The
    // real `checkApproval` is exercised against a live database in
    // packages/core/test/approvals.test.ts.
    checkApproval: vi.fn(async () => approvalStub.value),
  };
});

const { agentContext, humanContext } = await import("@hd/core");
const { ApprovalRequiredError, ToolPermissionError, defineTool, executeTool, listTools } =
  await import("../src/registry.js");
type RiskTier = import("../src/registry.js").RiskTier;

const BUSINESS = "00000000-0000-0000-0000-0000000000b1";

/** The pipeline's own context: may execute, may not approve. */
const ctx = { tenant: agentContext(BUSINESS), ticketId: "t1" };

/** A viewer, who may do neither. */
const viewerCtx = {
  tenant: humanContext({
    businessId: BUSINESS,
    actorId: "usr-viewer",
    actorEmail: "viewer@example.com",
    role: "viewer",
  }),
  ticketId: "t1",
};
const opts = { whitelist: ["safe.whitelisted"], agent: "helpdesk" as const, rationale: "test" };

const ran: string[] = [];
const make = (name: string, riskTier: RiskTier) =>
  defineTool({
    name,
    description: name,
    riskTier,
    agents: ["helpdesk"],
    schema: z.object({ email: z.email() }),
    summarize: () => name,
    execute: async () => {
      ran.push(name);
      return { ok: true };
    },
  });

make("read.tool", "read");
make("internal.tool", "internal");
make("safe.whitelisted", "safe_write");
make("safe.notlisted", "safe_write");
make("sensitive.tool", "sensitive");
make("destructive.tool", "destructive");

defineTool({
  name: "ops.only",
  description: "ops only",
  riskTier: "read",
  agents: ["ops"],
  schema: z.object({}),
  summarize: () => "ops only",
  execute: async () => ({}),
});

const args = { email: "a@b.example" };

describe("risk gate", () => {
  it("runs read tools unattended", async () => {
    await expect(executeTool("read.tool", args, ctx, opts)).resolves.toEqual({ ok: true });
  });

  it("runs internal tools unattended, whitelist or not", async () => {
    // Escalation lives in this tier. A gate that can block handing work to a
    // human turns a cautious agent into a stuck one.
    await expect(
      executeTool("internal.tool", args, ctx, { ...opts, whitelist: [] }),
    ).resolves.toEqual({ ok: true });
  });

  it("runs a whitelisted safe_write tool", async () => {
    await expect(executeTool("safe.whitelisted", args, ctx, opts)).resolves.toEqual({
      ok: true,
    });
  });

  it("queues a safe_write tool that is not whitelisted", async () => {
    await expect(executeTool("safe.notlisted", args, ctx, opts)).rejects.toBeInstanceOf(
      ApprovalRequiredError,
    );
  });

  it("always queues sensitive tools, whitelist or not", async () => {
    await expect(
      executeTool("sensitive.tool", args, ctx, {
        ...opts,
        whitelist: ["sensitive.tool"],
      }),
    ).rejects.toBeInstanceOf(ApprovalRequiredError);
  });

  it("never runs a destructive tool without an approval, whatever the whitelist says", async () => {
    await expect(
      executeTool("destructive.tool", args, ctx, {
        ...opts,
        whitelist: ["destructive.tool"],
      }),
    ).rejects.toBeInstanceOf(ApprovalRequiredError);
    expect(ran).not.toContain("destructive.tool");
  });

  it("runs a destructive tool once an approval id is present", async () => {
    await expect(
      executeTool("destructive.tool", args, { ...ctx, approvalId: "appr-1" }, opts),
    ).resolves.toEqual({ ok: true });
    expect(ran).toContain("destructive.tool");
  });
});

describe("permissions and validation", () => {
  it("refuses a tool belonging to another agent", async () => {
    await expect(executeTool("ops.only", {}, ctx, opts)).rejects.toBeInstanceOf(
      ToolPermissionError,
    );
  });

  it("rejects invalid arguments before the risk gate", async () => {
    await expect(
      executeTool("read.tool", { email: "not-an-email" }, ctx, opts),
    ).rejects.toThrow(/Invalid arguments/);
  });

  it("rejects an unknown tool", async () => {
    await expect(executeTool("nope", {}, ctx, opts)).rejects.toThrow(/Unknown tool/);
  });

  it("lists only the tools an agent may use", () => {
    const names = listTools("helpdesk").map((t) => t.name);
    expect(names).toContain("read.tool");
    expect(names).not.toContain("ops.only");
  });
});

/**
 * The risk gate answers "does this call need a human". These answer "is this
 * caller allowed to make it at all" — a separate question that the gate alone
 * never asked, which is how a read-only console user could have run a
 * whitelisted tool.
 */
describe("authorization", () => {
  it("refuses a caller without action:execute", async () => {
    // `ran` is cumulative across this file, so the assertion is that nothing
    // new was appended rather than that the name is absent.
    const before = ran.length;
    await expect(
      executeTool("safe.whitelisted", args, viewerCtx, opts),
    ).rejects.toThrow(/lacks action:execute/);
    expect(ran.length).toBe(before);
  });

  it("still lets that caller run read tools, which the repository gates", async () => {
    await expect(executeTool("read.tool", args, viewerCtx, opts)).resolves.toEqual({
      ok: true,
    });
  });

  it("treats a valid approval as the authorization for that one call", async () => {
    // The approver held `action:approve` when the row was written; the executor
    // need not also hold `action:execute`, or a manager could approve an action
    // nobody present is able to run.
    approvalStub.value = { ok: true, request: {} };
    await expect(
      executeTool("sensitive.tool", args, { ...viewerCtx, approvalId: "appr-2" }, opts),
    ).resolves.toEqual({ ok: true });
  });
});

/**
 * The gate used to unlock on `Boolean(ctx.approvalId)`, so any non-empty string
 * ran a destructive tool. These are the four ways that was wrong.
 */
describe("an approval id is not a password", () => {
  const cases = [
    ["expired", /expired before it was executed/],
    ["not_approved", /cannot be replayed/],
    ["not_found", /No approval/],
    ["args_changed", /differ from the ones that were approved/],
  ] as const;

  for (const [reason, message] of cases) {
    it(`refuses a destructive tool when the approval is ${reason}`, async () => {
      approvalStub.value = { ok: false, reason };
      const before = ran.length;
      await expect(
        executeTool(
          "destructive.tool",
          args,
          { ...ctx, approvalId: "appr-bad" },
          { ...opts, whitelist: ["destructive.tool"] },
        ),
      ).rejects.toThrow(message);
      expect(ran.length).toBe(before);
    });
  }

  it("refuses even when the caller also holds action:execute", async () => {
    // The approval is the authorization for *this* call. A caller who could
    // have run something else unattended does not thereby get to run the thing
    // an expired approval was about.
    approvalStub.value = { ok: false, reason: "expired" };
    await expect(
      executeTool("sensitive.tool", args, { ...ctx, approvalId: "appr-bad" }, opts),
    ).rejects.toThrow(/expired/);
  });
});
