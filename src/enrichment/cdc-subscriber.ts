import { getCDCEventBus } from "../pipeline/cdc.js";
import type { EnrichmentEngine } from "./engine.js";

/**
 * Register CDC subscriber that auto-enriches new entities.
 * Call this once after the EnrichmentEngine is initialized.
 */
export function registerCDCEnrichmentSubscriber(engine: EnrichmentEngine): void {
  const bus = getCDCEventBus();
  bus.on("insert", async (event) => {
    if (process.env.CORTEX_ENRICHMENT === "off") return;
    // Auto-enrich new entities from connectors
    if (event.source !== "agent") {
      try {
        await engine.enrichEntity(event.entityId);
      } catch { /* non-critical */ }
    }
  });
}
