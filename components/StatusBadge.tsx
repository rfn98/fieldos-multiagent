"use client";

const STATUS_STYLE: Record<string, string> = {
  OPERATIONAL: "text-emerald-400 border-emerald-800/70 bg-emerald-950/40",
  WARNING: "text-amber-400 border-amber-800/70 bg-amber-950/40",
  CRITICAL: "text-red-400 border-red-800/70 bg-red-950/40",
};

export function StatusBadge({ status }: { status: string }) {
  return (
    <span
      className={`inline-block px-2 py-0.5 text-[11px] font-mono uppercase tracking-wider border ${
        STATUS_STYLE[status] ?? "text-zinc-400 border-zinc-700 bg-zinc-900"
      }`}
    >
      {status}
    </span>
  );
}