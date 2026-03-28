export interface ConnectorManifest {
  id: string;
  name: string;
  description: string;
  version: string;
  author: string;
  entityTypes: string[];
  domains: string[];
  requiredEnvVars: string[];
  optionalEnvVars?: string[];
  icon?: string;
}

/**
 * Connector registry with discovery.
 * Lists both built-in and user-installed connectors.
 */
export class ConnectorMarketplace {
  private manifests = new Map<string, ConnectorManifest>();

  /** Register a connector's manifest */
  register(manifest: ConnectorManifest): void {
    this.manifests.set(manifest.id, manifest);
  }

  /** List all available connectors with their config status */
  list(): Array<ConnectorManifest & { configured: boolean }> {
    return [...this.manifests.values()].map(m => ({
      ...m,
      configured: m.requiredEnvVars.every(v => !!process.env[v]),
    }));
  }

  /** Get a connector's manifest */
  get(id: string): ConnectorManifest | undefined {
    return this.manifests.get(id);
  }
}

// Built-in connector manifests
export const BUILT_IN_CONNECTORS: ConnectorManifest[] = [
  {
    id: "github",
    name: "GitHub",
    description: "Syncs PRs, Issues, ADRs, and CODEOWNERS",
    version: "1.0.0",
    author: "hive-memory",
    entityTypes: ["document", "task", "decision", "person"],
    domains: ["code"],
    requiredEnvVars: ["GITHUB_TOKEN", "GITHUB_REPOS"],
  },
  {
    id: "slack",
    name: "Slack",
    description: "Syncs conversations, decisions, and members",
    version: "1.0.0",
    author: "hive-memory",
    entityTypes: ["conversation", "decision", "person"],
    domains: ["conversations"],
    requiredEnvVars: ["SLACK_TOKEN", "SLACK_CHANNELS"],
  },
  {
    id: "notion",
    name: "Notion",
    description: "Syncs pages, databases, and block content",
    version: "1.0.0",
    author: "hive-memory",
    entityTypes: ["document", "task"],
    domains: ["documents"],
    requiredEnvVars: ["NOTION_TOKEN"],
  },
  {
    id: "google-calendar",
    name: "Google Calendar",
    description: "Syncs events, meetings, and attendees",
    version: "1.0.0",
    author: "hive-memory",
    entityTypes: ["event", "meeting", "person"],
    domains: ["meetings"],
    requiredEnvVars: ["GOOGLE_CALENDAR_CREDENTIALS"],
  },
  {
    id: "outlook",
    name: "Outlook Calendar",
    description: "Syncs Outlook events and meetings",
    version: "1.0.0",
    author: "hive-memory",
    entityTypes: ["event", "meeting", "person"],
    domains: ["meetings"],
    requiredEnvVars: ["OUTLOOK_TOKEN"],
  },
];
