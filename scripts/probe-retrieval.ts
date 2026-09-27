import { loadEnvFile } from "node:process";
try {
  loadEnvFile();
} catch {}

import { MossClient } from "@moss-dev/moss";

const PROJECT_ID = process.env.MOSS_PROJECT_ID ?? "";
const PROJECT_KEY = process.env.MOSS_PROJECT_KEY ?? "";
const INDEX_NAME = process.env.MOSS_INDEX_NAME ?? "fieldos-knowledge";

let moss: MossClient | null = null;

async function main(): Promise<void> {
  moss = new MossClient(PROJECT_ID, PROJECT_KEY);

  console.log("-- sanity: listIndexes() --");
  try {
    const indexes = await moss.listIndexes();
    console.log("indexes:", indexes.map((i) => `${i.name} (${i.status}, ${i.docCount} docs)`).join(", "));
  } catch (error) {
    console.error("listIndexes FAILED:", error);
  }

  console.log("");
  console.log("-- raw: loadIndex(\"" + INDEX_NAME + "\") --");
  try {
    await moss.loadIndex(INDEX_NAME);
    console.log("loadIndex OK");
  } catch (error) {
    console.error("loadIndex FAILED (raw error):");
    console.error(error);
  }

  console.log("");
  console.log("-- raw: query() WITHOUT loadIndex (cloud /query fallback) --");
  try {
    const result = await moss.query(INDEX_NAME, "Why did P-204 fail before?", { topK: 5 });
    console.log("cloud query OK: docs=", result.docs.length, " timeTakenInMs=", result.timeTakenInMs);
    result.docs.forEach((doc) => {
      console.log(`  ${doc.id} | type=${doc.metadata?.type ?? "?"} | asset=${doc.metadata?.asset_id ?? "?"} | score=${doc.score.toFixed(4)}`);
    });
  } catch (error) {
    console.error("cloud query FAILED (raw error):");
    console.error(error);
  }
}

main()
  .then(() => {
    process.exitCode = 0;
  })
  .catch((error: unknown) => {
    console.error("PROBE FAILED:", error);
    process.exitCode = 1;
  })
  .finally(async () => {
    if (moss) {
      await moss.close();
    }
  });