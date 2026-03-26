# Change: multi-user-access

**Layer:** 1 (Hive-Memory)
**One-liner:** Per-user API keys with identity tracking, replacing the single shared `CORTEX_AUTH_TOKEN`.
**Estimated effort:** 3-4 days
**Dependencies:** None (extends existing HTTP auth in `src/index.ts` lines 122-129)

## Why

Hive-Memory currently supports only a single shared `CORTEX_AUTH_TOKEN`. This means:
- No way to know who stored a memory — the `author` field is set by the caller (easily spoofed or omitted).
- No way to issue per-user tokens for the Slack bot or MCP gateway features.
- No way to revoke access for a departed team member without rotating the token for everyone.

Multi-user auth is the foundation for every team-facing feature.

## What Changes

### In Scope

1. **New SQLite table: `users`** — stores user records with hashed API keys.
   - Columns: `id` (TEXT PK), `name` (TEXT), `email` (TEXT), `api_key_hash` (TEXT), `role` (TEXT DEFAULT 'member'), `created_at` (TEXT), `status` (TEXT DEFAULT 'active').
   - API keys are SHA-256 hashed at rest. Plaintext is shown once at creation time only.
   - Schema version bump: v3 → v4.

2. **Auth middleware update in `src/index.ts`** — replace single-token check with user lookup.
   - On each HTTP request, hash the provided Bearer token, look up in `users` table.
   - Inject `userId` into a request context object passed to tool handlers.
   - The `author` field on stored entities is automatically set to the resolved `userId`.
   - Backward compat: if `CORTEX_AUTH_TOKEN` is set and no `users` table entries exist, fall back to single-token mode.

3. **CLI commands for user management:**
   - `hive-memory user create <name> [--email <email>]` — generates a random 32-byte hex API key, stores SHA-256 hash, prints plaintext key once.
   - `hive-memory user list` — shows all users (id, name, email, created_at, status).
   - `hive-memory user revoke <user-id>` — sets user status to `revoked`.

4. **Entity attribution** — all `memory_store`, `session_save`, and connector-ingested entities set `author` to the authenticated user's ID when stored via HTTP mode.

### Out of Scope

- Role-based permissions (all users have equal access in MVP)
- API key rotation (revoke + create new is sufficient)
- Usage tracking / rate limiting per user
- OAuth / JWT / external identity providers
- Admin dashboard or web UI

## How to Verify

1. `hive-memory user create alice` prints an API key.
2. Calling `memory_store` via HTTP with Alice's key stores an entity with `author: "alice-uuid"`.
3. Calling with a revoked key returns 401.
4. Calling with `CORTEX_AUTH_TOKEN` still works when no users exist (backward compat).
5. `hive-memory user list` shows all created users.

## Risks

| Risk | Mitigation |
|------|------------|
| Schema migration breaks existing DBs | Use `ALTER TABLE` pattern from `schema.ts` (try/catch on existing columns) |
| API key leaked gives full access | Docs warn about key handling; revoke command available |
| Breaking change for existing single-token users | Backward compat: single-token still works if no users exist |
