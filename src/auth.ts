import crypto from "node:crypto";
import type { HiveDatabase } from "./db/database.js";
import type { User } from "./types.js";

// ── API key helpers ───────────────────────────────────────────────────────────

/** Generate a new random API key: "hm_" + 64 hex chars (256 bits of entropy). */
export function generateApiKey(): { plaintext: string; hash: string } {
  const plaintext = "hm_" + crypto.randomBytes(32).toString("hex");
  const hash = hashApiKey(plaintext);
  return { plaintext, hash };
}

/** SHA-256 hex digest of the given API key. */
export function hashApiKey(plaintext: string): string {
  return crypto.createHash("sha256").update(plaintext).digest("hex");
}

// ── User CRUD ─────────────────────────────────────────────────────────────────

/** Create a new user. Returns the user record and the plaintext API key (shown once). */
export function createUser(
  db: HiveDatabase,
  name: string,
  email?: string,
): { user: User; plaintextKey: string } {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const { plaintext, hash } = generateApiKey();

  db.insertUser({
    id,
    name,
    email,
    apiKeyHash: hash,
    role: "member",
    createdAt: now,
    status: "active",
  });

  const user: User = { id, name, email, role: "member", createdAt: now, status: "active" };
  return { user, plaintextKey: plaintext };
}

/** Validate a Bearer token. Returns the matching active User, or null. */
export function verifyToken(db: HiveDatabase, token: string): User | null {
  const hash = hashApiKey(token);
  const row = db.getUserByApiKeyHash(hash);
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    role: row.role,
    createdAt: row.createdAt,
    status: row.status,
  };
}

/** List all users (all statuses). */
export function listUsers(db: HiveDatabase): User[] {
  return db.listUsers().map((row) => ({
    id: row.id,
    name: row.name,
    email: row.email,
    role: row.role,
    createdAt: row.createdAt,
    status: row.status,
  }));
}

/** Revoke a user by setting status = 'revoked'. */
export function revokeUser(db: HiveDatabase, userId: string): void {
  db.updateUserStatus(userId, "revoked");
}

// ── Auth resolution ───────────────────────────────────────────────────────────

export interface AuthContext {
  authorized: boolean;
  userId?: string;
  userName?: string;
}

/**
 * Resolve a Bearer token against the users table then fall back to CORTEX_AUTH_TOKEN.
 *
 * Resolution order:
 * 1. Per-user token in `users` table → authorized, userId set.
 * 2. CORTEX_AUTH_TOKEN match → authorized as system (no userId).
 * 3. Neither configured (no users + no admin token) → local dev mode, authorized.
 * 4. Otherwise → not authorized.
 */
export function resolveAuth(
  db: HiveDatabase,
  authorizationHeader: string | undefined,
  adminToken: string | undefined,
): AuthContext {
  const provided = authorizationHeader?.replace(/^Bearer\s+/i, "");

  // Try user table lookup first
  if (provided) {
    const user = verifyToken(db, provided);
    if (user) {
      return { authorized: true, userId: user.id, userName: user.name };
    }
  }

  // Fall back to admin token
  if (adminToken) {
    if (provided === adminToken) {
      return { authorized: true };
    }
    // Admin token is configured but no match → reject
    return { authorized: false };
  }

  // Check if any users exist — if yes, require auth (even if all are revoked,
  // the system has been set up with auth, so unauthenticated access is not allowed).
  const users = db.listUsers();
  if (users.length > 0) {
    return { authorized: false };
  }

  // No auth configured — local dev mode
  return { authorized: true };
}
