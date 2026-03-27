# Hybrid Search + RAG — Proposal

## Problem
Current search uses FTS5 BM25 + spreading activation. Missing:
1. Semantic/vector similarity search (embedding-based)
2. RAG (Retrieval-Augmented Generation) context assembly

## Solution (reserved for hybrid-search agent)
This directory is reserved for the hybrid-search agent working on `src/search/*` and the `hybridSearch` method in `src/db/database.ts`.
