# Tasks: multi-user-access

**Phase:** A (first — blocks slack-bot-interactive and mcp-gateway)
**Estimated effort:** 3-4 days
**Dependencies:** None

## Day 1: Schema + Auth Module

- [ ] **TASK-AUTH-01**: Add `users` table to `src/db/schema.ts`
  - Add `CREATE TABLE IF NOT EXISTS users` with columns: `id`, `name`, `email`, `api_key_hash`, `role`, `created_at`, `status`
  - Add index on `api_key_hash` (unique lookups) and `status`
  - Use `ALTER TABLE` try/catch pattern for migration (same as `content_hash` migration at line 163)
  - Test: fresh DB has `users` table; existing DB gets it via migration

- [ ] **TASK-AUTH-02**: Create `src/auth.ts` — user management functions
  - `generateApiKey()`: returns `{ plaintext: string, hash: string }` using `randomBytes(32)` + SHA-256
  - `hashApiKey(plaintext)`: returns SHA-256 hex digest
  - `createUser(db, name, email?)`: inserts user row, returns `{ user, plaintextKey }`
  - `verifyToken(db, token)`: hashes token, looks up in users table, returns `User | null`
  - `listUsers(db)`: returns all users (id, name, email, role, created_at, status)
  - `revokeUser(db, userId)`: sets `status = 'revoked'`
  - API key prefix: `hm_` followed by 64 hex chars
  - Test: create user → verify with correct key → verify with wrong key → revoke → verify fails

- [ ] **TASK-AUTH-03**: Add `User` type to `src/types.ts`
  - ```typescript
    interface User { id: string; name: string; email?: string; role: string; createdAt: string; status: string; }
    ```

## Day 2: HTTP Middleware + Entity Attribution

- [ ] **TASK-AUTH-04**: Update HTTP auth middleware in `src/index.ts`
  - Replace single-token check (lines 122-129) with `resolveAuth()` from `src/auth.ts`
  - Auth resolution order: (1) user table lookup, (2) `CORTEX_AUTH_TOKEN` fallback, (3) no-auth if neither configured
  - Pass resolved `userId` (or `undefined`) to tool handlers via request context
  - Test: user token → 200 with userId; `CORTEX_AUTH_TOKEN` → 200 without userId; bad token → 401; no auth configured → 200

- [ ] **TASK-AUTH-05**: Wire `userId` into entity attribution
  - Modify `registerTools` in `src/tools/index.ts` to accept an optional `userId` context
  - In `memory_store` handler (`src/tools/memory-tools.ts`): if `userId` is set, override `author` with userId
  - In `session_save` handler (`src/tools/session-tools.ts`): same behavior
  - Test: store memory with user auth → entity `author` is userId; store without auth → entity `author` is caller-provided

## Day 3: CLI Commands

- [ ] **TASK-AUTH-06**: Add `user` subcommand to CLI
  - Add `"user"` to `CLI_COMMANDS` set in `src/index.ts` (line 98)
  - Add `handleUserCli(store, args)` function in `src/index.ts` (follow `handleTeamCli` pattern at line 230)
  - Subcommands: `create <name> [--email <email>]`, `list`, `revoke <user-id>`
  - `create` output: prints user ID + plaintext API key with warning "save this — it won't be shown again"
  - `list` output: table format (ID, Name, Email, Status, Created)
  - `revoke` output: confirmation message
  - Test: `hive-memory user create alice` → key printed; `hive-memory user list` → alice shown; `hive-memory user revoke <id>` → status changes

## Day 4: Integration Testing + Docs

- [ ] **TASK-AUTH-07**: Write integration tests
  - Create `tests/auth.test.ts`
  - Test cases:
    - Create user, verify token, use token to store memory → entity has correct author
    - Revoke user, verify token fails
    - Backward compat: `CORTEX_AUTH_TOKEN` still works when no users exist
    - No auth configured → all requests pass (local dev mode)
  - Run with: `npm test -- tests/auth.test.ts`

- [ ] **TASK-AUTH-08**: Update `deploy/.env.example`
  - Add comment section for user management
  - Note that `CORTEX_AUTH_TOKEN` is optional when using per-user keys
  - Document `hive-memory user create` command
