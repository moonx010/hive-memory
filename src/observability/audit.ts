// Audit log for MCP tool calls — in-memory buffer + persistent DB storage

import type { HiveDatabase } from "../db/database.js";

export interface AuditEntry {
  timestamp: string;
  userId: string;
  action: string; // "search" | "read" | "write" | "admin"
  toolName: string;
  query?: string;
  entityId?: string;
  resultCount?: number;
}

const auditLog: AuditEntry[] = [];
const MAX_AUDIT_ENTRIES = 10000;

// Optional DB reference for persistent storage — set via initAuditDb()
let _auditDb: HiveDatabase | null = null;

/** Wire up the persistent DB backend for audit logging. */
export function initAuditDb(db: HiveDatabase): void {
  _auditDb = db;
}

export function logAudit(entry: Omit<AuditEntry, "timestamp">): void {
  const timestamp = new Date().toISOString();
  const full: AuditEntry = { ...entry, timestamp };

  // In-memory buffer (fast recent queries)
  auditLog.push(full);
  if (auditLog.length > MAX_AUDIT_ENTRIES) auditLog.shift();

  // Persistent DB write (compliance / long-term)
  if (_auditDb) {
    try {
      _auditDb.insertAuditEntry({
        timestamp,
        userId: entry.userId || undefined,
        action: entry.action,
        toolName: entry.toolName || undefined,
        resourceId: entry.entityId || undefined,
        query: entry.query || undefined,
        resultCount: entry.resultCount,
      });
    } catch {
      // Never let audit failures crash the main path
    }
  }
}

export function getAuditLog(limit?: number): AuditEntry[] {
  return auditLog.slice(-(limit ?? 100));
}

/** Classify tool name into an action category. */
export function classifyAction(toolName: string): string {
  if (
    toolName === "memory_store" ||
    toolName === "memory_link" ||
    toolName === "session_save" ||
    toolName === "project_register" ||
    toolName === "meeting_process"
  ) {
    return "write";
  }
  if (
    toolName === "user_manage" ||
    toolName === "memory_audit_log"
  ) {
    return "admin";
  }
  if (
    toolName === "memory_recall" ||
    toolName === "memory_traverse" ||
    toolName === "memory_grep" ||
    toolName === "project_search"
  ) {
    return "search";
  }
  return "read";
}
