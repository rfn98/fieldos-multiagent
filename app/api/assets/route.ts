import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(): Promise<NextResponse> {
  try {
    const assets = await prisma.asset.findMany({
      select: {
        id: true,
        code: true,
        name: true,
        manufacturer: true,
        model: true,
        status: true,
        plant: {
          select: {
            id: true,
            code: true,
            name: true,
            location: true,
          },
        },
        _count: {
          select: {
            incidents: true,
            maintenanceRecords: true,
            workOrders: true,
            sops: true,
          },
        },
      },
      orderBy: { code: "asc" },
    });

    return NextResponse.json({
      assets: assets.map((asset: any) => ({
        id: asset.id,
        code: asset.code,
        name: asset.name,
        manufacturer: asset.manufacturer,
        model: asset.model,
        status: asset.status,
        plant: asset.plant,
        incidentCount: asset._count.incidents,
        maintenanceCount: asset._count.maintenanceRecords,
        workOrderCount: asset._count.workOrders,
        sopCount: asset._count.sops,
      })),
    });
  } catch (error) {
    console.error("[api/assets] database error", error);
    return NextResponse.json(
      { error: { kind: "database", message: "Database query failed." } },
      { status: 500 }
    );
  }
}