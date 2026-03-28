# Fresh-Eyes Review Remediation Plan

**Date**: 2026-03-29
**Status**: Partially complete

## Completed

### Rate limiter memory leak (Issue 3) -- DONE
- File: `src/observability/rate-limit.ts`
- Added periodic sweep (every 5 min), hard cap (10k entries), DoS protection
- Timer is unref'd so it won't keep the process alive

### CI enhancement (Issue 2) -- DONE
- File: `.github/workflows/ci.yml`
- Added npm cache, concurrency group (cancel stale runs), npm audit step
- Note: CI already existed -- the fresh-eyes review was incorrect

## Remaining Work

### Step 1: SSO Runtime Guard (30 min)
**File**: `src/auth/sso.ts`
**What**: Add a guard to `provisionSSOUser` that throws if no real SSO provider is configured.
Currently the function will happily auto-provision users even though no OIDC/SAML validation exists.
**Acceptance criteria**:
- Calling `provisionSSOUser` when `loadSSOConfig().provider === "none"` throws an error
- Error message clearly states SSO is not implemented
- Existing tests pass

### Step 2: Rename ConnectorMarketplace to ConnectorRegistry (1 hr)
**Files**:
- `src/connectors/marketplace.ts` -> rename to `src/connectors/registry.ts`
- `src/cli.ts` -- update import
- `src/tools/connector-tools.ts` -- update import and tool name reference
**Acceptance criteria**:
- Class is `ConnectorRegistry`, file is `registry.ts`
- Tool name stays `connector_marketplace` (breaking change if renamed -- keep for API compat)
- All imports compile, tests pass

### Step 3: database.ts Decomposition (4-6 hrs) -- SEPARATE PLAN
**See**: `.omc/plans/database-decomposition.md` (to be created)
**Approach**: Facade pattern -- extract ops functions, HiveDatabase delegates
**Acceptance criteria**:
- database.ts under 300 lines
- All 512 tests pass without modification
- No public API changes

### Step 4: Backup Documentation (15 min)
**File**: `README.md`
**What**: Add backup section with cron example
**Acceptance criteria**:
- README has a "Backup" section with cron one-liner
- Mentions backup rotation strategy

## Open Questions
See `.omc/plans/open-questions.md`
