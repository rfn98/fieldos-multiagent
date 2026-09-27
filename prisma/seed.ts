import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function main() {
  console.log("🌱 Seeding FieldOS database...");

  // =========================================================
  // PLANTS
  // =========================================================

  const plantA = await prisma.plant.upsert({
    where: { code: "PLANT-A" },
    update: {},
    create: {
      code: "PLANT-A",
      name: "Cikarang Manufacturing Plant",
      location: "Cikarang, West Java",
    },
  });

  const plantB = await prisma.plant.upsert({
    where: { code: "PLANT-B" },
    update: {},
    create: {
      code: "PLANT-B",
      name: "Bekasi Processing Plant",
      location: "Bekasi, West Java",
    },
  });

  // =========================================================
  // TECHNICIANS
  // =========================================================

  const technicians = await Promise.all([
    prisma.technician.upsert({
      where: { code: "TECH-001" },
      update: {},
      create: {
        code: "TECH-001",
        name: "Andi Pratama",
        specialization: "Mechanical",
      },
    }),

    prisma.technician.upsert({
      where: { code: "TECH-002" },
      update: {},
      create: {
        code: "TECH-002",
        name: "Budi Santoso",
        specialization: "Electrical",
      },
    }),

    prisma.technician.upsert({
      where: { code: "TECH-003" },
      update: {},
      create: {
        code: "TECH-003",
        name: "Rizky Maulana",
        specialization: "Instrumentation",
      },
    }),

    prisma.technician.upsert({
      where: { code: "TECH-004" },
      update: {},
      create: {
        code: "TECH-004",
        name: "Dimas Saputra",
        specialization: "Mechanical",
      },
    }),
  ]);

  const technicianMap = Object.fromEntries(
    technicians.map((technician) => [technician.code, technician.id])
  );

  // =========================================================
  // ASSETS
  // =========================================================

  const assets = await Promise.all([
    prisma.asset.upsert({
      where: { code: "P-204" },
      update: {},
      create: {
        code: "P-204",
        name: "Cooling Water Pump",
        manufacturer: "Grundfos",
        model: "CR 32-4",
        status: "CRITICAL",
        plantId: plantA.id,
      },
    }),

    prisma.asset.upsert({
      where: { code: "P-201" },
      update: {},
      create: {
        code: "P-201",
        name: "Feed Water Pump",
        manufacturer: "KSB",
        model: "Etanorm 50-32",
        status: "OPERATIONAL",
        plantId: plantA.id,
      },
    }),

    prisma.asset.upsert({
      where: { code: "M-101" },
      update: {},
      create: {
        code: "M-101",
        name: "Main Air Compressor",
        manufacturer: "Atlas Copco",
        model: "GA 75",
        status: "OPERATIONAL",
        plantId: plantA.id,
      },
    }),

    prisma.asset.upsert({
      where: { code: "M-103" },
      update: {},
      create: {
        code: "M-103",
        name: "Cooling Tower Motor",
        manufacturer: "ABB",
        model: "M3BP 250",
        status: "WARNING",
        plantId: plantA.id,
      },
    }),

    prisma.asset.upsert({
      where: { code: "V-301" },
      update: {},
      create: {
        code: "V-301",
        name: "Process Control Valve",
        manufacturer: "Fisher",
        model: "D4",
        status: "OPERATIONAL",
        plantId: plantB.id,
      },
    }),

    prisma.asset.upsert({
      where: { code: "P-305" },
      update: {},
      create: {
        code: "P-305",
        name: "Chemical Transfer Pump",
        manufacturer: "Sulzer",
        model: "AHLSTAR",
        status: "OPERATIONAL",
        plantId: plantB.id,
      },
    }),
  ]);

  const assetMap = Object.fromEntries(
    assets.map((asset) => [asset.code, asset.id])
  );

  // =========================================================
  // INCIDENTS
  // =========================================================

  const incidents = [
    {
      code: "INC-2026-001",
      assetCode: "P-204",
      title: "Abnormal vibration detected",
      description:
        "Cooling Water Pump P-204 experienced abnormal vibration during operation. Inspection found partial obstruction in the intake filter. Debris accumulation restricted water flow and caused increased pump vibration.",
      rootCause:
        "Partial intake filter obstruction caused restricted flow and increased pump vibration.",
      severity: "HIGH",
      occurredAt: new Date("2026-08-14T08:30:00+07:00"),
      resolvedAt: new Date("2026-08-14T15:45:00+07:00"),
      technicianCode: "TECH-001",
    },

    {
      code: "INC-2026-002",
      assetCode: "P-204",
      title: "Unexpected pump shutdown",
      description:
        "Cooling Water Pump P-204 unexpectedly shut down during normal operation. Inspection found heavy contamination on the intake filter. The condition was similar to the previous vibration incident.",
      rootCause:
        "Heavy intake filter contamination restricted water flow and triggered abnormal operating conditions.",
      severity: "CRITICAL",
      occurredAt: new Date("2026-08-28T10:15:00+07:00"),
      resolvedAt: new Date("2026-08-28T18:20:00+07:00"),
      technicianCode: "TECH-001",
    },

    {
      code: "INC-2026-003",
      assetCode: "M-103",
      title: "Motor temperature above normal",
      description:
        "Cooling Tower Motor M-103 recorded elevated operating temperature. Inspection showed dust accumulation around the cooling path, reducing airflow through the motor.",
      rootCause:
        "Dust accumulation reduced cooling airflow and caused motor temperature to increase.",
      severity: "MEDIUM",
      occurredAt: new Date("2026-08-25T09:00:00+07:00"),
      resolvedAt: new Date("2026-08-25T13:30:00+07:00"),
      technicianCode: "TECH-002",
    },

    {
      code: "INC-2026-004",
      assetCode: "P-201",
      title: "Low discharge pressure",
      description:
        "Feed Water Pump P-201 showed low discharge pressure after scheduled maintenance. Inspection found air trapped in the pump system following maintenance work.",
      rootCause:
        "Air trapped in the pump system after maintenance caused reduced discharge pressure.",
      severity: "MEDIUM",
      occurredAt: new Date("2026-08-20T07:45:00+07:00"),
      resolvedAt: new Date("2026-08-20T10:15:00+07:00"),
      technicianCode: "TECH-004",
    },
  ];

  for (const incident of incidents) {
    await prisma.incident.upsert({
      where: { code: incident.code },
      update: {},
      create: {
        code: incident.code,
        assetId: assetMap[incident.assetCode],
        title: incident.title,
        description: incident.description,
        rootCause: incident.rootCause,
        severity: incident.severity,
        occurredAt: incident.occurredAt,
        resolvedAt: incident.resolvedAt,
        technicianId: technicianMap[incident.technicianCode],
      },
    });
  }

  // =========================================================
  // MAINTENANCE RECORDS
  // =========================================================

  const maintenanceRecords = [
    {
      code: "MNT-2026-001",
      assetCode: "P-204",
      type: "CORRECTIVE",
      title: "Corrective maintenance after abnormal vibration",
      description:
        "Inspection found debris accumulated inside the intake filter. Filter was cleaned and the damaged gasket was replaced.",
      actionTaken:
        "Cleaned intake filter, removed debris, replaced intake gasket, and verified pump vibration.",
      performedAt: new Date("2026-08-14T13:00:00+07:00"),
      technicianCode: "TECH-001",
    },

    {
      code: "MNT-2026-002",
      assetCode: "P-204",
      type: "EMERGENCY",
      title: "Emergency maintenance after unexpected shutdown",
      description:
        "Heavy contamination was found on the intake filter after P-204 shutdown.",
      actionTaken:
        "Replaced intake filter element and gasket. Pump alignment was verified before returning the asset to service.",
      performedAt: new Date("2026-08-28T16:00:00+07:00"),
      technicianCode: "TECH-001",
    },

    {
      code: "MNT-2026-003",
      assetCode: "P-201",
      type: "PREVENTIVE",
      title: "Monthly preventive maintenance",
      description:
        "Performed scheduled inspection of Feed Water Pump P-201.",
      actionTaken:
        "Checked bearings, lubrication, seals, pressure readings, and pump condition.",
      performedAt: new Date("2026-08-20T06:30:00+07:00"),
      technicianCode: "TECH-004",
    },

    {
      code: "MNT-2026-004",
      assetCode: "M-103",
      type: "PREVENTIVE",
      title: "Cooling tower motor inspection",
      description:
        "Performed preventive inspection after elevated motor temperature was reported.",
      actionTaken:
        "Cleaned cooling path, removed dust accumulation, and verified motor temperature under normal load.",
      performedAt: new Date("2026-08-25T11:00:00+07:00"),
      technicianCode: "TECH-002",
    },
  ];

  for (const record of maintenanceRecords) {
    await prisma.maintenanceRecord.upsert({
      where: { code: record.code },
      update: {},
      create: {
        code: record.code,
        assetId: assetMap[record.assetCode],
        type: record.type,
        title: record.title,
        description: record.description,
        actionTaken: record.actionTaken,
        performedAt: record.performedAt,
        technicianId: technicianMap[record.technicianCode],
      },
    });
  }

  // =========================================================
  // WORK ORDERS
  // =========================================================

  const workOrders = [
    {
      code: "WO-2026-001",
      assetCode: "P-204",
      title: "Inspect P-204 intake system",
      description:
        "Inspect intake filter, gasket condition, differential pressure, and signs of debris accumulation.",
      priority: "CRITICAL",
      status: "COMPLETED",
      scheduledAt: new Date("2026-08-14T09:00:00+07:00"),
      completedAt: new Date("2026-08-14T15:30:00+07:00"),
      technicianCode: "TECH-001",
    },

    {
      code: "WO-2026-002",
      assetCode: "M-103",
      title: "Cooling tower motor inspection",
      description:
        "Inspect cooling airflow and remove dust accumulation around the motor.",
      priority: "MEDIUM",
      status: "COMPLETED",
      scheduledAt: new Date("2026-08-25T09:00:00+07:00"),
      completedAt: new Date("2026-08-25T13:00:00+07:00"),
      technicianCode: "TECH-002",
    },

    {
      code: "WO-2026-003",
      assetCode: "P-201",
      title: "Monthly preventive maintenance",
      description:
        "Perform scheduled monthly preventive maintenance for Feed Water Pump P-201.",
      priority: "LOW",
      status: "COMPLETED",
      scheduledAt: new Date("2026-08-20T06:00:00+07:00"),
      completedAt: new Date("2026-08-20T10:00:00+07:00"),
      technicianCode: "TECH-004",
    },

    {
      code: "WO-2026-004",
      assetCode: "P-204",
      title: "Follow-up intake system inspection",
      description:
        "Perform follow-up inspection of P-204 intake filter after repeated contamination incidents.",
      priority: "HIGH",
      status: "OPEN",
      scheduledAt: new Date("2026-09-08T09:00:00+07:00"),
      completedAt: null,
      technicianCode: "TECH-001",
    },
  ];

  for (const workOrder of workOrders) {
    await prisma.workOrder.upsert({
      where: { code: workOrder.code },
      update: {},
      create: {
        code: workOrder.code,
        assetId: assetMap[workOrder.assetCode],
        title: workOrder.title,
        description: workOrder.description,
        priority: workOrder.priority,
        status: workOrder.status,
        scheduledAt: workOrder.scheduledAt,
        completedAt: workOrder.completedAt,
        technicianId: technicianMap[workOrder.technicianCode],
      },
    });
  }

  // =========================================================
  // SOPs
  // =========================================================

  const sops = [
    {
      code: "SOP-014",
      assetCode: "P-204",
      title: "P-204 Intake Filter Inspection Procedure",
      category: "INSPECTION",
      content: `
P-204 INTAKE FILTER INSPECTION PROCEDURE

1. Perform lockout/tagout before beginning inspection.
2. Close the intake isolation valve.
3. Check differential pressure across the intake filter.
4. Inspect the filter for debris, contamination, and physical damage.
5. Clean the filter if contamination is light.
6. Replace the filter element if contamination is heavy or the element is damaged.
7. Inspect and replace the gasket if required.
8. Verify the intake valve is correctly positioned.
9. Restart the pump according to the approved restart procedure.
10. Monitor vibration and discharge pressure after restart.

Safety:
- Lockout/tagout is mandatory before opening the intake system.
- Do not remove the filter while the system is pressurized.
      `.trim(),
    },

    {
      code: "SOP-015",
      assetCode: "P-204",
      title: "P-204 Pump Restart Procedure",
      category: "STARTUP",
      content: `
P-204 PUMP RESTART PROCEDURE

1. Confirm maintenance work is complete.
2. Verify all tools and foreign objects have been removed.
3. Confirm intake and discharge valves are in the correct position.
4. Remove lockout/tagout according to site procedure.
5. Start the pump.
6. Check vibration immediately after startup.
7. Check discharge pressure.
8. Monitor the pump for abnormal noise or temperature.
9. Record the operating condition after stabilization.
      `.trim(),
    },

    {
      code: "SOP-022",
      assetCode: "M-103",
      title: "Cooling Tower Motor Inspection",
      category: "INSPECTION",
      content: `
COOLING TOWER MOTOR INSPECTION PROCEDURE

1. Isolate the motor before inspection.
2. Inspect the cooling path for dust and debris.
3. Clean the motor cooling surfaces.
4. Check ventilation and airflow.
5. Inspect electrical connections.
6. Verify bearing condition.
7. Restart the motor.
8. Monitor motor temperature under normal load.
      `.trim(),
    },

    {
      code: "SOP-018",
      assetCode: "P-201",
      title: "Feed Pump Startup Procedure",
      category: "STARTUP",
      content: `
FEED WATER PUMP STARTUP PROCEDURE

1. Verify the pump is correctly connected.
2. Confirm suction and discharge valves are correctly positioned.
3. Ensure the pump is fully primed.
4. Remove trapped air from the system.
5. Start the pump.
6. Check discharge pressure.
7. Check for abnormal vibration or noise.
8. Record operating pressure after stabilization.
      `.trim(),
    },
  ];

  for (const sop of sops) {
    await prisma.sop.upsert({
      where: { code: sop.code },
      update: {},
      create: {
        code: sop.code,
        assetId: assetMap[sop.assetCode],
        title: sop.title,
        category: sop.category,
        content: sop.content,
      },
    });
  }

  console.log("✅ Database seed completed.");
  console.log("");
  console.log("Summary:");
  console.log(`  Plants:               ${await prisma.plant.count()}`);
  console.log(`  Assets:               ${await prisma.asset.count()}`);
  console.log(`  Technicians:          ${await prisma.technician.count()}`);
  console.log(`  Incidents:            ${await prisma.incident.count()}`);
  console.log(`  Maintenance records: ${await prisma.maintenanceRecord.count()}`);
  console.log(`  Work orders:          ${await prisma.workOrder.count()}`);
  console.log(`  SOPs:                 ${await prisma.sop.count()}`);
}

main()
  .catch((error) => {
    console.error("❌ Seed failed:");
    console.error(error);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });