import {
  effectiveMode,
  env,
  getSettings,
  currentBusiness,
  type Business,
  type BusinessSettings,
  type TenantContext,
} from "@hd/core";
import { requireConsole, switchableBusinesses, type ConsoleSession } from "./auth";

/**
 * Tenant resolution.
 *
 * This used to read a `hd_business` cookie and fall back to the first business
 * in the table — which meant the browser chose the tenant and nobody checked
 * whether the person was allowed to be in it. The tenant now comes from the
 * authenticated session, and `currentBusiness` takes the context rather than
 * an id, so there is no argument left for a caller to get wrong.
 */
export interface Tenant {
  ctx: TenantContext;
  business: Business;
  settings: BusinessSettings;
  /** After the tenant's kill switch is applied to the deployment mode. */
  mode: "shadow" | "assist" | "auto";
  /** Businesses this user may switch to. Never the full table. */
  switchable: { id: string; name: string }[];
  session: ConsoleSession;
}

/**
 * The signed-in user's tenant. Redirects to sign-in when there is not one, so
 * a page can use the result without a null check.
 */
export async function currentTenant(next?: string): Promise<Tenant> {
  const session = await requireConsole(next);
  const { ctx } = session;

  const [business, settings, switchable] = await Promise.all([
    currentBusiness(ctx),
    getSettings(ctx.businessId),
    switchableBusinesses(session),
  ]);

  return {
    ctx,
    business,
    settings,
    mode: effectiveMode(env.AGENT_MODE, settings),
    switchable,
    session,
  };
}

export function fmtDate(d: Date | string | null): string {
  if (!d) return "—";
  return new Date(d).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function fmtAgo(d: Date | string | null): string {
  if (!d) return "—";
  const ms = Date.now() - new Date(d).getTime();
  const mins = Math.round(ms / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

/** "in 25m" / "12m late". Used for SLA countdowns, where sign matters. */
export function fmtDelta(minutes: number | null): string {
  if (minutes === null) return "—";
  const abs = Math.abs(minutes);
  const unit = abs < 60 ? `${abs}m` : abs < 1440 ? `${Math.round(abs / 60)}h` : `${Math.round(abs / 1440)}d`;
  return minutes < 0 ? `${unit} late` : `in ${unit}`;
}

export function pct(n: number | null | undefined, digits = 0): string {
  if (n === null || n === undefined || Number.isNaN(n)) return "—";
  return `${(n * 100).toFixed(digits)}%`;
}

export function money(n: number | null | undefined, digits = 4): string {
  if (n === null || n === undefined || Number.isNaN(Number(n))) return "—";
  return `$${Number(n).toFixed(digits)}`;
}
