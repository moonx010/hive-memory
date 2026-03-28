export type CDCEventType = "insert" | "update" | "delete";

export interface CDCEvent {
  type: CDCEventType;
  entityId: string;
  entityType: string;
  source: string;
  timestamp: string;
  data?: Record<string, unknown>;
}

export type CDCHandler = (event: CDCEvent) => Promise<void>;

/**
 * CDC Event Bus — allows components to subscribe to entity changes.
 * Used for: real-time enrichment, webhook notifications, search index updates.
 */
export class CDCEventBus {
  private handlers = new Map<string, CDCHandler[]>();

  /** Subscribe to all events or specific entity types */
  on(eventType: CDCEventType | "*", handler: CDCHandler): void {
    const key = eventType;
    if (!this.handlers.has(key)) this.handlers.set(key, []);
    this.handlers.get(key)!.push(handler);
  }

  /** Emit an event to all subscribers */
  async emit(event: CDCEvent): Promise<void> {
    const handlers = [
      ...(this.handlers.get(event.type) ?? []),
      ...(this.handlers.get("*") ?? []),
    ];
    await Promise.allSettled(handlers.map(h => h(event)));
  }

  /** Get subscriber count */
  get subscriberCount(): number {
    let count = 0;
    for (const handlers of this.handlers.values()) count += handlers.length;
    return count;
  }
}

// Singleton
let _eventBus: CDCEventBus | null = null;
export function getCDCEventBus(): CDCEventBus {
  if (!_eventBus) _eventBus = new CDCEventBus();
  return _eventBus;
}
