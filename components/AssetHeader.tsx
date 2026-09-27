"use client";

import type { AssetSummary } from "@/lib/types";
import { StatusBadge } from "@/components/StatusBadge";

export function AssetHeader({ asset }: { asset: AssetSummary }) {
  return (
    <header className="border-b border-zinc-800 bg-zinc-900/60 px-6 py-4">
      <div className="flex items-start justify-between gap-6">
        <div className="min-w-0">
          <div className="flex items-center gap-3">
            <h1 className="font-mono text-xl font-semibold text-zinc-50">{asset.code}</h1>
            <StatusBadge status={asset.status} />
          </div>
          <div className="mt-1 text-sm text-zinc-300">{asset.name}</div>
          <div className="mt-1 text-xs font-mono text-zinc-500">
            {asset.manufacturer} {asset.model}
          </div>
        </div>

        <dl className="grid shrink-0 grid-cols-2 gap-x-8 gap-y-1 pt-0.5 text-right">
          <dt className="text-[11px] font-mono uppercase tracking-wider text-zinc-600">Plant</dt>
          <dd className="font-mono text-xs text-zinc-300">
            {asset.plant.code} · {asset.plant.name}
          </dd>
          <dt className="text-[11px] font-mono uppercase tracking-wider text-zinc-600">Location</dt>
          <dd className="font-mono text-xs text-zinc-300">{asset.plant.location ?? "—"}</dd>
          <dt className="text-[11px] font-mono uppercase tracking-wider text-zinc-600">Incidents</dt>
          <dd className="font-mono text-xs text-zinc-300">{asset.incidentCount}</dd>
          <dt className="text-[11px] font-mono uppercase tracking-wider text-zinc-600">Maintenance</dt>
          <dd className="font-mono text-xs text-zinc-300">{asset.maintenanceCount}</dd>
          <dt className="text-[11px] font-mono uppercase tracking-wider text-zinc-600">Work orders</dt>
          <dd className="font-mono text-xs text-zinc-300">{asset.workOrderCount}</dd>
          <dt className="text-[11px] font-mono uppercase tracking-wider text-zinc-600">SOPs</dt>
          <dd className="font-mono text-xs text-zinc-300">{asset.sopCount}</dd>
        </dl>
      </div>
    </header>
  );
}