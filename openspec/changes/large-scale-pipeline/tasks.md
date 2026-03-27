# Large-Scale Data Pipeline — Tasks

## Completed

- [x] Create `src/pipeline/slack-import.ts` — bulk Slack Enterprise Grid import
- [x] Create `src/pipeline/lifecycle.ts` — DataLifecycleManager with hot/warm/cold tiers
- [x] Create `src/pipeline/db-interface.ts` — IHiveDatabase abstraction interface
- [x] Add `rawDb` getter to HiveDatabase for transaction access
- [x] Add `import-slack <dir>` CLI command
- [x] Add `lifecycle [run|stats]` CLI commands
- [x] Create `tests/slack-import.test.ts`
- [x] Create `tests/data-lifecycle.test.ts`
- [x] Create openspec docs

## Future Work

- [ ] Streaming import for very large exports (> 1M messages)
- [ ] Progress reporting / checkpoint resume for long imports
- [ ] PostgreSQL adapter implementing IHiveDatabase
- [ ] Configurable lifecycle policies per entity type
