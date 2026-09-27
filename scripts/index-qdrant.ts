import { loadEnvFile } from "node:process";
import {
  disconnectMemoryDatabase,
  indexOperationalMemory,
} from "../lib/memory/indexing";

try {
  loadEnvFile();
} catch {
}

async function main(): Promise<void> {
  const report = await indexOperationalMemory();
  if (report.recordsDiscovered === 0) {
    throw new Error("No operational memory records were discovered.");
  }
  console.log(JSON.stringify(report, null, 2));
  if (report.failures > 0) {
    throw new Error("Operational memory indexing completed with failures.");
  }
}

main()
  .then(() => {
    process.exitCode = 0;
  })
  .catch((error: unknown) => {
    console.error("Qdrant operational memory indexing failed:");
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await disconnectMemoryDatabase();
  });
