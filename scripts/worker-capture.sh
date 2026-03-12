#!/usr/bin/env bash
# worker-capture.sh — Capture a Codex worker's result into Hive Memory
#
# Usage: worker-capture.sh <project-id> <worker-id> <task-id> [work-dir]
#
# After a worker completes, extracts the latest commit message and stores
# it as a learning memory tagged with the task ID.

set -euo pipefail

PROJECT="${1:?Usage: worker-capture.sh <project-id> <worker-id> <task-id> [work-dir]}"
WORKER_ID="${2:?Usage: worker-capture.sh <project-id> <worker-id> <task-id> [work-dir]}"
TASK_ID="${3:?Usage: worker-capture.sh <project-id> <worker-id> <task-id> [work-dir]}"
WORK_DIR="${4:-.}"

cd "$WORK_DIR"

# Check if there are any new commits
COMMIT_COUNT=$(git log --oneline main..HEAD 2>/dev/null | wc -l | tr -d ' ')

if [ "$COMMIT_COUNT" -eq 0 ]; then
  # No commits — store a note
  hive-memory store \
    --project "$PROJECT" \
    --category note \
    --agent "codex-w${WORKER_ID}" \
    --no-embed \
    "Task ${TASK_ID}: worker produced no changes"
  echo "[worker-capture] No commits found for task $TASK_ID"
else
  # Extract commit summary
  SUMMARY=$(git log --oneline main..HEAD | head -5)
  DIFF_STAT=$(git diff --stat main..HEAD 2>/dev/null | tail -1)

  hive-memory store \
    --project "$PROJECT" \
    --category learning \
    --agent "codex-w${WORKER_ID}" \
    --no-embed \
    "Task ${TASK_ID}: ${SUMMARY} (${DIFF_STAT})"
  echo "[worker-capture] Captured ${COMMIT_COUNT} commit(s) for task $TASK_ID"
fi
