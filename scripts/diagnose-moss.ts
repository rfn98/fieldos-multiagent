import { MossClient } from "@moss-dev/moss";
import { loadEnvFile } from "node:process";

try {
  loadEnvFile();
} catch {
  // .env is optional; the environment may already provide the variables.
}

const PROJECT_ID = process.env.MOSS_PROJECT_ID ?? "";
const PROJECT_KEY = process.env.MOSS_PROJECT_KEY ?? "";
const INDEX_NAME = process.env.MOSS_INDEX_NAME ?? "fieldos-knowledge";
const JOB_ID = "7c8b57c1-b53a-4231-85f9-7c17a3a4086e";

let moss: MossClient | null = null;

function printIndexInfo(kind: string, index: {
  name: string;
  status: string;
  docCount: number;
  version?: string;
  createdAt?: string;
  updatedAt?: string;
  model: { id: string; version?: string };
}): void {
  console.log(`[${kind}] name          : ${index.name}`);
  console.log(`[${kind}] status        : ${index.status}`);
  console.log(`[${kind}] docCount      : ${index.docCount}`);
  console.log(`[${kind}] model.id      : ${index.model.id}`);
  console.log(`[${kind}] model.version : ${index.model.version ?? "(not exposed)"}`);
  console.log(`[${kind}] index.version : ${index.version ?? "(not exposed)"}`);
  console.log(`[${kind}] createdAt     : ${index.createdAt ?? "(not exposed)"}`);
  console.log(`[${kind}] updatedAt     : ${index.updatedAt ?? "(not exposed)"}`);
}

async function main(): Promise<void> {
  moss = new MossClient(PROJECT_ID, PROJECT_KEY);

  console.log("== STEP 1: listIndexes() ==");
  let indexes: Awaited<ReturnType<typeof moss.listIndexes>> = [];
  try {
    indexes = await moss.listIndexes();
    console.log(`Indexes found: ${indexes.length}`);
    for (const index of indexes) {
      printIndexInfo("list", index);
      console.log("[list] -----------------------------");
    }
  } catch (error) {
    console.error("[STEP 1] listIndexes() FAILED:", error);
  }

  console.log("");
  console.log("== STEP 2: getIndex(\"" + INDEX_NAME + "\") (exists check) ==");
  const exists = indexes.some((index) => index.name === INDEX_NAME);
  if (exists) {
    try {
      const info = await moss.getIndex(INDEX_NAME);
      printIndexInfo("getIndex", info);
    } catch (error) {
      console.error("[STEP 2] getIndex() FAILED:", error);
    }
  } else {
    console.log(`"${INDEX_NAME}" was NOT returned by listIndexes(); skipping getIndex.`);
  }

  console.log("");
  console.log("== STEP 3: getJobStatus(\"" + JOB_ID + "\") ==");
  try {
    const job = await moss.getJobStatus(JOB_ID);
    console.log(`[job] jobId        : ${job.jobId}`);
    console.log(`[job] status       : ${job.status}`);
    console.log(`[job] progress     : ${job.progress}`);
    console.log(`[job] currentPhase : ${job.currentPhase ?? "(not exposed)"}`);
    console.log(`[job] error        : ${job.error ?? "(none)"}`);
    console.log(`[job] createdAt    : ${job.createdAt}`);
    console.log(`[job] updatedAt    : ${job.updatedAt}`);
    console.log(`[job] completedAt  : ${job.completedAt ?? "(not completed)"}`);
  } catch (error) {
    console.error("[STEP 3] getJobStatus() FAILED:", error);
  }
}

main()
  .then(() => {
    process.exitCode = 0;
  })
  .catch((error: unknown) => {
    console.error("❌ Diagnostic failed:");
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    if (moss) {
      await moss.close();
    }
  });