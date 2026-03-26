#!/bin/bash
# Source environment
set -a; source /opt/hive-memory/.env; set +a
cd /opt/hive-memory

# Slack sync (every 30 min)
node dist/index.js sync slack 2>&1 | logger -t cortex-sync

# GitHub sync (every run)
node dist/index.js sync github 2>&1 | logger -t cortex-sync

# Enrichment
CORTEX_ENRICHMENT=rule node dist/index.js enrich --limit 200 2>&1 | logger -t cortex-enrich
