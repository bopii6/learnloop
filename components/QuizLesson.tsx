"use client";

// 单元测验课节：quiz 课节的真实体验。5 道场景化题覆盖整个单元，
// 60% 过关；答案在服务端判分（前端拿不到），交卷后逐题对答案看解析。
// 题目生成后缓存：重考用同一套题，考不过再考是学习的一部分。
import { useEffect, useState } from "react";
import type { CourseLecture, CourseOutline, UnitQuizItem } from "@/types";

interface QuizLessonProps {
  courseId: string;
  outline: CourseOutline;
  unitId: string;
  lecture: CourseLecture;
  onExit: () => void;
}

interface QuizQuestion extends Omit<UnitQuizItem, "answerIndexes"> {}

type Phase = "loading" | "intro" | "answering" | "graded";

export function QuizLesson({ courseId, outline, lecture, onExit }: QuizLessonProps) {
  const [phase, setPhase] = useState<Phase>("loading");
  const [quiz, setQuiz] = useState<QuizQuestion[]>([]);
  const [passedBefore, setPassedBefore] = useState(false);
  const [answers, setAnswers] = useState<number[][]>([]);
  const [starting, setStarting] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [result, setResult] = useState<{ score: number; total: number; passed: boolean; firstPass: boolean } | null>(
    null
  );
  const [review, setReview] = useState<UnitQuizItem[]>([]);

  useEffect(() => {
    let alive = true;
    // 进入时查档案：出过题就直接开考（重考免费），没出过停在 intro
    fetch(`/api/quiz?courseId=${encodeURIComponent(courseId)}&lectureId=${encodeURIComponent(lecture.id)}`)
      .then((r) => r.json())
      .then((d) => {
        if (!alive) return;
        if (d?.record?.quiz) {
          setQuiz(d.record.quiz);
          setPassedBefore(Boolean(d.record.passed));
          setAnswers(d.record.quiz.map(() => []));
          setPhase("answering");
        } else {
          setPhase("intro");
        }
      })
      .catch(() => alive && setPhase("intro"));
    return () => {
      alive = false;
    };
  }, [courseId, lecture.id]);

  const startQuiz = async () => {
    setStarting(true);
    setMsg(null);
    try {
      const res = await fetch("/api/quiz", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "start", courseId, lectureId: lecture.id }),
      });
      const d = await res.json();
      if (!res.ok) {
        setMsg(d?.error || "出题失败，稍后再试");
        return;
      }
      setQuiz(d.quiz);
      setAnswers(d.quiz.map(() => []));
      setPhase("answering");
    } catch {
      setMsg("网络异常，稍后再试");
    } finally {
      setStarting(false);
    }
  };

  const toggleOption = (qi: number, oi: number) => {
    setAnswers((prev) => {
      const next = prev.map((a) => [...a]);
      const cur = next[qi] || [];
      if (quiz[qi]?.multi) {
        next[qi] = cur.includes(oi) ? cur.filter((x) => x !== oi) : [...cur, oi];
      } else {
        next[qi] = cur.includes(oi) ? [] : [oi];
      }
      return next;
    });
  };

  const submit = async () => {
    const answered = answers.filter((a) => a.length > 0).length;
    if (answered < quiz.length) {
      setMsg(`还有 ${quiz.length - answered} 题没作答，做完再交卷。`);
      return;
    }
    setSubmitting(true);
    setMsg(null);
    try {
      const res = await fetch("/api/quiz", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "submit", courseId, lectureId: lecture.id, answers }),
      });
      const d = await res.json();
      if (!res.ok) {
        setMsg(d?.error || "判分失败，稍后再试");
        return;
      }
      setResult({ score: d.score, total: d.total, passed: d.passed, firstPass: d.firstPass });
      setReview(d.review || []);
      setPhase("graded");
      if (d.passed && !passedBefore) {
        // 首次过关：让课程页/记录页刷新徽章
        window.dispatchEvent(new CustomEvent("ll:courses-changed"));
      }
    } catch {
      setMsg("网络异常，稍后再试");
    } finally {
      setSubmitting(false);
    }
  };

  const backToCourse = () => {
    onExit();
  };

  return (
    <div className="min-h-screen bg-[#fafafa] text-ink">
      {/* 顶栏 */}
      <div className="sticky top-0 z-10 border-b border-[#e4e4e7] bg-[#fafafa]/95 backdrop-blur">
        <div className="max-w-3xl mx-auto px-5 h-14 flex items-center gap-3">
          <button
            onClick={backToCourse}
            className="rounded-full border border-[#d4d4d8] bg-white px-3.5 py-1.5 text-[12px] text-ink-soft hover:border-accent hover:text-accent transition-colors"
          >
            ← 返回课程
          </button>
          <div className="flex-1 text-center text-[13px] font-semibold tracking-wide">📝 单元测验</div>
          <div className="w-20 text-right text-[11px] text-ink-faint truncate" title={outline.title}>
            {outline.title}
          </div>
        </div>
      </div>

      <div className="max-w-3xl mx-auto px-5 py-8 space-y-4 fade-up">
        <div className="rounded-2xl border border-accent/25 bg-white px-6 py-5">
          <div className="text-[11.5px] text-accent font-semibold tracking-wide mb-1.5">
            {lecture.title}
          </div>
          <div className="text-[18px] font-bold leading-snug">
            {phase === "graded" && result
              ? result.passed
                ? result.firstPass
                  ? `🎉 一次过关：${result.score}/${result.total}`
                  : `🎉 过关了：${result.score}/${result.total}`
                : `还差一点：${result.score}/${result.total}`
              : "检验一下：这个单元你真的会用了吗？"}
          </div>
          <div className="text-[12.5px] text-ink-soft mt-1.5 leading-relaxed">
            {quiz.length > 0
              ? `${quiz.length} 道场景题，覆盖本单元不同课节 · 60% 过关 · 过关免费重考`
              : "5 道场景题，覆盖本单元不同课节 · 60% 过关 · 重考免费"}
          </div>
          {passedBefore && phase !== "graded" && (
            <div className="mt-2 inline-block rounded-full bg-accent-soft px-2.5 py-1 text-[11px] text-accent font-medium">
              ✓ 你已通过本测验（随时免费重考巩固）
            </div>
          )}
        </div>

        {phase === "loading" && (
          <div className="rounded-2xl border border-[#e4e4e7] bg-white px-6 py-10 text-center">
            <span className="stage-spinner inline-block" style={{ width: 18, height: 18 }} />
          </div>
        )}

        {phase === "intro" && (
          <div className="rounded-2xl border border-[#e4e4e7] bg-white px-6 py-8 text-center">
            <div className="text-[13px] text-ink-soft leading-relaxed max-w-md mx-auto">
              题目按本单元的课节内容现出——不是题库抽题。考的是场景判断，
              做对的标准是「换个情境你还认得出这个概念」。
            </div>
            <button
              onClick={() => void startQuiz()}
              disabled={starting}
              className="mt-5 rounded-full bg-accent px-6 py-2.5 text-[13px] text-white font-medium hover:opacity-90 disabled:opacity-50"
            >
              {starting ? "讲师正在按你的单元出题…" : "开始测验"}
            </button>
            {msg && <div className="text-[12px] text-red-600 mt-3">{msg}</div>}
          </div>
        )}

        {(phase === "answering" || phase === "graded") && (
          <div className="space-y-3">
            {quiz.map((q, qi) => {
              const item = phase === "graded" ? review[qi] : null;
              const myAnswer = answers[qi] || [];
              const correctSet = new Set(item?.answerIndexes || []);
              const isCorrect =
                item &&
                [...correctSet].sort().join(",") === [...myAnswer].sort().join(",") &&
                myAnswer.length > 0;
              return (
                <div key={qi} className="rounded-2xl border border-[#e4e4e7] bg-white px-6 py-5">
                  <div className="flex gap-2.5">
                    <span className="shrink-0 w-6 h-6 rounded-full bg-[#f4f4f5] text-ink-soft text-[11px] flex items-center justify-center font-semibold">
                      {qi + 1}
                    </span>
                    <div className="text-[13.5px] font-medium leading-relaxed">{q.question}</div>
                  </div>
                  <div className="mt-3 space-y-2 pl-8">
                    {q.options.map((opt, oi) => {
                      const chosen = myAnswer.includes(oi);
                      const showCorrect = phase === "graded" && correctSet.has(oi);
                      const showWrong = phase === "graded" && chosen && !correctSet.has(oi);
                      return (
                        <button
                          key={oi}
                          onClick={() => phase === "answering" && toggleOption(qi, oi)}
                          disabled={phase !== "answering"}
                          className={`w-full text-left rounded-xl border px-3.5 py-2.5 text-[12.5px] flex items-center gap-2.5 transition-colors ${
                            phase === "graded"
                              ? showCorrect
                                ? "border-emerald-300 bg-emerald-50"
                                : showWrong
                                  ? "border-red-300 bg-red-50"
                                  : "border-[#e4e4e7] bg-white"
                              : chosen
                                ? "border-accent bg-accent/5"
                                : "border-[#e4e4e7] bg-white hover:border-[#c9c7bd]"
                          } ${phase === "answering" ? "cursor-pointer" : "cursor-default"}`}
                        >
                          <span
                            className={`shrink-0 w-5 h-5 rounded-full border flex items-center justify-center text-[9px] font-bold ${
                              chosen || showCorrect
                                ? showWrong
                                  ? "border-red-400 text-red-500"
                                  : "bg-accent border-accent text-white"
                                : "border-[#d4d4d8] text-ink-faint"
                            } ${q.multi ? "rounded-md" : ""}`}
                          >
                            {chosen || showCorrect ? (showWrong ? "✗" : "✓") : String.fromCharCode(65 + oi)}
                          </span>
                          {opt}
                        </button>
                      );
                    })}
                  </div>
                  {phase === "graded" && item && (
                    <div
                      className={`mt-3 ml-8 rounded-lg px-3.5 py-2.5 text-[12px] leading-relaxed ${
                        isCorrect ? "bg-emerald-50 text-emerald-800" : "bg-amber-50 text-amber-800"
                      }`}
                    >
                      {isCorrect ? "✓ 答对了。" : `✗ 正确答案：${(item.answerIndexes || [])
                        .map((i) => String.fromCharCode(65 + i))
                        .join("、")}。`}
                      {item.explain}
                    </div>
                  )}
                </div>
              );
            })}

            {phase === "answering" ? (
              <div className="pt-2 flex items-center gap-3">
                <button
                  onClick={() => void submit()}
                  disabled={submitting}
                  className="rounded-full bg-accent px-6 py-2.5 text-[13px] text-white font-medium hover:opacity-90 disabled:opacity-50"
                >
                  {submitting ? "判分中…" : "交卷"}
                </button>
                <span className="text-[11.5px] text-ink-faint">交卷后逐题对答案、看解析；不过可以免费重考。</span>
              </div>
            ) : (
              <div className="pt-2 flex flex-wrap items-center gap-3">
                {result?.passed ? (
                  <button
                    onClick={backToCourse}
                    className="rounded-full bg-accent px-6 py-2.5 text-[13px] text-white font-medium hover:opacity-90"
                  >
                    继续 → 回课程
                  </button>
                ) : (
                  <button
                    onClick={() => {
                      setAnswers(quiz.map(() => []));
                      setResult(null);
                      setReview([]);
                      setPhase("answering");
                    }}
                    className="rounded-full border border-accent/50 text-accent px-5 py-2.5 text-[13px] font-medium hover:bg-accent/5 transition-colors"
                  >
                    🔄 免费重考
                  </button>
                )}
                {!result?.passed && (
                  <button
                    onClick={backToCourse}
                    className="rounded-full border border-[#d4d4d8] px-5 py-2.5 text-[13px] text-ink-soft hover:border-accent hover:text-accent transition-colors"
                  >
                    先回课程复习
                  </button>
                )}
              </div>
            )}
            {phase === "answering" && msg && <div className="text-[12px] text-red-600">{msg}</div>}
          </div>
        )}
      </div>
    </div>
  );
}
