"use client";

import { useState } from "react";
import type { StageRecord } from "@/types";

export interface LiveStage extends StageRecord {
  status: "active" | "done";
}

const STAGE_ICONS: Record<string, string> = {
  classify: "◎",
  plan: "≡",
  search: "⌕",
  read: "▤",
  verify: "◇",
  write: "✎",
};

/** 生成中的实时阶段时间线 */
export function LiveTimeline({ stages }: { stages: LiveStage[] }) {
  const active = stages.find((s) => s.status === "active");
  return (
    <section
      className="agent-run rounded-xl border border-accent-border/40 bg-white px-4 py-3.5 fade-up"
      aria-live="polite"
      aria-label="Agent 执行过程"
    >
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2 text-[12px] font-semibold text-ink">
          <span className="agent-pulse" aria-hidden="true" />
          Agent 工作流
        </div>
        <span className="text-[11px] text-ink-faint">
          {active ? `当前：${active.label}` : "已完成"}
        </span>
      </div>
      {stages.map((s, i) => (
        <div key={`${s.name}-${i}`} className="agent-stage flex items-start gap-2.5 text-[13px]" style={{ animationDelay: `${i * 45}ms` }}>
          <div className="relative flex w-4 shrink-0 justify-center">
            {i < stages.length - 1 && <span className="agent-connector" aria-hidden="true" />}
            {s.status === "active" ? (
              <span className="stage-dot stage-dot-active" aria-label="进行中" />
            ) : (
              <span className="stage-dot stage-dot-done" aria-label="已完成">✓</span>
            )}
          </div>
          <div className="min-w-0">
            <span className={s.status === "active" ? "font-medium text-ink" : "text-ink-soft"}>
              {s.label}
            </span>
            {s.detail && (
              <div className="text-[12px] text-ink-faint truncate">{s.detail}</div>
            )}
          </div>
        </div>
      ))}
    </section>
  );
}

/** 历史消息里的折叠阶段记录 */
export function CollapsedTimeline({ stages }: { stages: StageRecord[] }) {
  const [open, setOpen] = useState(false);
  if (!stages || stages.length === 0) return null;
  return (
    <div className="mb-2">
      <button
        onClick={() => setOpen(!open)}
        className="text-[12px] text-ink-faint hover:text-accent transition-colors"
      >
        {open ? "▾ 收起执行过程" : `▸ 查看执行过程（${stages.length} 步）`}
      </button>
      {open && (
        <div className="mt-2 rounded-lg border border-[#e4e4e7] bg-white px-4 py-3 space-y-2 fade-up">
          {stages.map((s, i) => (
            <div key={i} className="flex items-start gap-2.5 text-[13px]">
              <span className="mt-0.5 w-4 text-center text-accent">
                {STAGE_ICONS[s.name] || "✓"}
              </span>
              <div className="min-w-0">
                <span className="text-ink-soft">{s.label}</span>
                {s.detail && (
                  <div className="text-[12px] text-ink-faint">{s.detail}</div>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
