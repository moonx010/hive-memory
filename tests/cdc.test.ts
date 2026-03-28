import { describe, it, expect, beforeEach } from "vitest";
import { CDCEventBus, getCDCEventBus } from "../src/pipeline/cdc.js";
import type { CDCEvent } from "../src/pipeline/cdc.js";

function makeEvent(overrides: Partial<CDCEvent> = {}): CDCEvent {
  return {
    type: "insert",
    entityId: "test-id",
    entityType: "memory",
    source: "test",
    timestamp: new Date().toISOString(),
    ...overrides,
  };
}

describe("CDCEventBus", () => {
  let bus: CDCEventBus;

  beforeEach(() => {
    bus = new CDCEventBus();
  });

  it("subscribe and emit — handler is called with event", async () => {
    const received: CDCEvent[] = [];
    bus.on("insert", async (event) => { received.push(event); });

    const event = makeEvent({ type: "insert" });
    await bus.emit(event);

    expect(received).toHaveLength(1);
    expect(received[0].entityId).toBe("test-id");
  });

  it("wildcard subscriber receives all event types", async () => {
    const received: CDCEvent[] = [];
    bus.on("*", async (event) => { received.push(event); });

    await bus.emit(makeEvent({ type: "insert" }));
    await bus.emit(makeEvent({ type: "update" }));
    await bus.emit(makeEvent({ type: "delete" }));

    expect(received).toHaveLength(3);
    expect(received.map(e => e.type)).toEqual(["insert", "update", "delete"]);
  });

  it("emit with no subscribers does not crash", async () => {
    await expect(bus.emit(makeEvent())).resolves.not.toThrow();
  });

  it("multiple handlers for same event type are all called", async () => {
    const calls: number[] = [];
    bus.on("insert", async () => { calls.push(1); });
    bus.on("insert", async () => { calls.push(2); });
    bus.on("insert", async () => { calls.push(3); });

    await bus.emit(makeEvent({ type: "insert" }));

    expect(calls).toEqual([1, 2, 3]);
  });

  it("Promise.allSettled does not throw when a handler errors", async () => {
    bus.on("insert", async () => { throw new Error("handler failure"); });
    bus.on("insert", async (event) => { event.entityId; /* no-op */ });

    await expect(bus.emit(makeEvent())).resolves.not.toThrow();
  });

  it("subscriberCount reflects registered handlers", () => {
    expect(bus.subscriberCount).toBe(0);
    bus.on("insert", async () => {});
    bus.on("update", async () => {});
    bus.on("*", async () => {});
    expect(bus.subscriberCount).toBe(3);
  });

  it("specific handler is not called for other event types", async () => {
    const received: CDCEvent[] = [];
    bus.on("insert", async (event) => { received.push(event); });

    await bus.emit(makeEvent({ type: "update" }));
    await bus.emit(makeEvent({ type: "delete" }));

    expect(received).toHaveLength(0);
  });
});

describe("getCDCEventBus singleton", () => {
  it("returns the same instance on multiple calls", () => {
    const a = getCDCEventBus();
    const b = getCDCEventBus();
    expect(a).toBe(b);
  });
});
