# Proposal: Graph Connectivity + Schema Extensibility

## Problem

5-agent debate identified 3 critical gaps:

1. **Half the graph is disconnected** — Slack, GitHub, Notion connectors create entities but zero synapses. Calendar/Outlook/Recall create synapses. Knowledge from 3 of 6 sources is isolated.
2. **Cross-tenant synapse leak** — No org_id constraint on synapses table. Entity from org1 can link to entity from org2.
3. **Closed entity/axon types** — TypeScript unions prevent domain extension without code changes. Database is already open (TEXT), but compile-time validation blocks new domains.

## Consensus Decision (5 agents agreed)

Priority 1: Fix existing system (P1.1 security, P1.2 connectivity, P1.3 cleanup)
Priority 2: Build retrieval eval
Priority 3: Open types + domain schema registry
Priority 4: Deferred (regulated domain features)
