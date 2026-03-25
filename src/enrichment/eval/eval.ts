import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { ClassifyProvider } from "../providers/classify.js";
import type { Entity, EnrichmentContext } from "../types.js";

interface EvalSample {
  id: string;
  entityContent: string;
  entityType: string;
  attributes?: Record<string, unknown>;
  expectedTags: string[];
  expectedDomain: string | null;
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const datasetPath = join(__dirname, "eval-dataset.json");
const raw = readFileSync(datasetPath, "utf-8");
const samples: EvalSample[] = JSON.parse(raw);

function buildEntity(sample: EvalSample): Entity {
  return {
    id: sample.id,
    entityType: sample.entityType as Entity["entityType"],
    namespace: "local",
    content: sample.entityContent,
    tags: [],
    keywords: [],
    attributes: sample.attributes ?? {},
    source: { system: "eval" },
    visibility: "personal",
    domain: "conversations",
    confidence: "inferred",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    status: "active",
  };
}

// Minimal no-op context — ClassifyProvider does not use ctx
const ctx = {
  db: null as unknown as EnrichmentContext["db"],
  findRelated: () => [],
} satisfies EnrichmentContext;

async function main() {
  const provider = new ClassifyProvider();

  let tagTruePos = 0;
  let tagFalsePos = 0;
  let tagFalseNeg = 0;

  let domainCorrect = 0;
  let domainTotal = 0;

  const rows: string[] = [];

  for (const sample of samples) {
    const entity = buildEntity(sample);

    if (!provider.shouldEnrich(entity)) {
      // shouldEnrich false → treat as no tags, no domain
      const predictedTags: string[] = [];
      const predictedDomain: string | null = null;

      for (const tag of predictedTags) {
        if (sample.expectedTags.includes(tag)) tagTruePos++;
        else tagFalsePos++;
      }
      for (const tag of sample.expectedTags) {
        if (!predictedTags.includes(tag)) tagFalseNeg++;
      }

      if (sample.expectedDomain !== null) {
        domainTotal++;
        if (predictedDomain === sample.expectedDomain) domainCorrect++;
      }

      rows.push(formatRow(sample.id, sample.expectedTags, predictedTags, sample.expectedDomain, predictedDomain, false));
      continue;
    }

    const result = await provider.enrich(entity, ctx);
    const predictedTags = result.tags ?? [];
    const predictedDomain = (result.attributes?.domain as string | undefined) ?? null;

    for (const tag of predictedTags) {
      if (sample.expectedTags.includes(tag)) tagTruePos++;
      else tagFalsePos++;
    }
    for (const tag of sample.expectedTags) {
      if (!predictedTags.includes(tag)) tagFalseNeg++;
    }

    if (sample.expectedDomain !== null) {
      domainTotal++;
      if (predictedDomain === sample.expectedDomain) domainCorrect++;
    }

    rows.push(formatRow(sample.id, sample.expectedTags, predictedTags, sample.expectedDomain, predictedDomain, true));
  }

  const precision = tagTruePos + tagFalsePos === 0 ? 1 : tagTruePos / (tagTruePos + tagFalsePos);
  const recall = tagTruePos + tagFalseNeg === 0 ? 1 : tagTruePos / (tagTruePos + tagFalseNeg);
  const f1 = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);
  const domainAcc = domainTotal === 0 ? 1 : domainCorrect / domainTotal;

  // Print table
  const header = `${"ID".padEnd(12)} ${"Expected Tags".padEnd(26)} ${"Predicted Tags".padEnd(26)} ${"Exp Domain".padEnd(12)} ${"Pred Domain".padEnd(12)} OK`;
  const divider = "-".repeat(header.length);
  console.log("\n=== Enrichment Eval Results ===\n");
  console.log(header);
  console.log(divider);
  for (const row of rows) console.log(row);
  console.log(divider);
  console.log(`\nSamples: ${samples.length}`);
  console.log(`Tag precision : ${(precision * 100).toFixed(1)}%  (TP=${tagTruePos}, FP=${tagFalsePos})`);
  console.log(`Tag recall    : ${(recall * 100).toFixed(1)}%  (TP=${tagTruePos}, FN=${tagFalseNeg})`);
  console.log(`Tag F1        : ${(f1 * 100).toFixed(1)}%`);
  console.log(`Domain acc    : ${(domainAcc * 100).toFixed(1)}%  (${domainCorrect}/${domainTotal})`);

  if (precision < 0.8) {
    console.error(`\nFAIL: Tag precision ${(precision * 100).toFixed(1)}% is below required 80%`);
    process.exit(1);
  }

  console.log(`\nPASS: Tag precision >= 80%`);
}

function formatRow(
  id: string,
  expectedTags: string[],
  predictedTags: string[],
  expectedDomain: string | null,
  predictedDomain: string | null,
  _enriched: boolean,
): string {
  const expTags = expectedTags.join(",") || "(none)";
  const predTags = predictedTags.join(",") || "(none)";
  const expDom = expectedDomain ?? "(none)";
  const predDom = predictedDomain ?? "(none)";

  const tagMatch =
    expectedTags.every((t) => predictedTags.includes(t)) &&
    predictedTags.every((t) => expectedTags.includes(t));
  const domainMatch = expectedDomain === null || predictedDomain === expectedDomain;
  const ok = tagMatch && domainMatch ? "✓" : "✗";

  return `${id.padEnd(12)} ${expTags.padEnd(26)} ${predTags.padEnd(26)} ${expDom.padEnd(12)} ${predDom.padEnd(12)} ${ok}`;
}

main().catch((err) => {
  console.error("Eval failed:", err);
  process.exit(1);
});
