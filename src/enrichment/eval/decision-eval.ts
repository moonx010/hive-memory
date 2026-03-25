import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { DecisionExtractorProvider } from "../providers/decision-extractor.js";
import type { Entity, EnrichmentContext } from "../types.js";

interface EvalSample {
  id: string;
  entityContent: string;
  entityType: string;
  attributes?: Record<string, unknown>;
  expectedSignalsFound: boolean;
  expectedDecisions: number;
  expectedActions: number;
  notes: string;
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const datasetPath = join(__dirname, "decision-eval-dataset.json");
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

// Minimal no-op context — DecisionExtractorProvider.extractWithRules does not use ctx
const _ctx = {
  db: null as unknown as EnrichmentContext["db"],
  findRelated: () => [],
} satisfies EnrichmentContext;

function main() {
  const provider = new DecisionExtractorProvider();

  // Signal detection metrics
  let signalTP = 0; // shouldEnrich=true AND expectedSignalsFound=true
  let signalFP = 0; // shouldEnrich=true AND expectedSignalsFound=false
  let signalFN = 0; // shouldEnrich=false AND expectedSignalsFound=true

  // Recall metrics (only for signal-positive samples)
  let decisionExpectedTotal = 0;
  let decisionMatchedTotal = 0;
  let actionExpectedTotal = 0;
  let actionMatchedTotal = 0;

  const rows: string[] = [];

  for (const sample of samples) {
    const entity = buildEntity(sample);
    const enriched = provider.shouldEnrich(entity);

    if (enriched && sample.expectedSignalsFound) {
      signalTP++;
    } else if (enriched && !sample.expectedSignalsFound) {
      signalFP++;
    } else if (!enriched && sample.expectedSignalsFound) {
      signalFN++;
    }

    let extractedDecisions = 0;
    let extractedActions = 0;

    if (sample.expectedSignalsFound) {
      const { decisions, actions } = provider.extractWithRules(
        sample.entityContent,
      );
      extractedDecisions = decisions.length;
      extractedActions = actions.length;

      decisionExpectedTotal += sample.expectedDecisions;
      decisionMatchedTotal += Math.min(
        extractedDecisions,
        sample.expectedDecisions,
      );

      actionExpectedTotal += sample.expectedActions;
      actionMatchedTotal += Math.min(extractedActions, sample.expectedActions);
    }

    rows.push(
      formatRow(
        sample.id,
        sample.expectedSignalsFound,
        enriched,
        sample.expectedDecisions,
        extractedDecisions,
        sample.expectedActions,
        extractedActions,
      ),
    );
  }

  const signalPrecision =
    signalTP + signalFP === 0 ? 1 : signalTP / (signalTP + signalFP);
  const decisionRecall =
    decisionExpectedTotal === 0
      ? 1
      : decisionMatchedTotal / decisionExpectedTotal;
  const actionRecall =
    actionExpectedTotal === 0 ? 1 : actionMatchedTotal / actionExpectedTotal;

  // Print table
  const header = `${"ID".padEnd(10)} ${"ExpSig".padEnd(7)} ${"PredSig".padEnd(8)} ${"ExpDec".padEnd(7)} ${"ExtDec".padEnd(7)} ${"ExpAct".padEnd(7)} ${"ExtAct".padEnd(7)} ${"Notes".padEnd(20)}`;
  const divider = "-".repeat(header.length);
  console.log("\n=== Decision & Action Extraction Eval Results ===\n");
  console.log(header);
  console.log(divider);
  for (const row of rows) console.log(row);
  console.log(divider);
  console.log(`\nSamples: ${samples.length}`);
  console.log(
    `Signal precision : ${(signalPrecision * 100).toFixed(1)}%  (TP=${signalTP}, FP=${signalFP}, FN=${signalFN})`,
  );
  console.log(
    `Decision recall  : ${(decisionRecall * 100).toFixed(1)}%  (matched=${decisionMatchedTotal}/${decisionExpectedTotal})`,
  );
  console.log(
    `Action recall    : ${(actionRecall * 100).toFixed(1)}%  (matched=${actionMatchedTotal}/${actionExpectedTotal})`,
  );

  if (signalPrecision < 0.75) {
    console.error(
      `\nFAIL: Signal precision ${(signalPrecision * 100).toFixed(1)}% is below required 75%`,
    );
    process.exit(1);
  }

  console.log(`\nPASS: Signal precision >= 75%`);
}

function formatRow(
  id: string,
  expectedSignal: boolean,
  predictedSignal: boolean,
  expectedDecisions: number,
  extractedDecisions: number,
  expectedActions: number,
  extractedActions: number,
): string {
  const expSig = expectedSignal ? "true" : "false";
  const predSig = predictedSignal ? "true" : "false";
  const signalOk = expectedSignal === predictedSignal ? "✓" : "✗";

  return (
    `${id.padEnd(10)} ${expSig.padEnd(7)} ${predSig.padEnd(8)} ` +
    `${String(expectedDecisions).padEnd(7)} ${String(extractedDecisions).padEnd(7)} ` +
    `${String(expectedActions).padEnd(7)} ${String(extractedActions).padEnd(7)} ${signalOk}`
  );
}

main();
