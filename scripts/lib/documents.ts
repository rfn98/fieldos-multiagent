import { PrismaClient } from "@prisma/client";
import { type DocumentInfo } from "@moss-dev/moss";

const prisma = new PrismaClient();

function dateString(value: Date | null | undefined): string {
  return value ? value.toISOString() : "";
}

/**
 * Reads every FieldOS knowledge document from PostgreSQL (incidents,
 * maintenance records, and SOPs) and builds Moss `DocumentInfo` entries
 * with the same canonical text and metadata used by the original indexer.
 * Documents are returned WITHOUT embeddings; callers supply them.
 */
export async function buildDocuments(): Promise<DocumentInfo[]> {
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

export async function disconnect(): Promise<void> {
  await prisma.$disconnect();
}