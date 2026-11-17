"use client";

// 段末检查卡：浮在白板底部（字幕之上）。三种形式：
//   choice → 选项胶囊，点了立即判对错（也可在右侧输入框自由作答）；
//   open   → 一句话作答，讲师在下一段开头接住；
//   code   → 浏览器内运行 Python，比对参考答案输出判题（编程课专用）。
import { useEffect, useRef, useState } from "react";
import type { AskState } from "@/types/board";
import { getPyodide, judgeCode, type JudgeResult } from "@/lib/lesson/pyodide";

export interface AskSubmit {
  text: string;
  correct?: boolean;
  code?: string;
  output?: string;
}

interface Props {
  ask: AskState;
  busy: boolean;
  onSubmit: (a: AskSubmit) => void;
  onSkip: () => void;
}

const LETTERS = "ABCD";

export function AskCard({ ask, busy, onSubmit, onSkip }: Props) {
  const answered = ask.answered;
  const pill = "bg-white shadow-[0_0_0_1px_rgba(0,0,0,0.07),0_2px_10px_rgba(0,0,0,0.05)]";
  const feedback =
    answered && ask.explanation && ask.kind !== "open" ? (
      <div className="ask-feedback mt-3 max-w-xl rounded-[14px] bg-[rgba(250,250,250,0.9)] px-4 py-2 text-[14px] leading-relaxed text-[#404040]">
        {ask.explanation}
      </div>
    ) : null;

  // 代码题：需要编辑器，用卡片
  if (ask.kind === "code") {
    return (
      <div className={`pointer-events-auto w-full max-w-3xl rounded-2xl px-5 py-4 ${pill}`}>
        <div className="flex items-start justify-between gap-3">
          <div className="text-[15px] font-semibold leading-relaxed text-[#1f1f1f]">{ask.question}</div>
          {!answered && (
            <button onClick={onSkip} disabled={busy} className="shrink-0 pt-0.5 text-[12px] text-[#a3a3a3] hover:text-[#525252] disabled:opacity-50">
              跳过
            </button>
          )}
        </div>
        <CodeBody ask={ask} busy={busy} onSubmit={onSubmit} />
        {feedback}
      </div>
    );
  }

  // 选择 / 一句话：题目直接写在白板下方（与字幕同一视觉层），选项是胶囊
  return (
    <div className="pointer-events-auto flex w-full max-w-3xl flex-col items-center text-center">
      <div className="inline rounded-[14px] bg-[rgba(250,250,250,0.86)] px-3.5 py-1.5 text-[16px] font-semibold leading-[1.7] text-[#1f1f1f] [box-decoration-break:clone] [-webkit-box-decoration-break:clone]">
        {ask.question}
      </div>
      {ask.kind === "choice" && <ChoiceBody ask={ask} busy={busy} onSubmit={onSubmit} />}
      {ask.kind === "open" && <OpenBody ask={ask} busy={busy} onSubmit={onSubmit} />}
      {feedback}
      {!answered && (
        <button onClick={onSkip} disabled={busy} className="mt-2.5 text-[12px] text-[#b5b5b5] hover:text-[#525252] disabled:opacity-50">
          跳过
        </button>
      )}
    </div>
  );
}

