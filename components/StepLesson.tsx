"use client";

// 分步学习课（样板）：学员自己掌握节奏。
// 一屏一列：开场 → 第 1 步（讲解 → 例子 → 动手）→ 做过练习才能"继续" → … → 小结 + 复习题。
// 学过的步骤留在上方可回看；当前步骤底部随时可以"没懂，问讲师"。
import { useEffect, useMemo, useRef, useState } from "react";
import { renderMarkdownToHtml } from "@/lib/board/markdown";
import { getPyodide, judgeCode, type JudgeResult } from "@/lib/lesson/pyodide";
import type { LessonPractice, LessonStep, StepLesson as Lesson } from "@/types/lesson";

interface Props {
  courseId: string;
  unitId: string;
  lectureId: string;
  lectureTitle: string;
  onExit: () => void;
}

const api = async <T,>(payload: Record<string, unknown>): Promise<T> => {
  const r = await fetch("/api/lesson", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.error || `请求失败（${r.status}）`);
  return d as T;
};

function Md({ text, className = "" }: { text: string; className?: string }) {
  const html = useMemo(() => renderMarkdownToHtml(text), [text]);
  return <div className={`md lesson-md ${className}`} dangerouslySetInnerHTML={{ __html: html }} />;
}

export function StepLesson({ courseId, unitId, lectureId, lectureTitle, onExit }: Props) {
  const ids = { courseId, unitId, lectureId };
  const progressKey = `lesson-progress:${courseId}:${lectureId}`;
  const [lesson, setLesson] = useState<Lesson | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [elapsed, setElapsed] = useState(0);
  /** 已解锁到第几步（steps.length = 小结） */
  const [reached, setReached] = useState(0);
  /** 每步练习是否已"做过"（答对，或看过答案） */
  const [done, setDone] = useState<Record<number, boolean>>({});
  const stepRefs = useRef<Record<number, HTMLElement | null>>({});

  const load = async (regenerate = false) => {
    setLoading(true);
    setError(null);
    setElapsed(0);
    try {
      const d = await api<{ lesson: Lesson }>({ action: "get", ...ids, regenerate });
      setLesson(d.lesson);
      if (regenerate) {
        setReached(0);
        setDone({});
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(progressKey) || "null");
      if (saved && typeof saved.reached === "number") {
        setReached(saved.reached);
        setDone(saved.done || {});
      }
    } catch {}
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!loading) return;
    const t = window.setInterval(() => setElapsed((s) => s + 1), 1000);
    return () => window.clearInterval(t);
  }, [loading]);

  useEffect(() => {
    try {
      localStorage.setItem(progressKey, JSON.stringify({ reached, done }));
    } catch {}
  }, [progressKey, reached, done]);

  // 有编程题就提前热身 Python 环境（约 10MB，首次 5-15 秒）
  useEffect(() => {
    if (lesson?.steps.some((s) => s.practice?.kind === "code")) getPyodide().catch(() => {});
  }, [lesson]);

  const goNext = (from: number) => {
    const next = from + 1;
    setReached((r) => Math.max(r, next));
    window.setTimeout(() => stepRefs.current[next]?.scrollIntoView({ behavior: "smooth", block: "start" }), 60);
  };

  if (loading || error || !lesson) {
    return (
      <div className="min-h-screen bg-white flex items-center justify-center px-6">
        <div className="max-w-sm text-center">
          {error ? (
            <>
              <div className="text-[15px] text-ink-soft">{error}</div>
              <div className="mt-5 flex justify-center gap-2">
                <button onClick={() => load()} className="rounded-full bg-accent px-5 py-2 text-[13px] font-medium text-white hover:opacity-90">重试</button>
                <button onClick={onExit} className="rounded-full border border-[#e4e4e7] px-5 py-2 text-[13px] text-ink-soft hover:text-ink">回课程页</button>
              </div>
            </>
          ) : (
            <>
              <span className="stage-spinner inline-block" style={{ width: 18, height: 18 }} />
              <div className="mt-4 text-[15px] text-ink">讲师正在备这节课</div>
              <div className="mt-1.5 text-[13px] text-ink-faint">
                {elapsed < 5 ? "《" + lectureTitle + "》" : `第一次备课约需 1 分钟，之后再来秒开 · ${elapsed}s`}
              </div>
            </>
          )}
        </div>
      </div>
    );
  }

  const total = lesson.steps.length;
  const finished = reached >= total;
  const pct = Math.round((Math.min(reached, total) / total) * 100);

  return (
    <div className="min-h-screen bg-white">
      {/* 顶栏：返回 · 标题 · 进度 */}
      <header className="sticky top-0 z-20 border-b border-[#f0f0f2] bg-white/95 backdrop-blur">
        <div className="mx-auto flex max-w-[760px] items-center gap-3 px-4 py-3 sm:px-6">
          <button onClick={onExit} className="shrink-0 text-[13px] text-ink-soft hover:text-ink">← 课程</button>
          <div className="min-w-0 flex-1 truncate text-center text-[13px] font-medium text-ink">{lesson.title}</div>
          <div className="shrink-0 text-[12px] tabular-nums text-ink-faint">
            {finished ? "已学完" : `${reached + 1} / ${total}`}
          </div>
        </div>
        <div className="h-[2px] bg-[#f4f4f5]">
          <div className="h-full bg-accent transition-all duration-500" style={{ width: `${pct}%` }} />
        </div>
      </header>

      <main className="mx-auto max-w-[760px] px-4 pb-40 pt-8 sm:px-6">
        {/* 开场 */}
        <section className="mb-10">
          <h1 className="text-[24px] font-bold leading-snug tracking-tight text-ink">{lesson.title}</h1>
          <p className="mt-3 text-[15.5px] leading-[1.85] text-ink-soft">{lesson.hook}</p>
          <div className="mt-4 rounded-xl bg-[#fafafa] px-4 py-3 text-[13.5px] text-ink">
            <span className="text-ink-faint">学完这节，你能：</span>
            {lesson.goal.replace(/^学完(这节|本节)?(课)?[，,]?(你)?(就)?(能|可以)?/, "")}
          </div>
        </section>

        {lesson.steps.slice(0, Math.min(reached, total - 1) + 1).map((step, i) => (
          <section
            key={i}
            ref={(el) => {
              stepRefs.current[i] = el;
            }}
            className="scroll-mt-20 border-t border-[#f0f0f2] pt-8 mb-10"
          >
            <StepBlock
              step={step}
              index={i}
              total={total}
              ids={ids}
              isCurrent={i === reached}
              done={!!done[i]}
              onDone={() => setDone((d) => ({ ...d, [i]: true }))}
              onNext={() => goNext(i)}
            />
          </section>
        ))}

        {finished && (
          <section
            ref={(el) => {
              stepRefs.current[total] = el;
            }}
            className="scroll-mt-20 border-t border-[#f0f0f2] pt-8"
          >
            <Recap lesson={lesson} onExit={onExit} onRestart={() => { setReached(0); setDone({}); window.scrollTo({ top: 0, behavior: "smooth" }); }} />
          </section>
        )}

        <div className="mt-16 text-center">
          <button
            onClick={() => {
              if (window.confirm("让讲师重新备这节课？当前进度会清空。")) load(true);
            }}
            className="text-[12px] text-ink-faint hover:text-ink-soft"
          >
            这节课讲得不好？让讲师重新备课
          </button>
        </div>
      </main>
    </div>
  );
}

