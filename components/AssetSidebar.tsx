"use client";

import type { AssetSummary } from "@/lib/types";
import { StatusBadge } from "@/components/StatusBadge";

export interface AssetSidebarProps {
  assets: AssetSummary[];
  status: "loading" | "loaded" | "error";
  selectedCode: string | null;
  onSelect: (code: string) => void;
}

export function AssetSidebar({ assets, status, selectedCode, onSelect }: AssetSidebarProps) {
  return (
    <aside className="flex h-full w-72 shrink-0 flex-col border-r border-zinc-800 bg-zinc-950">
      <div className="border-b border-zinc-800 px-4 py-4">
        <div className="text-sm font-semibold tracking-[0.3em] text-zinc-100">FIELDOS</div>
        <div className="mt-1 text-[10px] font-mono uppercase tracking-widest text-zinc-500">
          AI operating system for field workers
        </div>
        <div className="mt-1.5 text-[10px] font-mono leading-relaxed text-zinc-600">
          Moss retrieves context · AI reasons over evidence
        </div>
      </div>

      <div className="flex items-center justify-between border-b border-zinc-800 px-4 py-2">
        <span className="text-[11px] font-mono uppercase tracking-wider text-zinc-500">Assets</span>
        {status === "loaded" && (
          <span className="text-[11px] font-mono text-zinc-600">{assets.length}</span>
        )}
      </div>

      <nav className="flex-1 overflow-y-auto">
        {status === "loading" && (
          <p className="px-4 py-3 text-xs font-mono text-zinc-500">Loading assets…</p>
        )}
        {status === "error" && (
          <p className="px-4 py-3 text-xs font-mono text-red-400">Failed to load assets.</p>
        )}
        {status === "loaded" &&
          assets.map((asset) => {
            const selected = asset.code === selectedCode;
            return (
              <button
                key={asset.id}
                type="button"
                onClick={() => onSelect(asset.code)}
                className={`flex w-full flex-col gap-0.5 border-b border-zinc-900 px-4 py-3 text-left transition-colors ${
                  selected
                    ? "bg-zinc-800/60"
                    : "bg-transparent hover:bg-zinc-900/60"
                }`}
              >
                <span className="flex items-center justify-between gap-2">
                  <span className={`font-mono text-xs ${selected ? "text-amber-300" : "text-zinc-200"}`}>
                    {asset.code}
                  </span>
                  <StatusBadge status={asset.status} />
                </span>
                <span className="truncate text-xs text-zinc-400">{asset.name}</span>
              </button>
            );
          })}
      </nav>
    </aside>
  );
}