"use client";

import type { SourceItem } from "@/types";

export function SourcesStrip({
  sources,
  highlight,
}: {
  sources: SourceItem[];
  highlight?: number | null;
}) {
  if (!sources || sources.length === 0) return null;
  return (
    <div className="mt-3">
      <div className="text-[12px] text-ink-faint mb-1.5">
        参考来源（{sources.length}）
      </div>
      <div className="flex gap-2 overflow-x-auto pb-1">
        {sources.map((s) => (
          <a
            key={s.index}
            id={`src-${s.index}`}
            href={s.url}
            target="_blank"
            rel="noreferrer"
            className={`shrink-0 w-52 rounded-lg border px-3 py-2 transition-all bg-white hover:border-accent ${
              highlight === s.index
                ? "border-accent shadow-[0_0_0_2px_#5dcaa566]"
                : "border-[#e7e5dc]"
            }`}
          >
            <div className="flex items-center gap-1.5">
              <span className="cite-badge">{s.index}</span>
              <span className="text-[11px] text-ink-faint truncate">{s.domain}</span>
            </div>
            <div className="mt-1 text-[12.5px] leading-snug text-ink line-clamp-2">
              {s.title}
            </div>
          </a>
        ))}
      </div>
    </div>
  );
}