/* ---------------- 单步 ---------------- */

function StepBlock({
  step,
  index,
  total,
  ids,
  isCurrent,
  done,
  onDone,
  onNext,
}: {
  step: LessonStep;
  index: number;
  total: number;
  ids: Record<string, string>;
  isCurrent: boolean;
  done: boolean;
  onDone: () => void;
  onNext: () => void;
}) {
  const p = step.practice;
  const canContinue = !p || done;
  const isLast = index === total - 1;

  return (
    <div>
      <div className="text-[12px] font-medium text-accent">第 {index + 1} 步</div>
      <h2 className="mt-1 text-[19px] font-semibold leading-snug text-ink">{step.title}</h2>
      <Md text={step.explain} className="mt-3 text-[15px] text-ink" />

      {step.example && (
        <div className="mt-6">
          <div className="mb-1 text-[12px] font-medium text-ink-faint">完整例子</div>
          <Md text={step.example} className="text-[14.5px] text-ink" />
        </div>
      )}

      {p && (
        <div className="mt-7 rounded-2xl border border-[#e4e4e7] p-4 sm:p-5">
          <div className="mb-2 flex items-center gap-2">
            <span className="text-[12px] font-medium text-ink-faint">动手试试</span>
            {done && <span className="text-[12px] text-emerald-600">✓ 已完成</span>}
          </div>
          <Practice practice={p} stepIndex={index} ids={ids} done={done} onDone={onDone} />
        </div>
      )}

      {isCurrent && <AskTutor stepIndex={index} ids={ids} />}

      {isCurrent && (
        <div className="mt-6 flex items-center gap-3">
          <button
            onClick={onNext}
            disabled={!canContinue}
            className="rounded-full bg-ink px-6 py-2.5 text-[14px] font-medium text-white transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-25"
          >
            {isLast ? "完成，看小结" : "继续"}
          </button>
          {!canContinue && <span className="text-[12.5px] text-ink-faint">先做完上面的练习</span>}
        </div>
      )}
    </div>
  );
}