function ChoiceBody({ ask, busy, onSubmit }: { ask: AskState; busy: boolean; onSubmit: (a: AskSubmit) => void }) {
  const answered = ask.answered;
  return (
    <div className="mt-3 flex flex-wrap justify-center gap-2.5">
      {ask.options.map((o, i) => {
        const picked = answered?.text === o;
        const right = ask.correctIndex === i;
        const state = !answered ? "idle" : right ? "right" : picked ? "wrong" : "dim";
        return (
          <button
            key={i}
            disabled={Boolean(answered) || busy}
            onClick={() => onSubmit({ text: o, correct: ask.correctIndex == null ? undefined : right })}
            className={`flex min-h-10 items-center gap-2.5 rounded-full py-1.5 pl-1.5 pr-4 text-left text-[14px] transition ${
              state === "idle"
                ? "bg-white text-[#262626] shadow-[0_0_0_1px_rgba(0,0,0,0.08),0_2px_8px_rgba(0,0,0,0.04)] hover:shadow-[0_0_0_1.5px_rgba(0,0,0,0.35)]"
                : state === "right"
                  ? "bg-white text-[#1f1f1f] shadow-[0_0_0_1.5px_rgba(0,0,0,0.5)]"
                  : state === "wrong"
                    ? "bg-white text-[#737373] shadow-[0_0_0_1px_rgba(0,0,0,0.12)]"
                    : "bg-white/70 text-[#b5b5b5] shadow-[0_0_0_1px_rgba(0,0,0,0.05)]"
            }`}
          >
            <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-[#f4f4f4] text-[12px] font-semibold text-[#737373]">{LETTERS[i]}</span>
            <span className="relative">
              {o}
              {/* 讲师的红笔：对的那项打一个勾，选错的那项划一道 */}
              {state === "wrong" && (
                <svg className="ask-pen-mark pointer-events-none absolute left-[-4px] top-1/2 h-3 w-[calc(100%+8px)] -translate-y-1/2" viewBox="0 0 100 12" preserveAspectRatio="none" aria-hidden>
                  <path d="M2 8 C 30 4, 60 9, 98 3" pathLength={1} />
                </svg>
              )}
            </span>
            {state === "right" && (
              <svg className="ask-pen-mark -ml-1 h-5 w-5 shrink-0" viewBox="0 0 24 24" aria-hidden>
                <path d="M4 13 L9.5 18 L20 5" pathLength={1} />
              </svg>
            )}
          </button>
        );
      })}
    </div>
  );
}

function OpenBody({ ask, busy, onSubmit }: { ask: AskState; busy: boolean; onSubmit: (a: AskSubmit) => void }) {
  const [val, setVal] = useState("");
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    ref.current?.focus({ preventScroll: true });
  }, []);
  if (ask.answered) return <div className="mt-2 text-[13.5px] text-[#737373]">你的回答：{ask.answered.text}</div>;
  return (
    <div className="mt-3 flex w-full max-w-xl gap-2">
      <input
        ref={ref}
        value={val}
        onChange={(e) => setVal(e.target.value)}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === "Enter" && !e.nativeEvent.isComposing && val.trim()) onSubmit({ text: val.trim() });
        }}
        placeholder="一句话说说你的想法"
        className="min-w-0 flex-1 rounded-full bg-white px-4 py-2 text-[14px] shadow-[0_0_0_1px_rgba(0,0,0,0.08)] outline-none focus:shadow-[0_0_0_1.5px_rgba(0,0,0,0.35)]"
      />
      <button
        onClick={() => val.trim() && onSubmit({ text: val.trim() })}
        disabled={busy || !val.trim()}
        className="rounded-full bg-[#262626] px-5 text-[13px] font-medium text-white hover:opacity-90 disabled:opacity-25"
      >
        回答
      </button>
    </div>
  );
}

