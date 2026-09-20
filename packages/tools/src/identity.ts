import { findRequesterByEmail, primaryAsset, query } from "@hd/core";
import { z } from "zod";
import { defineTool } from "./registry.js";

/**
 * Identity-provider tools (Entra ID / Okta / Google Workspace).
 *
 * The read tools resolve against the local directory mirror, which is real.
 * The write tools are wired but unimplemented against a live provider: they
 * return `{ simulated: true }` and say so. That is deliberate - phase 5 starts
 * with read-only calls, and a stub that announces itself is safer than one
 * that quietly pretends to have granted access.
 */

const providerConfigured = (): boolean =>
  Boolean(process.env.ENTRA_TENANT_ID || process.env.OKTA_DOMAIN || process.env.GOOGLE_CUSTOMER_ID);

function simulated(action: string, detail: Record<string, unknown>) {
  return {
    simulated: true,
    action,
    ...detail,
    note: "No identity provider is configured. Nothing was changed upstream.",
  };
}

export const directoryLookup = defineTool({
  name: "identity.lookup_user",
  description:
    "Look up a person in the directory: department, role, VIP flag, assigned device.",
  riskTier: "read",
  agents: ["helpdesk", "ops"],
  schema: z.object({ email: z.email() }),
  summarize: (a) => `Look up ${a.email} in the directory`,
  execute: async (args, ctx) => {
    const person = await findRequesterByEmail(ctx.tenant.businessId, args.email);
    if (!person) return { found: false };
    const asset = await primaryAsset(ctx.tenant, person.id);
    return {
      found: true,
      email: person.email,
      full_name: person.full_name,
      department: person.department,
      role: person.role,
      vip: person.vip,
      directory_id: person.directory_id,
      device: asset
        ? { kind: asset.kind, os: asset.os, tag: asset.asset_tag, last_seen_at: asset.last_seen_at }
        : null,
    };
  },
});

export const groupMembership = defineTool({
  name: "identity.list_groups",
  description: "List the security and distribution groups a person belongs to.",
  riskTier: "read",
  agents: ["helpdesk"],
  schema: z.object({ email: z.email() }),
  summarize: (a) => `List group membership for ${a.email}`,
  execute: async (args, ctx) => {
    const person = await findRequesterByEmail(ctx.tenant.businessId, args.email);
    if (!person) return { found: false, groups: [] };
    const groups = Array.isArray(person.metadata?.groups) ? person.metadata.groups : [];
    return { found: true, groups };
  },
});

export const resetPassword = defineTool({
  name: "identity.reset_password",
  description:
    "Issue a temporary password and force a change at next sign-in. Reversible; does not unlock a disabled account.",
  riskTier: "safe_write",
  agents: ["helpdesk"],
  schema: z.object({
    email: z.email(),
    notify_channel: z.enum(["email", "sms", "manager"]).default("manager"),
  }),
  summarize: (a) => `Reset password for ${a.email}, notify via ${a.notify_channel}`,
  execute: async (args) => {
    if (!providerConfigured()) {
      return simulated("reset_password", { email: args.email });
    }
    throw new Error(
      "identity.reset_password: provider client not implemented. Wire Entra/Okta here before enabling.",
    );
  },
});

export const unlockAccount = defineTool({
  name: "identity.unlock_account",
  description: "Clear a lockout caused by repeated failed sign-ins.",
  riskTier: "safe_write",
  agents: ["helpdesk"],
  schema: z.object({ email: z.email() }),
  summarize: (a) => `Unlock the account for ${a.email}`,
  execute: async (args) => {
    if (!providerConfigured()) return simulated("unlock_account", { email: args.email });
    throw new Error("identity.unlock_account: provider client not implemented.");
  },
});

export const addToGroup = defineTool({
  name: "identity.add_to_group",
  description: "Add a person to a group, granting whatever that group grants.",
  riskTier: "sensitive",
  agents: ["helpdesk"],
  schema: z.object({ email: z.email(), group: z.string().min(1) }),
  summarize: (a) => `Add ${a.email} to group ${a.group}`,
  execute: async (args) => {
    if (!providerConfigured()) {
      return simulated("add_to_group", { email: args.email, group: args.group });
    }
    throw new Error("identity.add_to_group: provider client not implemented.");
  },
});

export const removeFromGroup = defineTool({
  name: "identity.remove_from_group",
  description: "Remove a person from a group, revoking whatever it granted.",
  riskTier: "destructive",
  agents: ["helpdesk"],
  schema: z.object({ email: z.email(), group: z.string().min(1) }),
  summarize: (a) => `Remove ${a.email} from group ${a.group}`,
  execute: async (args) => {
    if (!providerConfigured()) {
      return simulated("remove_from_group", { email: args.email, group: args.group });
    }
    throw new Error("identity.remove_from_group: provider client not implemented.");
  },
});

export const disableAccount = defineTool({
  name: "identity.disable_account",
  description: "Disable an account. Used for offboarding and confirmed compromise.",
  riskTier: "destructive",
  agents: ["helpdesk"],
  schema: z.object({ email: z.email(), reason: z.string().min(1) }),
  summarize: (a) => `Disable the account for ${a.email} (${a.reason})`,
  execute: async (args) => {
    if (!providerConfigured()) {
      return simulated("disable_account", { email: args.email, reason: args.reason });
    }
    throw new Error("identity.disable_account: provider client not implemented.");
  },
});

export const grantLicence = defineTool({
  name: "identity.grant_licence",
  description: "Assign a software licence or SaaS seat to a person.",
  riskTier: "safe_write",
  agents: ["helpdesk"],
  schema: z.object({ email: z.email(), sku: z.string().min(1) }),
  summarize: (a) => `Grant licence ${a.sku} to ${a.email}`,
  execute: async (args, ctx) => {
    if (!providerConfigured()) {
      const seats = await query<{ n: number }>(
        `select count(*)::int as n from assets where business_id = $1 and kind = 'saas_seat'`,
        [ctx.tenant.businessId],
      );
      return simulated("grant_licence", {
        email: args.email,
        sku: args.sku,
        current_seats: seats[0]?.n ?? 0,
      });
    }
    throw new Error("identity.grant_licence: provider client not implemented.");
  },
});
