"use client";

// 课后练习：讲完一节课后弹出 3-5 道单选/多选，提交即判分并给解析。
// 不做独立测验模块——练习就长在课尾。
import { useMemo, useState } from "react";
import type { LectureQuizItem } from "@/types";

export function LectureQuizPanel({
  quiz,
  onClose,
}: {
  quiz: LectureQuizItem[];
  onClose: () => void;
}) {
  const [answers, setAnswers] = useState<Record<number, number[]>>({});
  const [submitted, setSubmitted] = useState(false);

  const toggleOption = (qi: number, oi: number, multi: boolean) => {
    if (submitted) return;
    setAnswers((prev) => {
      const cur = prev[qi] || [];
      if (multi) {
        return { ...prev, [qi]: cur.includes(oi) ? cur.filter((x) => x !== oi) : [...cur, oi] };
      }
      return { ...prev, [qi]: [oi] };
    });
  };

  const answeredAll = quiz.every((_, qi) => (answers[qi] || []).length > 0);

  const score = useMemo(() => {
    let correct = 0;
    quiz.forEach((q, qi) => {
      const a = [...(answers[qi] || [])].sort().join(",");
      const c = [...q.answerIndexes].sort().join(",");
      if (a && a === c) correct += 1;
    });
    return correct;
  }, [answers, quiz]);

  return (
    <div className="absolute inset-0 z-[60] flex items-center justify-center bg-white/70 backdrop-blur-[2px]">
      <div className="w-[600px] max-w-[92%] max-h-[86%] overflow-y-auto rounded-3xl border border-[#e7e5dc] bg-white shadow-2xl p-7 fade-up">
        <div className="flex items-center justify-between mb-1">
          <div className="text-[11px] text-accent font-semibold tracking-[.1em]">课后练习</div>
          <button onClick={onClose} className="text-ink-faint hover:text-ink text-[16px]" aria-label="关闭">
            ×
          </button>
        </div>
        <div className="text-[18px] font-bold mb-1">
          {submitted ? `答对 ${score} / ${quiz.length} 题` : `${quiz.length} 道题，检查一下这节课真的听懂了没`}
        </div>
        <div className="text-[12.5px] text-ink-soft mb-5">
          {submitted
            ? score === quiz.length
              ? "全对，这节课可以翻篇了。"
              : "错题看一眼解析，比多做三道新题有用。"
            : "单选点一个，多选点多个；答完点提交。"}
        </div>

        <div className="space-y-5">
          {quiz.map((q, qi) => {
            const picked = answers[qi] || [];
            const isRight =
              [...picked].sort().join(",") === [...q.answerIndexes].sort().join(",");
            return (
              <div key={qi} className="rounded-2xl border border-[#e7e5dc] bg-[#faf9f6] p-4">
                <div className="flex items-start gap-2 mb-3">
                  <span className="text-[12px] text-ink-faint shrink-0 mt-0.5">Q{qi + 1}</span>
                  <div className="text-[13.5px] font-medium leading-relaxed flex-1">{q.question}</div>
                  {q.multi && (
                    <span className="shrink-0 text-[10.5px] text-ink-faint border border-[#d3d1c7] rounded px-1.5 py-px">
                      多选
                    </span>
                  )}
                  {submitted && (
                    <span
                      className={`shrink-0 text-[11px] rounded px-1.5 py-px ${
                        isRight ? "text-emerald-600 bg-emerald-50" : "text-red-600 bg-red-50"
                      }`}
                    >
                      {isRight ? "✓ 答对" : "✗ 答错"}
                    </span>
                  )}
                </div>
                <div className="grid gap-2 sm:grid-cols-2">
                  {q.options.map((opt, oi) => {
                    const pickedThis = picked.includes(oi);
                    const isAnswer = q.answerIndexes.includes(oi);
                    let cls = "border-[#e7e5dc] bg-white hover:border-accent/60";
                    if (submitted) {
                      if (isAnswer) cls = "border-emerald-400 bg-emerald-50";
                      else if (pickedThis) cls = "border-red-300 bg-red-50";
                      else cls = "border-[#e7e5dc] bg-white opacity-70";
                    } else if (pickedThis) {
                      cls = "border-accent bg-accent/5";
                    }
                    return (
                      <button
                        key={oi}
                        onClick={() => toggleOption(qi, oi, q.multi)}
                        className={`text-left rounded-xl border px-3.5 py-2.5 text-[12.5px] text-ink transition-colors ${cls}`}
                      >
                        {opt}
                      </button>
                    );
                  })}
                </div>
                {submitted && q.explain && (
                  <div className="mt-3 rounded-xl bg-white border border-[#e7e5dc] px-3.5 py-2.5 text-[12px] text-ink-soft leading-relaxed">
                    💡 {q.explain}
                  </div>
                )}
              </div>
            );
          })}
        </div>

        <div className="mt-6 flex justify-end gap-3">
          {!submitted ? (
            <button
              onClick={() => setSubmitted(true)}
              disabled={!answeredAll}
              className="rounded-full bg-accent px-7 py-2.5 text-[13px] text-white font-medium hover:opacity-90 disabled:opacity-40 transition-opacity"
            >
              {answeredAll ? "交卷" : "还有题没答"}
            </button>
          ) : (
            <button
              onClick={onClose}
              className="rounded-full border border-[#d3d1c7] px-7 py-2.5 text-[13px] text-ink hover:border-accent transition-colors"
            >
              完成练习
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
