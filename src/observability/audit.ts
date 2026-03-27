// In-memory audit log for MCP tool calls

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

export function logAudit(entry: Omit<AuditEntry, "timestamp">): void {
  auditLog.push({ ...entry, timestamp: new Date().toISOString() });
  if (auditLog.length > MAX_AUDIT_ENTRIES) auditLog.shift();
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
