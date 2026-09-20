import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "node:crypto";
import { query, queryOne } from "../db.js";
import { NotFoundError, requirePermission, type TenantContext } from "../auth/context.js";
import { env } from "../env.js";
import { audit } from "./audit.js";

/**
 * Integration credentials.
 *
 * These live in their own table rather than in `businesses.settings` for one
 * reason: settings are readable by anyone holding `config:read`, which is most
 * of the console, and an Entra client secret must not be. Splitting the storage
 * splits the permission — `credentials:read` is held by `security_admin` alone.
 *
 * Two separate protections, because they fail differently. `credentials:read`
 * stops an authorised-but-wrong user; encryption at rest stops a database dump.
 * Neither substitutes for the other.
 */

const ALGORITHM = "aes-256-gcm";
const IV_BYTES = 12;

/**
 * Derive the AES key from `CREDENTIALS_KEY`.
 *
 * A missing key in development gets a deterministic development key and a
 * warning rather than a crash, because a developer running `npm run dev`
 * should get a working console. A missing key with `NODE_ENV=production` is a
 * refusal: silently encrypting production secrets under a key that is in the
 * source tree is worse than not starting.
 */
let warned = false;
function credentialKey(): Buffer {
  const raw = env.CREDENTIALS_KEY.trim();
  if (!raw) {
    if (process.env.NODE_ENV === "production") {
      throw new Error(
        "CREDENTIALS_KEY is required in production. Generate one with " +
          "`node -e \"console.log(require('crypto').randomBytes(32).toString('base64'))\"`.",
      );
    }
    if (!warned) {
      warned = true;
      console.warn(
        "[credentials] CREDENTIALS_KEY is unset; using a development key. " +
          "Secrets stored now are not protected at rest.",
      );
    }
    return createHash("sha256").update("hd-dev-credentials-key").digest();
  }
  // Any length of key material is accepted and hashed to 32 bytes, so rotating
  // to a longer secret does not need a different code path.
  return createHash("sha256").update(raw).digest();
}

export function encryptSecret(plaintext: string): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, credentialKey(), iv);
  const enc = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return ["v1", iv.toString("base64"), tag.toString("base64"), enc.toString("base64")].join(
    "$",
  );
}

export function decryptSecret(stored: string): string {
  const parts = stored.split("$");
  if (parts.length !== 4 || parts[0] !== "v1") {
    throw new Error("Stored credential is not in a recognised format");
  }
  const decipher = createDecipheriv(
    ALGORITHM,
    credentialKey(),
    Buffer.from(parts[1]!, "base64"),
  );
  decipher.setAuthTag(Buffer.from(parts[2]!, "base64"));
  return Buffer.concat([
    decipher.update(Buffer.from(parts[3]!, "base64")),
    decipher.final(),
  ]).toString("utf8");
}

/** What a listing returns. Note the absence of a secret field — that is the point. */
export interface CredentialSummary {
  id: string;
  provider: string;
  label: string;
  /** Last four characters, so an operator can tell two keys apart. */
  hint: string;
  created_by: string | null;
  created_at: Date;
  updated_at: Date;
}

/**
 * List the tenant's integrations without their secrets.
 *
 * Gated on `security:read` rather than `credentials:read`: an admin is allowed
 * to know that a Jira integration exists and when it was last rotated. Reading
 * the secret itself is a different permission and a different function.
 */
export async function listCredentials(
  ctx: TenantContext,
): Promise<CredentialSummary[]> {
  requirePermission(ctx, "security:read");
  return query<CredentialSummary>(
    `select id, provider, label,
            '••••' || right(secret, 4) as hint,
            created_by, created_at, updated_at
       from integration_credentials
      where business_id = $1
      order by provider`,
    [ctx.businessId],
  );
}

/**
 * Read one secret in the clear.
 *
 * Every call writes an audit row before returning, including the reason, which
 * is why the parameter is required rather than optional. A credential read
 * that leaves no trace is indistinguishable from an exfiltration.
 */
export async function readCredential(
  ctx: TenantContext,
  provider: string,
  reason: string,
): Promise<string> {
  requirePermission(ctx, "credentials:read");
  if (!reason.trim()) throw new Error("Reading a credential requires a reason");

  const row = await queryOne<{ id: string; secret: string }>(
    `select id, secret from integration_credentials
      where business_id = $1 and provider = $2`,
    [ctx.businessId, provider],
  );
  if (!row) throw new NotFoundError("integration_credential");

  await audit(ctx, {
    action: "credentials.read",
    resource_type: "integration_credential",
    resource_id: provider,
    reason,
  });

  return decryptSecret(row.secret);
}

/**
 * Create or rotate a credential.
 *
 * The audit row records that the secret changed and never what it changed to —
 * an audit log containing the secrets is a second copy of the thing being
 * protected, in the table most likely to be exported to a SIEM.
 */
export async function putCredential(
  ctx: TenantContext,
  input: { provider: string; label?: string; secret: string },
): Promise<CredentialSummary> {
  requirePermission(ctx, "credentials:update");
  if (!input.secret.trim()) throw new Error("A credential cannot be empty");

  const existing = await queryOne<{ id: string }>(
    `select id from integration_credentials where business_id = $1 and provider = $2`,
    [ctx.businessId, input.provider],
  );

  const row = await queryOne<CredentialSummary>(
    `insert into integration_credentials (business_id, provider, label, secret, created_by)
     values ($1,$2,$3,$4,$5)
     on conflict (business_id, provider) do update
       set secret = excluded.secret,
           label = excluded.label,
           updated_at = now()
     returning id, provider, label, '••••' || right(secret, 4) as hint,
               created_by, created_at, updated_at`,
    [
      ctx.businessId,
      input.provider,
      input.label ?? "",
      encryptSecret(input.secret),
      ctx.actorId,
    ],
  );

  await audit(ctx, {
    action: "credentials.update",
    resource_type: "integration_credential",
    resource_id: input.provider,
    old_value: existing ? { present: true } : null,
    new_value: { present: true, rotated: Boolean(existing) },
  });

  return row!;
}

export async function deleteCredential(
  ctx: TenantContext,
  provider: string,
): Promise<void> {
  requirePermission(ctx, "credentials:update");
  const deleted = await queryOne<{ id: string }>(
    `delete from integration_credentials
      where business_id = $1 and provider = $2
      returning id`,
    [ctx.businessId, provider],
  );
  if (!deleted) throw new NotFoundError("integration_credential");

  await audit(ctx, {
    action: "credentials.update",
    resource_type: "integration_credential",
    resource_id: provider,
    old_value: { present: true },
    new_value: { present: false },
  });
}