/* ---------------- 练习 ---------------- */

function Practice(props: { practice: LessonPractice; stepIndex: number; ids: Record<string, string>; done: boolean; onDone: () => void }) {
  const { practice } = props;
  return (
    <div>
      <Md text={practice.prompt} className="text-[14.5px] text-ink" />
      <div className="mt-3">
        {practice.kind === "code" && <CodePractice {...props} />}
        {practice.kind === "choice" && <ChoicePractice {...props} />}
        {practice.kind === "fill" && <FillPractice {...props} />}
        {practice.kind === "explain" && <ExplainPractice {...props} />}
      </div>
    </div>
  );
}

function Feedback({ ok, children }: { ok: boolean; children: React.ReactNode }) {
  return (
    <div className={`mt-3 rounded-xl px-4 py-3 text-[13.5px] leading-relaxed ${ok ? "bg-emerald-50 text-emerald-900" : "bg-amber-50 text-amber-900"}`}>
      {children}
    </div>
  );
}

function HintButton({ hint }: { hint?: string }) {
  const [open, setOpen] = useState(false);
  if (!hint) return null;
  return open ? (
    <div className="mt-3 rounded-xl bg-[#fafafa] px-4 py-3 text-[13.5px] text-ink-soft">
      <span className="font-medium text-ink">提示：</span>
      {hint}
    </div>
  ) : (
    <button onClick={() => setOpen(true)} className="text-[13px] text-ink-soft hover:text-ink">
      要个提示
    </button>
  );
}

