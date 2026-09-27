import { loadEnvFile } from "node:process";
import { MossClient, type DocumentInfo } from "@moss-dev/moss";
import { buildDocuments, disconnect as disconnectDb } from "./lib/documents";
import { embedText, EMBEDDING_DIMENSION } from "../lib/embedding";

try {
  loadEnvFile();
} catch {
  // .env is optional; the environment may already provide the variables.
}

// Hard safety guard: this script builds ONLY the custom-embedding index.
const FORBIDDEN_INDEX_NAME = "fieldos-knowledge";
const CUSTOM_INDEX_NAME =
  (process.env.MOSS_CUSTOM_INDEX_NAME ?? "fieldos-knowledge-custom").trim() ??
  "fieldos-knowledge-custom";

const PROJECT_ID = process.env.MOSS_PROJECT_ID?.trim() ?? "";
const PROJECT_KEY = process.env.MOSS_PROJECT_KEY?.trim() ?? "";

const PLACEHOLDERS = new Set(["", "...", "xxx", "your-project-id", "your-project-key"]);
const hasRealCredentials =
  Boolean(PROJECT_ID) &&
  Boolean(PROJECT_KEY) &&
  !PLACEHOLDERS.has(PROJECT_ID) &&
  !PLACEHOLDERS.has(PROJECT_KEY);

let moss: MossClient | null = null;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main(): Promise<void> {
  if (CUSTOM_INDEX_NAME === FORBIDDEN_INDEX_NAME || CUSTOM_INDEX_NAME.length === 0) {
    throw new Error(
      `Refusing to run against "${FORBIDDEN_INDEX_NAME}". This script builds ONLY the custom-embedding index "${CUSTOM_INDEX_NAME}".`
    );
  }

  console.log(`FieldOS → Moss custom-embedding index builder`);
  console.log(`▶ Index name: ${CUSTOM_INDEX_NAME}`);

  const documents = await buildDocuments();
  console.log(`▶ Documents read from PostgreSQL: ${documents.length}`);
  if (documents.length === 0) {
    throw new Error("No documents to index. Refusing to create an empty index.");
  }

  console.log(`▶ Embedding ${documents.length} documents (${EMBEDDING_DIMENSION}-dim)...`);
  const embeddedDocs: DocumentInfo[] = [];
  for (const doc of documents) {
    const embedding = await embedText(doc.text);
    if (embedding.length !== EMBEDDING_DIMENSION) {
      throw new Error(
        `Document "${doc.id}" produced a ${embedding.length}-dim embedding; expected ${EMBEDDING_DIMENSION}.`
      );
    }
    embeddedDocs.push({ ...doc, embedding });
  }
  console.log(`▶ Embeddings ready (all ${EMBEDDING_DIMENSION} dimensions).`);

  if (!hasRealCredentials) {
    console.log("");
    console.log("⚠️  Real Moss indexing is BLOCKED: MOSS_PROJECT_ID / MOSS_PROJECT_KEY");
    console.log("   are missing or still placeholders in .env.");
    console.log("No API calls were made.");
    return;
  }

  moss = new MossClient(PROJECT_ID, PROJECT_KEY);

  console.log("");
  console.log(`📡 Checking for existing "${CUSTOM_INDEX_NAME}"...`);
  const existingIndexes = await moss.listIndexes();
  const existingCustom = existingIndexes.find((index) => index.name === CUSTOM_INDEX_NAME);
  if (existingCustom) {
    console.log(`- "${CUSTOM_INDEX_NAME}" exists → deleting for a clean rebuild...`);
    await moss.deleteIndex(CUSTOM_INDEX_NAME);
  }

  const created = await moss.createIndex(CUSTOM_INDEX_NAME, embeddedDocs, {
    modelId: "custom",
  });
  console.log(
    `✅ Index created: "${CUSTOM_INDEX_NAME}" (job=${created.jobId}, docs=${created.docCount})`
  );

  let info = await moss.getIndex(CUSTOM_INDEX_NAME);
  const deadline = Date.now() + 120_000;
  while (info.status !== "Ready" && Date.now() < deadline) {
    await sleep(2000);
    info = await moss.getIndex(CUSTOM_INDEX_NAME);
  }

  if (info.name !== CUSTOM_INDEX_NAME) {
    throw new Error(`Index name mismatch: got "${info.name}", expected "${CUSTOM_INDEX_NAME}".`);
  }
  if (info.status !== "Ready") {
    throw new Error(`Index did not reach Ready within 120s; status=${info.status}.`);
  }
  if (info.model.id !== "custom") {
    throw new Error(`model.id=${info.model.id}, expected "custom".`);
  }
  if (info.docCount !== documents.length) {
    throw new Error(
      `docCount=${info.docCount}, expected ${documents.length} from PostgreSQL.`
    );
  }

  console.log("");
  console.log("🎯 Custom Moss index is ready.");
  console.log(`   name         : ${info.name}`);
  console.log(`   status       : ${info.status}`);
  console.log(`   model.id     : ${info.model.id}`);
  console.log(`   docCount     : ${info.docCount}`);
  console.log(`   embedding dim: ${EMBEDDING_DIMENSION}`);
  console.log(`   (model version: ${info.model.version ?? "n/a"})`);
}

main()
  .then(() => {
    process.exitCode = 0;
  })
  .catch((error: unknown) => {
    console.error("❌ Custom Moss indexing failed:");
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await disconnectDb();
    if (moss) {
      await moss.close();
    }
  });