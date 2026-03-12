#!/usr/bin/env bash
# worker-inject.sh — Inject Hive Memory context before a Codex worker starts
#
# Usage: worker-inject.sh <project-id> "<task description>" [output-file]
#
# Calls `hive-memory inject` to recall relevant memories and append them
# to the worker's prompt file. Uses --no-embed for fast execution.

set -euo pipefail

PROJECT="${1:?Usage: worker-inject.sh <project-id> \"<task description>\" [output-file]}"
TASK_DESC="${2:?Usage: worker-inject.sh <project-id> \"<task description>\" [output-file]}"
OUTPUT="${3:-PROMPT.md}"

# Inject relevant memories (keyword-only for speed)
hive-memory inject \
  --project "$PROJECT" \
  --query "$TASK_DESC" \
  --output "$OUTPUT" \
  --limit 3 \
  --no-embed

echo "[worker-inject] Injected context for '$PROJECT' into $OUTPUT"