function CodePractice({ practice, done, onDone }: { practice: LessonPractice; done: boolean; onDone: () => void }) {
  const [code, setCode] = useState(practice.starter || "");
  const [running, setRunning] = useState(false);
  const [booting, setBooting] = useState(false);
  const [result, setResult] = useState<JudgeResult | null>(null);
  const [runErr, setRunErr] = useState<string | null>(null);
  const [showSolution, setShowSolution] = useState(false);
  const [fails, setFails] = useState(0);
  const taRef = useRef<HTMLTextAreaElement>(null);

  const lines = Math.max(4, code.split("\n").length + 1);

  const run = async () => {
    setRunning(true);
    setRunErr(null);
    try {
      setBooting(true);
      await getPyodide();
      setBooting(false);
      const r = await judgeCode(practice.setup || "", code, practice.solution || "");
      setResult(r);
      if (r.pass) onDone();
      else setFails((n) => n + 1);
    } catch (e) {
      setRunErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBooting(false);
      setRunning(false);
    }
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
      e.preventDefault();
      if (!running) run();
      return;
    }
    if (e.key === "Tab") {
      e.preventDefault();
      const ta = e.currentTarget;
      const { selectionStart: s, selectionEnd: en } = ta;
      const next = code.slice(0, s) + "    " + code.slice(en);
      setCode(next);
      requestAnimationFrame(() => {
        ta.selectionStart = ta.selectionEnd = s + 4;
      });
    }
  };

  return (
    <div>
      {practice.setup && (
        <details className="mb-2 text-[12.5px] text-ink-faint">
          <summary className="cursor-pointer select-none hover:text-ink-soft">已经准备好的数据（点开看）</summary>
          <pre className="mt-2 overflow-x-auto rounded-lg bg-[#fafafa] px-3 py-2 font-mono text-[12px] leading-relaxed text-ink-soft">{practice.setup}</pre>
        </details>
      )}
      <textarea
        ref={taRef}
        value={code}
        onChange={(e) => setCode(e.target.value)}
        onKeyDown={onKeyDown}
        spellCheck={false}
        rows={lines}
        className="block w-full resize-y rounded-xl bg-[#2c2c2a] px-4 py-3 font-mono text-[13px] leading-[1.65] text-[#f1efe8] outline-none focus:ring-2 focus:ring-accent/40"
      />
      <div className="mt-3 flex flex-wrap items-center gap-3">
        <button
          onClick={run}
          disabled={running}
          className="rounded-full bg-accent px-5 py-2 text-[13px] font-medium text-white hover:opacity-90 disabled:opacity-50"
        >
          {booting ? "准备 Python 环境…" : running ? "运行中…" : "运行并检查"}
        </button>
        <span className="hidden text-[12px] text-ink-faint sm:inline">Ctrl + Enter</span>
        <HintButton hint={practice.hint} />
        {(fails >= 2 || done) && !showSolution && (
          <button onClick={() => { setShowSolution(true); onDone(); }} className="text-[13px] text-ink-soft hover:text-ink">
            看参考答案
          </button>
        )}
      </div>

      {runErr && <Feedback ok={false}>{runErr}</Feedback>}

      {result && (
        <div className="mt-3">
          <div className="text-[12px] text-ink-faint">你的输出</div>
          <pre className="mt-1 max-h-72 overflow-auto rounded-lg bg-[#fafafa] px-3 py-2 font-mono text-[12.5px] leading-relaxed text-ink">
            {result.learner.stdout.trim() || "（没有打印任何内容）"}
          </pre>
          {result.learner.error && (
            <pre className="mt-2 overflow-x-auto rounded-lg bg-red-50 px-3 py-2 font-mono text-[12px] leading-relaxed text-red-800">{result.learner.error}</pre>
          )}
          {result.pass ? (
            <Feedback ok>
              <div className="font-medium">对了。</div>
              <div className="mt-1">{practice.explanation}</div>
            </Feedback>
          ) : (
            <Feedback ok={false}>
              {result.learner.error
                ? "代码报错了，看看上面红色的最后一行，它通常直接说明了哪里不对。"
                : result.expected
                  ? "输出和预期不一样，对比一下："
                  : "参考答案自己没跑出结果，这道题出得有问题，可以直接看参考答案继续。"}
              {!result.learner.error && result.expected && (
                <pre className="mt-2 max-h-60 overflow-auto rounded-lg bg-white/70 px-3 py-2 font-mono text-[12.5px] leading-relaxed text-ink">{result.expected}</pre>
              )}
            </Feedback>
          )}
        </div>
      )}

      {showSolution && (
        <div className="mt-3">
          <div className="text-[12px] text-ink-faint">参考答案</div>
          <pre className="mt-1 overflow-x-auto rounded-lg bg-[#2c2c2a] px-3 py-2 font-mono text-[12.5px] leading-relaxed text-[#f1efe8]">{practice.solution}</pre>
          <div className="mt-2 text-[13.5px] leading-relaxed text-ink-soft">{practice.explanation}</div>
        </div>
      )}
    </div>
  );
}

