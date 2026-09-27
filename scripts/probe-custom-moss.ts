import { loadEnvFile } from "node:process";
import { MossClient, type DocumentInfo } from "@moss-dev/moss";
import { pipeline } from "@huggingface/transformers";

try {
  loadEnvFile();
} catch {
  // .env is optional; the environment may already provide the variables.
}

const PROJECT_ID = process.env.MOSS_PROJECT_ID?.trim() ?? "";
const PROJECT_KEY = process.env.MOSS_PROJECT_KEY?.trim() ?? "";

const EMBEDDING_MODEL_ID = "Xenova/all-MiniLM-L6-v2";
const EMBEDDING_DIMENSION = 384;

const PLACEHOLDERS = new Set(["", "...", "xxx", "your-project-id", "your-project-key"]);
const hasCredentials =
  Boolean(PROJECT_ID) &&
  Boolean(PROJECT_KEY) &&
  !PLACEHOLDERS.has(PROJECT_ID) &&
  !PLACEHOLDERS.has(PROJECT_KEY);

class ProbeError extends Error {
  constructor(public readonly step: string, message: string) {
    super(message);
    this.name = "ProbeError";
  }
}

function assert(step: string, condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new ProbeError(step, message);
  }
}

function isFiniteVector(value: unknown): value is number[] {
  return (
    Array.isArray(value) &&
    value.length === EMBEDDING_DIMENSION &&
    value.every((n) => typeof n === "number" && Number.isFinite(n))
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main(): Promise<void> {
  assert("credentials", hasCredentials, "MOSS_PROJECT_ID / MOSS_PROJECT_KEY are missing or placeholder in .env.");
  console.log("[1] Moss credentials present.");

  let indexName = `verify-custom-${Date.now()}`;
  let moss: MossClient | null = null;
  let indexCreated = false;

  try {
    console.log(`[2] Creating feature-extraction pipeline: ${EMBEDDING_MODEL_ID}`);
    const extractor = await pipeline("feature-extraction", EMBEDDING_MODEL_ID);
    console.log("[2] Pipeline ready.");

    const testDocs = [
      { id: "pump-301", text: "Cooling water pump P-204 tripped on high bearing temperature. Vibration readings were elevated above alarm threshold for 40 minutes before the trip. Probable root cause: bearing lubrication breakdown." },
      { id: "pump-302", text: "Centrifugal pump bearing failure after prolonged operation without lubrication maintenance. Seals degraded and allowed coolant ingress into the bearing housing." },
      { id: "pump-303", text: "STANDARD OPERATING PROCEDURE: monthly bearing lubrication and vibration check for cooling water pumps. Record readings and replace lubricant when degraded." },
    ];

    console.log("[3] Embedding test documents.");
    const output = (await extractor(
      testDocs.map((doc) => doc.text),
      { pooling: "mean", normalize: true }
    )) as { tolist: () => unknown };

    const vectors = output.tolist() as unknown;
    assert("embedding-dims", Array.isArray(vectors), "Embedding output is not an array.");
    assert(
      "embedding-dims",
      vectors.length === 3 && vectors.every((vector) => isFiniteVector(vector)),
      `Expected 3 embedding vectors of ${EMBEDDING_DIMENSION} numeric dimensions, got ${vectors.length}.`
    );
    console.log(`[3] Embeddings OK: 3 vectors x ${EMBEDDING_DIMENSION} dimensions.`);

    const documents: DocumentInfo[] = testDocs.map((doc, index) => ({
      id: doc.id,
      text: doc.text,
      metadata: { type: "probe-test" },
      embedding: (vectors as number[][])[index],
    }));

    moss = new MossClient(PROJECT_ID, PROJECT_KEY);
    indexName = `verify-custom-${Date.now()}`;

    console.log(`[4] Creating throwaway Moss index "${indexName}" with modelId "custom".`);
    const created = await moss.createIndex(indexName, documents, { modelId: "custom" });
    assert("create-index", created && created.docCount === 3, `createIndex returned docCount=${created?.docCount}, expected 3.`);
    indexCreated = true;
    console.log(`[4] createIndex returned jobId=${created.jobId}, docCount=${created.docCount}.`);

    console.log("[5] Waiting for index to reach Ready.");
    let info = await moss.getIndex(indexName);
    const deadline = Date.now() + 120_000;
    while (info.status !== "Ready" && Date.now() < deadline) {
      await sleep(2000);
      info = await moss.getIndex(indexName);
    }
    assert("index-ready", info.status === "Ready", `Index did not reach Ready within 120s; status=${info.status}.`);

    console.log("[6] Verifying getIndex report.");
    assert("index-model", info.model?.id === "custom", `model.id=${info.model?.id}, expected "custom".`);
    assert("index-doccount", info.docCount === 3, `docCount=${info.docCount}, expected 3.`);
    console.log(`[6] getIndex: name=${info.name} status=${info.status} model.id=${info.model.id} docCount=${info.docCount}`);

    console.log("[7] loadIndex() on the custom index.");
    const loadedName = await moss.loadIndex(indexName);
    assert("load-index", loadedName === indexName, `loadIndex returned "${loadedName}", expected "${indexName}".`);

    console.log("[8] Embedding the test query.");
    const queryText = "why does cooling water pump P-204 overheat and trip?";
    const queryOutput = (await extractor(queryText, {
      pooling: "mean",
      normalize: true,
    })) as { tolist: () => unknown };
    const queryVectors = queryOutput.tolist() as unknown;
    assert("query-embedding", Array.isArray(queryVectors) && queryVectors.length === 1, "Query embedding output must contain exactly one vector.");
    const queryEmbedding = (queryVectors as number[][])[0];
    assert("query-embedding-dims", isFiniteVector(queryEmbedding), `Query embedding must be ${EMBEDDING_DIMENSION} numeric dimensions.`);

    console.log("[9] Querying Moss with the caller-supplied query embedding.");
    const result = await moss.query(indexName, queryText, {
      topK: 3,
      embedding: queryEmbedding,
    });

    assert("query-result", result && Array.isArray(result.docs), "query() did not return a docs array.");
    assert("query-docs", result.docs.length >= 1, "query() returned zero documents.");
    assert(
      "query-scores",
      result.docs.every((doc) => typeof doc.score === "number" && Number.isFinite(doc.score)),
      "query() returned a document without a numeric score."
    );
    assert(
      "query-latency",
      typeof result.timeTakenInMs === "number" && Number.isFinite(result.timeTakenInMs),
      `timeTakenInMs must be numeric, got ${String(result.timeTakenInMs)}.`
    );

    console.log("[10] Query results:");
    for (const doc of result.docs) {
      console.log(`      doc id=${doc.id} score=${doc.score.toFixed(4)}`);
    }
    console.log(`      timeTakenInMs=${result.timeTakenInMs}`);

    console.log("[11] Deleting throwaway index.");
    const deleted = await moss.deleteIndex(indexName);
    assert("delete-index", deleted === true, "deleteIndex did not return true.");
    indexCreated = false;
    console.log("[11] Throwaway index deleted.");

    console.log("[12] Closing Moss client.");
    await moss.close();
    moss = null;

    console.log("");
    console.log("CUSTOM_MOSS_PROBE_PASS");
    console.log(`  index         : ${info.name}`);
    console.log(`  model.id      : ${info.model.id}`);
    console.log(`  docCount      : ${info.docCount}`);
    console.log(`  embedding dim : ${EMBEDDING_DIMENSION}`);
    console.log(`  returned docs : ${result.docs.map((doc) => doc.id).join(", ")}`);
    console.log(`  scores        : ${result.docs.map((doc) => doc.score.toFixed(4)).join(", ")}`);
    console.log(`  timeTakenInMs : ${result.timeTakenInMs}`);
  } catch (error) {
    const step = error instanceof ProbeError ? error.step : "unknown";
    const message = error instanceof Error ? error.message : String(error);
    if (indexCreated && moss && indexName) {
      try {
        await moss.deleteIndex(indexName);
        indexCreated = false;
      } catch {
        // Best-effort cleanup; the throwaway index may not have been created.
      }
    }
    if (moss) {
      try {
        await moss.close();
      } catch {
        // Best-effort cleanup.
      }
    }
    console.error(`FAIL at step [${step}]: ${message}`);
    process.exitCode = 1;
  }
}

main();