import { PrismaClient } from "@prisma/client";
import { MossClient, type DocumentInfo } from "@moss-dev/moss";
import { loadEnvFile } from "node:process";

try {
  loadEnvFile();
} catch {
  // .env is optional; the environment may already provide the variables.
}

const prisma = new PrismaClient();

const PROJECT_ID = process.env.MOSS_PROJECT_ID;
const PROJECT_KEY = process.env.MOSS_PROJECT_KEY;
const INDEX_NAME = process.env.MOSS_INDEX_NAME ?? "fieldos-knowledge";

const TEST_QUERY = "Why did P-204 fail before?";

const PLACEHOLDERS = new Set(["", "...", "xxx", "your-project-id", "your-project-key"]);
const projectId = PROJECT_ID?.trim() ?? "";
const projectKey = PROJECT_KEY?.trim() ?? "";
const hasRealCredentials =
  Boolean(projectId) &&
  Boolean(projectKey) &&
  !PLACEHOLDERS.has(projectId) &&
  !PLACEHOLDERS.has(projectKey);

let moss: MossClient | null = null;

function dateString(value: Date | null | undefined): string {
  return value ? value.toISOString() : "";
}

async function buildDocuments(): Promise<DocumentInfo[]> {
  const incidents = await prisma.incident.findMany({
    include: {
      asset: { include: { plant: true } },
      technician: true,
    },
  });

  const maintenanceRecords = await prisma.maintenanceRecord.findMany({
    include: {
      asset: { include: { plant: true } },
      technician: true,
    },
  });

  const sops = await prisma.sop.findMany({
    include: {
      asset: { include: { plant: true } },
    },
  });

  const incidentDocs: DocumentInfo[] = incidents.map((incident) => ({
    id: incident.code,
    text: `
INCIDENT REPORT

Incident ID: ${incident.code}
Asset: ${incident.asset.code} - ${incident.asset.name}
Manufacturer: ${incident.asset.manufacturer}
Model: ${incident.asset.model}
Plant: ${incident.asset.plant.name}
Location: ${incident.asset.plant.location ?? "n/a"}

Title:
${incident.title}

Description:
${incident.description}

Root Cause:
${incident.rootCause}

Severity:
${incident.severity}

Occurred:
${dateString(incident.occurredAt)}

Resolved:
${dateString(incident.resolvedAt) || "Not resolved"}

Technician:
${incident.technician.name}
Specialization:
${incident.technician.specialization}
    `.trim(),
    metadata: {
      type: "incident",
      asset_id: incident.asset.code,
      plant_id: incident.asset.plant.code,
      severity: String(incident.severity),
      date: dateString(incident.occurredAt),
    },
  }));

  const maintenanceDocs: DocumentInfo[] = maintenanceRecords.map((record) => ({
    id: record.code,
    text: `
MAINTENANCE RECORD

Maintenance ID: ${record.code}
Asset: ${record.asset.code} - ${record.asset.name}
Manufacturer: ${record.asset.manufacturer}
Model: ${record.asset.model}
Plant: ${record.asset.plant.name}
Location: ${record.asset.plant.location ?? "n/a"}

Type:
${record.type}

Title:
${record.title}

Description:
${record.description}

Action Taken:
${record.actionTaken}

Performed:
${dateString(record.performedAt)}

Technician:
${record.technician.name}
Specialization:
${record.technician.specialization}
    `.trim(),
    metadata: {
      type: "maintenance",
      asset_id: record.asset.code,
      plant_id: record.asset.plant.code,
      date: dateString(record.performedAt),
    },
  }));

  const sopDocs: DocumentInfo[] = sops.map((sop) => ({
    id: sop.code,
    text: `
STANDARD OPERATING PROCEDURE

SOP ID: ${sop.code}
Asset: ${sop.asset.code} - ${sop.asset.name}
Manufacturer: ${sop.asset.manufacturer}
Model: ${sop.asset.model}
Plant: ${sop.asset.plant.name}
Location: ${sop.asset.plant.location ?? "n/a"}

Category:
${sop.category}

Title:
${sop.title}

Procedure:
${sop.content}
    `.trim(),
    metadata: {
      type: "sop",
      asset_id: sop.asset.code,
      plant_id: sop.asset.plant.code,
      category: String(sop.category),
      date: dateString(sop.createdAt),
    },
  }));

  return [...incidentDocs, ...maintenanceDocs, ...sopDocs];
}

async function runCredentialsBlockedReport(documents: DocumentInfo[]): Promise<void> {
  console.log("");
  console.log("⚠️  Real Moss retrieval is BLOCKED: MOSS_PROJECT_ID / MOSS_PROJECT_KEY");
  console.log("   are missing or still placeholders in .env.");
  console.log("");
  console.log("No API calls were made. No fabricated retrieval results or latency.");
  console.log(`Expected document set is ready locally (${documents.length} documents).`);
  console.log("");
  console.log("Sample documents:");
  for (const doc of documents.slice(0, 6)) {
    const meta = doc.metadata ?? {};
    console.log(
      `  ${doc.id.padEnd(12)} type=${String(meta.type).padEnd(11)} asset_id=${String(
        meta.asset_id ?? "-"
      )}`
    );
  }
}

async function main(): Promise<void> {
  console.log("🔎 FieldOS → Moss index builder");
  console.log(`▶ Index name      : ${INDEX_NAME}`);
  console.log(`▶ Test query      : "${TEST_QUERY}"`);

  const documents = await buildDocuments();
  console.log(`▶ Documents read from PostgreSQL: ${documents.length}`);

  if (!hasRealCredentials) {
    await runCredentialsBlockedReport(documents);
    return;
  }

  moss = new MossClient(projectId, projectKey);

  console.log("");
  console.log("📡 Connecting to Moss...");

  const existingIndexes = await moss.listIndexes();
  const indexExists = existingIndexes.some((index) => index.name === INDEX_NAME);

  if (indexExists) {
    console.log(`- Index "${INDEX_NAME}" exists → deleting for a clean rebuild...`);
    await moss.deleteIndex(INDEX_NAME);
  }

  if (documents.length === 0) {
    throw new Error("No documents to index. Refusing to create an empty index.");
  }

  const created = await moss.createIndex(INDEX_NAME, documents);
  console.log(
    `✅ Index created: "${INDEX_NAME}" (job=${created.jobId}, docs=${created.docCount})`
  );

  await moss.loadIndex(INDEX_NAME);
  console.log("⚡ Index loaded into local memory (in-process queries enabled)");

  console.log("");
  console.log("🔬 Test retrieval:");
  const results = await moss.query(INDEX_NAME, TEST_QUERY, { topK: 5 });

  console.log(`  Query            : ${results.query}`);
  console.log(`  Documents returned: ${results.docs.length}`);
  console.log(`  timeTakenInMs    : ${results.timeTakenInMs}`);

  if (results.timeTakenInMs !== undefined) {
    console.log(`  Retrieval latency: ${results.timeTakenInMs} ms`);
  }
  console.log("");

  for (const doc of results.docs) {
    const meta = doc.metadata ?? {};
    console.log(
      `  - ${doc.id.padEnd(12)} | ${String(meta.type ?? "-").padEnd(11)} | asset=${String(
        meta.asset_id ?? "-"
      ).padEnd(6)} | score=${doc.score.toFixed(4)}`
    );
  }

  console.log("");
  console.log("🎯 Moss index is ready.");
}

main()
  .then(() => {
    process.exitCode = 0;
  })
  .catch((error: unknown) => {
    console.error("❌ Moss indexing failed:");
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
    if (moss) {
      await moss.close();
    }
  });