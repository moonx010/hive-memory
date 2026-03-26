# Design: multi-user-access

## Overview

Extends the existing HTTP auth from a single `CORTEX_AUTH_TOKEN` environment variable to a `users` table in SQLite with per-user hashed API keys. The auth middleware resolves the Bearer token to a `userId` which is injected into tool handlers for entity attribution.

## Directory / File Layout

```
src/
  db/schema.ts           ← add users table (schema v4 migration)
  index.ts               ← update HTTP auth middleware to user lookup
  auth.ts                ← NEW: auth helpers (createUser, verifyToken, listUsers, revokeUser)
  cli.ts                 ← add "user" subcommand handlers
  store.ts               ← accept optional userId context in store methods
  types.ts               ← add User type
```

## Schema Design

```sql
CREATE TABLE IF NOT EXISTS users (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  email       TEXT,
  api_key_hash TEXT NOT NULL UNIQUE,
  role        TEXT NOT NULL DEFAULT 'member',
  created_at  TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'active'
);

CREATE INDEX IF NOT EXISTS idx_users_api_key_hash ON users(api_key_hash);
CREATE INDEX IF NOT EXISTS idx_users_status ON users(status);
```

## Auth Flow

```
Request → Extract Bearer token
       → SHA-256 hash the token
       → SELECT * FROM users WHERE api_key_hash = ? AND status = 'active'
       → Found? → inject userId into request context
       → Not found? → fall back to CORTEX_AUTH_TOKEN check
       → Neither? → 401 Unauthorized
```

### Backward Compatibility

The auth middleware checks in order:
1. If Bearer token matches a user in the `users` table → authenticated as that user.
2. If `CORTEX_AUTH_TOKEN` is set and Bearer token matches → authenticated as "system" (no userId).
3. If neither `CORTEX_AUTH_TOKEN` nor any users exist → no auth required (local dev mode).
4. Otherwise → 401.

## API Key Generation

```typescript
// src/auth.ts
import { randomBytes, createHash } from "node:crypto";

export function generateApiKey(): { plaintext: string; hash: string } {
  const plaintext = randomBytes(32).toString("hex"); // 64-char hex string
  const hash = createHash("sha256").update(plaintext).digest("hex");
  return { plaintext, hash };
}

export function hashApiKey(plaintext: string): string {
  return createHash("sha256").update(plaintext).digest("hex");
}
```

## HTTP Middleware Update

In `src/index.ts`, replace the current auth block (lines 122-129):

```typescript
// Current:
if (authToken) {
  const provided = req.headers.authorization?.replace("Bearer ", "");
  if (provided !== authToken) { res.writeHead(401); res.end("Unauthorized"); return; }
}

// New:
const { userId, authorized } = resolveAuth(db, req.headers.authorization, authToken);
if (!authorized) { res.writeHead(401); res.end("Unauthorized"); return; }
// userId is available for tool handlers
```

## CLI Commands

```bash
# Create a new user
hive-memory user create alice --email alice@company.com
# Output: User created. API key (save this — it won't be shown again):
#   hm_a1b2c3d4e5f6...

# List all users
hive-memory user list
# Output:
#   ID                                    Name    Email              Status   Created
#   550e8400-e29b-41d4-a716-446655440000  alice   alice@company.com  active   2026-03-26

# Revoke a user
hive-memory user revoke 550e8400-e29b-41d4-a716-446655440000
# Output: User alice revoked.
```

## Entity Attribution

When a tool handler receives a request with a resolved `userId`:
- `memory_store` sets `author` to `userId` (overrides any caller-provided author).
- `session_save` sets `author` to `userId`.
- Other read-only tools (recall, browse, etc.) are unaffected — all users see all data.

## Key Design Decisions

1. **SHA-256 hash, not bcrypt** — API keys are high-entropy random bytes (256 bits), not human-chosen passwords. SHA-256 is sufficient and fast for lookup.
2. **`hm_` prefix for API keys** — makes keys identifiable in logs and secret scanners.
3. **No expiry in MVP** — keys are valid until revoked. Add TTL in v2.
4. **No per-user data isolation** — all users see all entities. This matches the "company brain" vision.
