# Large-Scale Data Pipeline — Design

## Slack Import Design

### Input format (Slack Enterprise Grid export)
```
export-dir/
  users.json        — array of user objects
  channels.json     — array of channel objects
  {channel-name}/   — one directory per channel
    YYYY-MM-DD.json — messages per day
```

### Processing
1. Parse `users.json` → create `person` entities (skip bots, deleted users)
2. Parse `channels.json` → get channel list
3. For each channel directory: read day files, filter significant messages (len > 20, type=message, no subtype), batch insert via SQLite transaction
4. Decision messages (matching DECISION_PATTERNS) get entityType=decision

### Performance
- SQLite WAL mode (already configured)
- Per-channel batch transactions
- No API calls (pure filesystem reads)

## Lifecycle Design

### Tiers
- **Hot**: updated within `hotDays` (default: 30d) — active, full-text searchable
- **Warm**: updated between `hotDays` and `warmDays` (default: 30-365d) — active, searchable
- **Cold/Archived**: updated after `warmDays` — status=archived, excluded from default searches

### Preservation rules
- `entity_type IN ('decision', 'task')` — never archived
- `attributes."high-signal" IS NOT NULL` — never archived

## DB Interface Design

`IHiveDatabase` in `src/pipeline/db-interface.ts` defines the minimal contract:
- Entity CRUD (insertEntity, updateEntity, getEntity, deleteEntity)
- Search (searchEntities, listEntities, countEntities)
- Synapse (upsertSynapse, getSynapsesByEntry)
- Convenience (upsertEntity)
- Lifecycle (close)

No circular imports: interface uses only `src/types.ts`, not `src/db/database.ts`.