function ChoicePractice({ practice, onDone }: { practice: LessonPractice; onDone: () => void }) {
  const [picked, setPicked] = useState<number | null>(null);
  const correct = practice.answerIndex ?? 0;
  return (
    <div>
      <div className="flex flex-col gap-2">
        {(practice.options || []).map((opt, i) => {
          const state = picked === null ? "idle" : i === correct ? "right" : i === picked ? "wrong" : "dim";
          return (
            <button
              key={i}
              disabled={picked !== null}
              onClick={() => {
                setPicked(i);
                onDone();
              }}
              className={`rounded-xl border px-4 py-2.5 text-left text-[14px] transition-colors ${
                state === "idle"
                  ? "border-[#e4e4e7] hover:border-accent"
                  : state === "right"
                    ? "border-emerald-400 bg-emerald-50 text-emerald-900"
                    : state === "wrong"
                      ? "border-amber-400 bg-amber-50 text-amber-900"
                      : "border-[#f0f0f2] text-ink-faint"
              }`}
            >
              <span className="mr-2 text-ink-faint">{String.fromCharCode(65 + i)}.</span>
              {opt}
            </button>
          );
        })}
      </div>
      {picked === null ? (
        <div className="mt-3"><HintButton hint={practice.hint} /></div>
      ) : (
        <Feedback ok={picked === correct}>
          <div className="font-medium">{picked === correct ? "对了。" : `正确答案是 ${String.fromCharCode(65 + correct)}。`}</div>
          <div className="mt-1">{practice.explanation}</div>
        </Feedback>
      )}
    </div>
  );
}

const normFill = (s: string) => s.replace(/\s+/g, "").replace(/[，。]/g, "").toLowerCase();