function CodeBody({ ask, busy, onSubmit }: { ask: AskState; busy: boolean; onSubmit: (a: AskSubmit) => void }) {
  const c = ask.code!;
  const [code, setCode] = useState(c.starter || "");
  const [running, setRunning] = useState(false);
  const [booting, setBooting] = useState(false);
  const [res, setRes] = useState<JudgeResult | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [fails, setFails] = useState(0);
  const [showSol, setShowSol] = useState(false);

  useEffect(() => {
    getPyodide().catch(() => {});
  }, []);

  const run = async () => {
    setRunning(true);
    setErr(null);
    try {
      setBooting(true);
      await getPyodide();
      setBooting(false);
      const r = await judgeCode(c.setup || "", code, c.solution || "");
      setRes(r);
      if (r.pass) {
        onSubmit({ text: "（代码题）", correct: true, code, output: r.learner.stdout });
      } else {
        setFails((n) => n + 1);
      }
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBooting(false);
      setRunning(false);
    }
  };

  const giveUp = () => {
    onSubmit({ text: "（代码题）", correct: false, code, output: res ? res.learner.stdout + (res.learner.error ? `\n${res.learner.error}` : "") : "" });
  };

  if (ask.answered && res?.pass) {
    return (
      <pre className="mt-3 max-h-40 overflow-auto rounded-lg bg-[#fafafa] px-3 py-2 font-mono text-[12.5px] leading-relaxed text-ink">{res.learner.stdout.trim()}</pre>
    );
  }

  return (
    <div className="mt-3">
      {c.setup && (
        <details className="mb-2 text-[12px] text-ink-faint">
          <summary className="cursor-pointer select-none hover:text-ink-soft">已准备好的数据</summary>
          <pre className="mt-1.5 max-h-36 overflow-auto rounded-lg bg-[#fafafa] px-3 py-2 font-mono text-[11.5px] leading-relaxed text-ink-soft">{c.setup}</pre>
        </details>
      )}
      <textarea
        value={code}
        onChange={(e) => setCode(e.target.value)}
        disabled={Boolean(ask.answered)}
        onKeyDown={(e) => {
          if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
            e.preventDefault();
            if (!running) void run();
          } else if (e.key === "Tab") {
            e.preventDefault();
            const ta = e.currentTarget;
            const s = ta.selectionStart;
            const next = code.slice(0, s) + "    " + code.slice(ta.selectionEnd);
            setCode(next);
            requestAnimationFrame(() => (ta.selectionStart = ta.selectionEnd = s + 4));
          }
          e.stopPropagation();
        }}
        spellCheck={false}
        rows={Math.min(12, Math.max(4, code.split("\n").length + 1))}
        className="block w-full resize-y rounded-xl bg-[#2c2c2a] px-4 py-3 font-mono text-[13px] leading-[1.65] text-[#f1efe8] outline-none focus:ring-2 focus:ring-accent/40"
      />
      {!ask.answered && (
        <div className="mt-2.5 flex flex-wrap items-center gap-3">
          <button onClick={() => void run()} disabled={running || busy} className="rounded-full bg-accent px-5 py-1.5 text-[13px] font-medium text-white hover:opacity-90 disabled:opacity-50">
            {booting ? "准备 Python 环境…" : running ? "运行中…" : "运行并检查"}
          </button>
          <span className="hidden text-[11.5px] text-ink-faint sm:inline">Ctrl + Enter</span>
          {fails >= 2 && !showSol && (
            <button onClick={() => setShowSol(true)} className="text-[12.5px] text-ink-soft hover:text-ink">
              看参考答案
            </button>
          )}
          {fails >= 1 && (
            <button onClick={giveUp} disabled={busy} className="text-[12.5px] text-ink-soft hover:text-ink">
              就这样，讲给我听
            </button>
          )}
        </div>
      )}
      {err && <div className="mt-2 rounded-lg bg-amber-50 px-3 py-2 text-[12.5px] text-amber-900">{err}</div>}
      {res && !res.pass && (
        <div className="mt-2.5 grid gap-2 sm:grid-cols-2">
          <div>
            <div className="text-[11.5px] text-ink-faint">你的输出</div>
            <pre className="mt-1 max-h-40 overflow-auto rounded-lg bg-[#fafafa] px-3 py-2 font-mono text-[12px] leading-relaxed text-ink">
              {res.learner.stdout.trim() || "（没有打印任何内容）"}
              {res.learner.error ? `\n${res.learner.error}` : ""}
            </pre>
          </div>
          <div>
            <div className="text-[11.5px] text-ink-faint">应该得到</div>
            <pre className="mt-1 max-h-40 overflow-auto rounded-lg bg-emerald-50/60 px-3 py-2 font-mono text-[12px] leading-relaxed text-ink">{res.expected || "（参考答案没有输出）"}</pre>
          </div>
        </div>
      )}
      {showSol && (
        <pre className="mt-2.5 overflow-x-auto rounded-lg bg-[#2c2c2a] px-3 py-2 font-mono text-[12px] leading-relaxed text-[#f1efe8]">{c.solution}</pre>
      )}
    </div>
  );
}
