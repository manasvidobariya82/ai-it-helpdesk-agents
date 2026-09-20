import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

const scryptAsync = promisify(scrypt) as (
  password: string | Buffer,
  salt: string | Buffer,
  keylen: number,
  options: { N: number; r: number; p: number; maxmem: number },
) => Promise<Buffer>;

/**
 * Password hashing with scrypt from the standard library.
 *
 * No dependency, because a password hash is exactly the kind of thing that
 * should not arrive through a supply chain, and scrypt in `node:crypto` is
 * memory-hard and well tested. Parameters are stored in the hash string so
 * raising them later does not invalidate existing passwords.
 */
const N = 16384;
const R = 8;
const P = 1;
const KEYLEN = 64;
// scrypt needs roughly 128 * N * r bytes; the default cap is below that at
// N=16384, so it is raised explicitly rather than silently failing at runtime.
const MAXMEM = 64 * 1024 * 1024;

export async function hashPassword(password: string): Promise<string> {
  if (password.length < 12) {
    throw new Error("Password must be at least 12 characters");
  }
  const salt = randomBytes(16);
  const derived = await scryptAsync(password, salt, KEYLEN, {
    N,
    r: R,
    p: P,
    maxmem: MAXMEM,
  });
  return [
    "scrypt",
    String(N),
    String(R),
    String(P),
    salt.toString("base64"),
    derived.toString("base64"),
  ].join("$");
}

/**
 * Constant-time verification.
 *
 * Returns false for a malformed or absent hash rather than throwing: a user
 * row with no password is one that cannot sign in, not an error to surface to
 * whoever is guessing at the login form.
 */
export async function verifyPassword(
  password: string,
  stored: string | null | undefined,
): Promise<boolean> {
  if (!stored) return false;
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;

  const n = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  if (!Number.isFinite(n) || !Number.isFinite(r) || !Number.isFinite(p)) return false;

  let salt: Buffer;
  let expected: Buffer;
  try {
    salt = Buffer.from(parts[4]!, "base64");
    expected = Buffer.from(parts[5]!, "base64");
  } catch {
    return false;
  }
  if (expected.length === 0) return false;

  const derived = await scryptAsync(password, salt, expected.length, {
    N: n,
    r,
    p,
    maxmem: MAXMEM,
  });
  return derived.length === expected.length && timingSafeEqual(derived, expected);
}