function FillPractice({ practice, done, onDone }: { practice: LessonPractice; done: boolean; onDone: () => void }) {
  const [val, setVal] = useState("");
  const [state, setState] = useState<"idle" | "right" | "wrong">("idle");
  const [fails, setFails] = useState(0);
  const answers = (practice.answer || "").split("|").map(normFill).filter(Boolean);
  const check = () => {
    if (!val.trim()) return;
    if (answers.includes(normFill(val))) {
      setState("right");
      onDone();
    } else {
      setState("wrong");
      setFails((n) => n + 1);
    }
  };
  return (
    <div>
      <div className="flex gap-2">
        <input
          value={val}
          onChange={(e) => setVal(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && check()}
          disabled={state === "right"}
          placeholder="你的答案"
          className="min-w-0 flex-1 rounded-xl border border-[#e4e4e7] px-4 py-2 text-[14px] outline-none focus:border-accent"
        />
        <button onClick={check} disabled={state === "right"} className="rounded-full bg-accent px-5 text-[13px] font-medium text-white hover:opacity-90 disabled:opacity-50">
          检查
        </button>
      </div>
      <div className="mt-3 flex gap-3">
        {state !== "right" && <HintButton hint={practice.hint} />}
        {fails >= 2 && !done && (
          <button onClick={() => { setState("right"); onDone(); }} className="text-[13px] text-ink-soft hover:text-ink">
            看答案
          </button>
        )}
      </div>
      {state === "wrong" && <Feedback ok={false}>还不对，再想想。</Feedback>}
      {state === "right" && (
        <Feedback ok>
          <div className="font-medium">答案：{(practice.answer || "").split("|")[0]}</div>
          <div className="mt-1">{practice.explanation}</div>
        </Feedback>
      )}
    </div>
  );
}

function ExplainPractice({ practice, stepIndex, ids, onDone }: { practice: LessonPractice; stepIndex: number; ids: Record<string, string>; onDone: () => void }) {
  const [val, setVal] = useState("");
  const [busy, setBusy] = useState(false);
  const [res, setRes] = useState<{ pass: boolean; feedback: string } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const submit = async () => {
    setBusy(true);
    setErr(null);
    try {
      const r = await api<{ pass: boolean; feedback: string }>({ action: "grade", ...ids, stepIndex, answer: val });
      setRes(r);
      onDone();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div>
      <textarea
        value={val}
        onChange={(e) => setVal(e.target.value)}
        rows={4}
        placeholder="用你自己的话说说看，不用写得很正式"
        className="block w-full resize-y rounded-xl border border-[#e4e4e7] px-4 py-3 text-[14px] leading-relaxed outline-none focus:border-accent"
      />
      <div className="mt-3 flex items-center gap-3">
        <button onClick={submit} disabled={busy || !val.trim()} className="rounded-full bg-accent px-5 py-2 text-[13px] font-medium text-white hover:opacity-90 disabled:opacity-50">
          {busy ? "讲师在看…" : "交给讲师看"}
        </button>
        <HintButton hint={practice.hint} />
      </div>
      {err && <Feedback ok={false}>{err}</Feedback>}
      {res && (
        <Feedback ok={res.pass}>
          <div>{res.feedback}</div>
          <div className="mt-2 text-[12.5px] opacity-80">{practice.explanation}</div>
        </Feedback>
      )}
    </div>
  );
}

/* ---------------- 问讲师 ---------------- */

function AskTutor({ stepIndex, ids }: { stepIndex: number; ids: Record<string, string> }) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [busy, setBusy] = useState(false);
  const [thread, setThread] = useState<{ q: string; a: string }[]>([]);
  const [err, setErr] = useState<string | null>(null);

  const ask = async () => {
    const question = q.trim();
    if (!question) return;
    setBusy(true);
    setErr(null);
    try {
      const r = await api<{ reply: string }>({ action: "ask", ...ids, stepIndex, question });
      setThread((t) => [...t, { q: question, a: r.reply }]);
      setQ("");
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  if (!open && !thread.length) {
    return (
      <button onClick={() => setOpen(true)} className="mt-5 text-[13px] text-ink-soft underline decoration-[#d4d4d8] underline-offset-4 hover:text-ink">
        这一步没看懂？问讲师
      </button>
    );
  }
  return (
    <div className="mt-5 rounded-2xl bg-[#fafafa] p-4">
      {thread.map((t, i) => (
        <div key={i} className="mb-4">
          <div className="text-[13px] text-ink-soft">你：{t.q}</div>
          <Md text={t.a} className="mt-1.5 text-[14px] text-ink" />
        </div>
      ))}
      <div className="flex gap-2">
        <input
          value={q}
          autoFocus
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && !busy && ask()}
          placeholder="哪里没懂？比如：为什么这里用中位数不用平均数"
          className="min-w-0 flex-1 rounded-xl border border-[#e4e4e7] bg-white px-4 py-2 text-[14px] outline-none focus:border-accent"
        />
        <button onClick={ask} disabled={busy || !q.trim()} className="rounded-full bg-ink px-5 text-[13px] font-medium text-white hover:opacity-90 disabled:opacity-40">
          {busy ? "…" : "问"}
        </button>
      </div>
      {err && <div className="mt-2 text-[12.5px] text-amber-700">{err}</div>}
    </div>
  );
}

/* ---------------- 小结 ---------------- */

function Recap({ lesson, onExit, onRestart }: { lesson: Lesson; onExit: () => void; onRestart: () => void }) {
  const [shown, setShown] = useState<Record<number, boolean>>({});
  return (
    <div>
      <div className="text-[12px] font-medium text-accent">小结</div>
      <h2 className="mt-1 text-[19px] font-semibold text-ink">这节课你学会了</h2>
      <ul className="mt-3 space-y-2">
        {lesson.recap.points.map((p, i) => (
          <li key={i} className="flex gap-2.5 text-[15px] leading-relaxed text-ink">
            <span className="mt-[9px] h-1.5 w-1.5 shrink-0 rounded-full bg-accent" />
            <span>{p}</span>
          </li>
        ))}
      </ul>

      <h3 className="mt-8 text-[15px] font-semibold text-ink">自测一下</h3>
      <p className="mt-1 text-[13px] text-ink-faint">先在心里答，再点开对答案。过两三天回来再做一遍，记得最牢。</p>
      <div className="mt-3 space-y-2">
        {lesson.recap.review.map((r, i) => (
          <div key={i} className="rounded-xl border border-[#e4e4e7] px-4 py-3">
            <div className="text-[14px] text-ink">{r.q}</div>
            {shown[i] ? (
              <div className="mt-2 text-[13.5px] leading-relaxed text-ink-soft">{r.a}</div>
            ) : (
              <button onClick={() => setShown((s) => ({ ...s, [i]: true }))} className="mt-1.5 text-[12.5px] text-accent hover:underline">
                看答案
              </button>
            )}
          </div>
        ))}
      </div>

      <div className="mt-8 flex gap-3">
        <button onClick={onExit} className="rounded-full bg-ink px-6 py-2.5 text-[14px] font-medium text-white hover:opacity-90">回课程页</button>
        <button onClick={onRestart} className="rounded-full border border-[#e4e4e7] px-6 py-2.5 text-[14px] text-ink-soft hover:text-ink">从头再学一遍</button>
      </div>
    </div>
  );
}
