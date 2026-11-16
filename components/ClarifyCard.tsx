"use client";

import { useState } from "react";
import type { ClarifyQuestion } from "@/types";

export function ClarifyCard({
  questions,
  onSubmit,
  onSkip,
}: {
  questions: ClarifyQuestion[];
  onSubmit: (summary: string) => void;
  onSkip: () => void;
}) {
  // 每题选中的选项下标集合
  const [picked, setPicked] = useState<Record<string, Set<number>>>({});

  const toggle = (q: ClarifyQuestion, idx: number) => {
    setPicked((prev) => {
      const next = { ...prev };
      const cur = new Set(next[q.id] || []);
      if (q.multi) {
        cur.has(idx) ? cur.delete(idx) : cur.add(idx);
      } else {
        cur.clear();
        cur.add(idx);
      }
      next[q.id] = cur;
      return next;
    });
  };

  const anyPicked = questions.some((q) => (picked[q.id]?.size || 0) > 0);

  const submit = () => {
    const parts = questions.map((q) => {
      const sel = [...(picked[q.id] || [])].sort();
      const labels = sel.map((i) => q.options[i]?.label).filter(Boolean);
      return `${q.question} → ${labels.length ? labels.join("、") : "未作答"}`;
    });
    onSubmit(parts.join("；"));
  };

  return (
    <div className="rounded-xl border border-accent-border/50 bg-white px-5 py-4 space-y-5 fade-up">
      <div className="text-[13px] text-ink-soft">
        在给出讲解之前，先确认几件事，好让内容贴合你：
      </div>
      {questions.map((q, qi) => (
        <div key={q.id}>
          <div className="text-[14px] font-medium mb-2">
            Q{qi + 1}　{q.question}
            <span className="ml-2 text-[11px] text-ink-faint font-normal">
              {q.multi ? "多选" : "单选"}
            </span>
          </div>
          <div className="grid gap-2">
            {q.options.map((o, oi) => {
              const active = picked[q.id]?.has(oi);
              return (
                <button
                  key={oi}
                  onClick={() => toggle(q, oi)}
                  className={`text-left rounded-lg border px-3.5 py-2.5 transition-all ${
                    active
                      ? "border-accent bg-accent-soft"
                      : "border-[#e7e5dc] bg-white hover:border-accent-border"
                  }`}
                >
                  <div className="text-[13.5px] font-medium text-ink">{o.label}</div>
                  {o.desc && (
                    <div className="text-[12px] text-ink-soft mt-0.5">{o.desc}</div>
                  )}
                </button>
              );
            })}
          </div>
        </div>
      ))}
      <div className="flex items-center gap-3 pt-1">
        <button
          onClick={submit}
          disabled={!anyPicked}
          className="rounded-lg bg-accent px-4 py-2 text-[13px] text-white font-medium hover:opacity-90 disabled:opacity-40 transition-opacity"
        >
          继续
        </button>
        <button
          onClick={onSkip}
          className="text-[12.5px] text-ink-faint hover:text-ink transition-colors"
        >
          跳过，直接回答
        </button>
      </div>
    </div>
  );
}
