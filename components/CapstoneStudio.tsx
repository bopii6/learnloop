"use client";

// 结课作品工坊：project 课节的真实体验。
// 产品的铁律是"每门课必须有结课作品"——学员不是听完就走，而是带着一个自己做出的东西离开。
// 流程：生成任务书（因人而异）→ 按步骤动手做 → 提交作品 → 导师对照做成标准逐条验收 → 通过即结课。
import { useCallback, useEffect, useMemo, useState } from "react";
import type { CapstoneRecord, CourseLecture, CourseOutline } from "@/types";
import { OutOfCredits } from "./OutOfCredits";

interface CapstoneStudioProps {
  courseId: string;
  outline: CourseOutline;
  unitId: string;
  lecture: CourseLecture;
  onExit: () => void;
}

type BriefState = "idle" | "loading" | "error";
type ReviewState = "idle" | "loading" | "error";

export function CapstoneStudio({ courseId, outline, lecture, onExit }: CapstoneStudioProps) {
  const capstone = outline.capstone;
  const capstoneName = capstone?.name || lecture.title;

  const [record, setRecord] = useState<CapstoneRecord | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [studentName, setStudentName] = useState<string>("");
  const [briefState, setBriefState] = useState<BriefState>("idle");
  const [briefMsg, setBriefMsg] = useState<string | null>(null);
  const [regenConfirm, setRegenConfirm] = useState(false);

  const [submission, setSubmission] = useState("");
  const [workLink, setWorkLink] = useState("");
  const [reviewState, setReviewState] = useState<ReviewState>("idle");
  const [reviewMsg, setReviewMsg] = useState<string | null>(null);

  // 步骤勾选：动手做时的进度感，存本地（作品本身跟账号走）
  const [doneSteps, setDoneSteps] = useState<Set<number>>(new Set());
  const stepsKey = `ll-capstone-steps-${courseId}`;

  useEffect(() => {
    let alive = true;
    fetch(`/api/capstone?courseId=${encodeURIComponent(courseId)}`)
      .then((r) => r.json())
      .then((d) => {
        if (alive) setRecord(d.record || null);
      })
      .catch(() => {})
      .finally(() => alive && setLoaded(true));
    fetch("/api/profile")
      .then((r) => r.json())
      .then((d) => {
        if (alive && d?.profile?.name) setStudentName(d.profile.name);
      })
      .catch(() => {});
    try {
      const raw = localStorage.getItem(stepsKey);
      if (raw) setDoneSteps(new Set(JSON.parse(raw) as number[]));
    } catch {
      // 无勾选记录
    }
    return () => {
      alive = false;
    };
  }, [courseId, stepsKey]);

  const toggleStep = (i: number) => {
    setDoneSteps((prev) => {
      const next = new Set(prev);
      if (next.has(i)) next.delete(i);
      else next.add(i);
      try {
        localStorage.setItem(stepsKey, JSON.stringify([...next]));
      } catch {
        // 存不上也无妨，刷新重来
      }
      return next;
    });
  };

  const [creditsBlock, setCreditsBlock] = useState<{ what: string; need: number; balance: number; retry: "brief" | "review" } | null>(null);

  const runBrief = async () => {
    setBriefState("loading");
    setBriefMsg(null);
    setCreditsBlock(null);
    try {
      const res = await fetch("/api/capstone", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "brief", courseId, lectureId: lecture.id }),
      });
      const d = await res.json();
      if (!res.ok) {
        if (d?.error === "credits_block") setCreditsBlock({ what: "生成结课任务书", need: d.need, balance: d.balance, retry: "brief" });
        else setBriefMsg(d?.error || "生成失败，稍后再试");
        setBriefState("error");
        return;
      }
      setRecord(d.record);
      setBriefState("idle");
    } catch {
      setBriefMsg("网络异常，稍后再试");
      setBriefState("error");
    }
  };

  const submitWork = async () => {
    if (submission.trim().length < 20) {
      setReviewMsg("多写一点：做了什么、怎么做的、结果如何（至少 20 字），导师才能对照标准验收。");
      setReviewState("error");
      return;
    }
    setReviewState("loading");
    setReviewMsg(null);
    setCreditsBlock(null);
    try {
      const res = await fetch("/api/capstone", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "review",
          courseId,
          lectureId: lecture.id,
          text: submission.trim(),
          link: workLink.trim() || undefined,
        }),
      });
      const d = await res.json();
      if (!res.ok) {
        if (d?.error === "credits_block") setCreditsBlock({ what: "验收这份作品", need: d.need, balance: d.balance, retry: "review" });
        else setReviewMsg(d?.error || "验收失败，稍后再试");
        setReviewState("error");
        return;
      }
      setRecord(d.record);
      setSubmission("");
      setWorkLink("");
      setReviewState("idle");
    } catch {
      setReviewMsg("网络异常，稍后再试");
      setReviewState("error");
    }
  };

  const brief = record?.brief;
  const lastReview = record?.submissions?.[0]?.review;
  const passed = Boolean(record?.passed);

  const phase = useMemo(() => {
    if (passed) return 3;
    if (lastReview) return 2.5;
    if (brief) return 2;
    return 1;
  }, [passed, lastReview, brief]);

  const exitLabel = "返回课程";

  return (
    <div className="min-h-screen bg-sunken text-ink">
      {/* 顶栏 */}
      <div className="sticky top-0 z-10 border-b border-line bg-sunken/95 backdrop-blur">
        <div className="max-w-4xl mx-auto px-5 h-14 flex items-center gap-3">
          <button
            onClick={onExit}
            className="rounded-full border border-line-strong bg-white px-3.5 py-1.5 text-[13px] text-ink-soft hover:border-accent hover:text-accent transition-colors"
          >
            ← {exitLabel}
          </button>
          <div className="flex-1 text-center text-[14px] font-semibold tracking-wide">
            🏆 结课作品工坊
          </div>
          <div className="w-20 text-right text-[12px] text-ink-faint truncate" title={outline.title}>
            {outline.title}
          </div>
        </div>
      </div>

      <div className="max-w-4xl mx-auto px-5 py-8 space-y-5 fade-up">
        {/* 作品宣言 */}
        <div className="rounded-2xl border border-accent/25 bg-white px-6 py-5">
          <div className="text-[12.5px] text-accent font-semibold tracking-wide mb-1.5">
            结课作品 · 这门课的终点不是听完，是做出它
          </div>
          <div className="text-[20px] font-bold leading-snug">{capstoneName}</div>
          {(capstone?.description || lecture.summary) && (
            <div className="text-[14px] text-ink-soft mt-1.5 leading-relaxed">
              {capstone?.description || lecture.summary}
            </div>
          )}
          {/* 三阶段进度 */}
          <div className="mt-4 flex items-center gap-1.5 text-[12.5px]">
            {[
              { n: 1, label: "领任务书" },
              { n: 2, label: "动手做" },
              { n: 3, label: "验收结课" },
            ].map((s, i) => (
              <div key={s.n} className="flex items-center gap-1.5">
                {i > 0 && <span className="text-line-strong mx-1">→</span>}
                <span
                  className={`rounded-full px-2.5 py-1 font-medium ${
                    phase >= s.n ? "bg-accent text-white" : "bg-sunken text-ink-faint"
                  }`}
                >
                  {s.n >= 3 && passed ? "🎉 " : ""}
                  {s.label}
                </span>
              </div>
            ))}
          </div>
        </div>

        {/* 结课认证（通过后置顶展示） */}
        {passed && lastReview && (
          <div className="rounded-2xl border-2 border-accent/50 bg-gradient-to-b from-accent/5 via-white to-white px-6 py-6 relative overflow-hidden">
            <div className="absolute top-3 right-4 text-[44px] opacity-90 select-none">🏆</div>
            <div className="text-[12px] text-accent font-semibold tracking-[0.2em] uppercase">Certified · 结课认证</div>
            <div className="text-[17px] font-bold mt-2 leading-snug">
              {studentName ? `${studentName} 已经做出` : "已做出"}
              「{capstoneName}」
            </div>
            <div className="text-[13.5px] text-ink-soft mt-1">
              《{outline.title}》 · {new Date(record?.passedAt || Date.now()).toLocaleDateString("zh-CN")}
            </div>
            {lastReview.overall && (
              <div className="text-[13.5px] text-ink-soft mt-3 leading-relaxed border-l-2 border-accent/40 pl-3">
                导师评语：{lastReview.overall}
              </div>
            )}
            <div className="mt-3 flex flex-wrap gap-1.5">
              {(brief?.criteriaCheck.length ? brief.criteriaCheck.map((c) => c.text) : capstone?.criteria || []).map(
                (c, i) => (
                  <span
                    key={i}
                    className="rounded-full bg-accent-soft px-2.5 py-1 text-[12px] text-accent font-medium"
                  >
                    ✓ {c.length > 26 ? `${c.slice(0, 26)}…` : c}
                  </span>
                )
              )}
            </div>
            <div className="text-[12px] text-ink-faint mt-3">认证随账号保存，课程记录页可见 🏆 徽章。</div>
          </div>
        )}

        {/* 任务书 */}
        {!loaded ? (
          <div className="rounded-2xl border border-line bg-white px-6 py-10 text-center">
            <span className="stage-spinner inline-block" style={{ width: 18, height: 18 }} />
          </div>
        ) : !brief ? (
          <div className="rounded-2xl border border-line bg-white px-6 py-8 text-center">
            <div className="text-[15px] font-semibold">第一步：领你的专属任务书</div>
            <div className="text-[13.5px] text-ink-soft mt-1.5 leading-relaxed max-w-md mx-auto">
              导师按这门课的做成标准和你的学习画像，把「做出{capstoneName}」拆成 4-6 步，
              每步都有明确产出，附自查清单和翻车预警。
            </div>
            <button
              onClick={() => void runBrief()}
              disabled={briefState === "loading"}
              className="mt-5 rounded-full bg-accent px-6 py-2.5 text-[14px] text-white font-medium hover:opacity-90 disabled:opacity-50"
            >
              {briefState === "loading" ? "导师正在为你设计任务书…" : "生成我的任务书（⚡ 1 积分）"}
            </button>
            {briefMsg && <div className="text-[13px] text-red-600 mt-3">{briefMsg}</div>}
            {creditsBlock?.retry === "brief" && (
              <div className="mt-4 text-left">
                <OutOfCredits compact what={creditsBlock.what} need={creditsBlock.need} balance={creditsBlock.balance} onRecharged={() => void runBrief()} />
              </div>
            )}
          </div>
        ) : (
          <div className="rounded-2xl border border-line bg-white overflow-hidden">
            <div className="px-6 py-4 border-b border-line bg-sunken flex items-center gap-2">
              <div className="flex-1 text-[14.5px] font-semibold">📋 {brief.title}</div>
              {regenConfirm ? (
                <span className="flex items-center gap-1.5 text-[12.5px] text-ink-soft">
                  重新设计会再花 1 积分
                  <button
                    onClick={() => {
                      setRegenConfirm(false);
                      void runBrief();
                    }}
                    className="rounded-full bg-accent px-2.5 py-1 text-[12px] text-white font-medium"
                  >
                    确认
                  </button>
                  <button onClick={() => setRegenConfirm(false)} className="text-[12px] text-ink-faint">
                    取消
                  </button>
                </span>
              ) : (
                <button
                  onClick={() => setRegenConfirm(true)}
                  className="text-[12.5px] text-ink-faint hover:text-accent transition-colors"
                  title="觉得任务书不合身？让导师按新思路重新设计"
                >
                  换一份
                </button>
              )}
            </div>
            <div className="px-6 py-5 space-y-5">
              <div className="rounded-xl bg-accent/5 border border-accent/20 px-4 py-3 text-[14px] font-medium text-ink">
                🎯 最终交付：{brief.mission}
              </div>
              <div>
                <div className="text-[13px] text-ink-faint uppercase tracking-wider mb-2">怎么做 · 每步都有产出</div>
                <div className="space-y-2">
                  {brief.steps.map((s, i) => {
                    const done = doneSteps.has(i);
                    return (
                      <button
                        key={i}
                        onClick={() => toggleStep(i)}
                        className={`w-full text-left rounded-xl border px-4 py-3 flex gap-3 transition-colors ${
                          done ? "border-accent/30 bg-accent/5" : "border-line bg-white hover:border-[#c9c7bd]"
                        }`}
                      >
                        <span
                          className={`shrink-0 w-5 h-5 mt-0.5 rounded-full border flex items-center justify-center text-[11px] font-bold ${
                            done ? "bg-accent border-accent text-white" : "border-line-strong text-ink-faint"
                          }`}
                        >
                          {done ? "✓" : i + 1}
                        </span>
                        <span className="min-w-0">
                          <span className={`block text-[14px] font-medium ${done ? "text-ink-faint line-through" : ""}`}>
                            {s.title}
                          </span>
                          <span className="block text-[13px] text-ink-soft mt-0.5 leading-relaxed">{s.detail}</span>
                        </span>
                      </button>
                    );
                  })}
                </div>
                {brief.timeEstimate && (
                  <div className="text-[12.5px] text-ink-faint mt-2">⏱ {brief.timeEstimate}</div>
                )}
              </div>
              {brief.references.length > 0 && (
                <div>
                  <div className="text-[13px] text-ink-faint uppercase tracking-wider mb-2">卡住了回看这几讲</div>
                  <div className="flex flex-wrap gap-1.5">
                    {brief.references.map((r, i) => (
                      <span key={i} className="rounded-full bg-sunken px-2.5 py-1 text-[12.5px] text-ink-soft">
                        📖 {r}
                      </span>
                    ))}
                  </div>
                </div>
              )}
              <div>
                <div className="text-[13px] text-ink-faint uppercase tracking-wider mb-2">做成标准 · 验收就按这个来</div>
                <div className="space-y-1.5">
                  {brief.criteriaCheck.map((c, i) => (
                    <div key={i} className="rounded-lg border border-line px-3.5 py-2.5">
                      <div className="text-[13.5px] font-medium flex gap-2">
                        <span className="text-accent shrink-0">✓</span>
                        {c.text}
                      </div>
                      {c.hint && <div className="text-[12.5px] text-ink-faint mt-1 pl-5">自查：{c.hint}</div>}
                    </div>
                  ))}
                </div>
              </div>
              {brief.pitfalls.length > 0 && (
                <div>
                  <div className="text-[13px] text-ink-faint uppercase tracking-wider mb-2">翻车预警</div>
                  <div className="space-y-1">
                    {brief.pitfalls.map((p, i) => (
                      <div key={i} className="text-[13.5px] text-ink-soft flex gap-2">
                        <span className="shrink-0">⚠️</span>
                        {p}
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </div>
        )}

        {/* 提交与验收 */}
        {!passed && (
          <div className="rounded-2xl border border-line bg-white overflow-hidden">
            <div className="px-6 py-4 border-b border-line bg-sunken text-[14.5px] font-semibold">
              {lastReview ? "🔄 改完再交，直到做成" : "做完了？交给导师验收"}
            </div>
            <div className="px-6 py-5 space-y-3">
              {lastReview && !lastReview.passed && (
                <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 space-y-1.5">
                  <div className="text-[13.5px] font-medium text-amber-800">
                    上一版还没过：{lastReview.criteria.filter((c) => !c.met).length} 条标准未满足
                  </div>
                  {lastReview.improvements.map((imp, i) => (
                    <div key={i} className="text-[13px] text-amber-700 flex gap-1.5">
                      <span className="shrink-0">→</span>
                      {imp}
                    </div>
                  ))}
                </div>
              )}
              <textarea
                value={submission}
                onChange={(e) => setSubmission(e.target.value)}
                rows={6}
                placeholder={
                  lastReview
                    ? "说明这一版改了什么：对应上一条验收意见，逐条说清楚…"
                    : "描述你的作品：做了什么、怎么做的、结果如何？外人能看到/用到什么？标准逐条对照着写，验收只看证据。"
                }
                className="w-full rounded-xl border border-line px-4 py-3 text-[14px] leading-relaxed outline-none focus:border-accent resize-y bg-white"
              />
              <input
                value={workLink}
                onChange={(e) => setWorkLink(e.target.value)}
                placeholder="作品链接（部署地址 / 仓库 / 相册，选填）"
                className="w-full rounded-xl border border-line px-4 py-2.5 text-[13.5px] outline-none focus:border-accent bg-white"
              />
              <div className="flex items-center gap-3">
                <button
                  onClick={() => void submitWork()}
                  disabled={reviewState === "loading"}
                  className="rounded-full bg-accent px-6 py-2.5 text-[14px] text-white font-medium hover:opacity-90 disabled:opacity-50"
                >
                  {reviewState === "loading" ? "导师正在逐条对照验收…" : "提交验收（⚡ 1 积分/次）"}
                </button>
                <span className="text-[12.5px] text-ink-faint">过与不过都会给逐条判定和改法；不过可以改完再交。</span>
              </div>
              {reviewMsg && <div className="text-[13px] text-red-600">{reviewMsg}</div>}
              {creditsBlock?.retry === "review" && (
                <OutOfCredits compact what={creditsBlock.what} need={creditsBlock.need} balance={creditsBlock.balance} onRecharged={() => void submitWork()} />
              )}
            </div>
          </div>
        )}

        {/* 最近一次验收详情（未通过时展示判定细节） */}
        {lastReview && !passed && (
          <div className="rounded-2xl border border-line bg-white px-6 py-5 space-y-2">
            <div className="text-[14px] font-semibold mb-1">最近一次验收判定</div>
            {lastReview.criteria.map((c, i) => (
              <div key={i} className="flex gap-2.5 rounded-lg border border-line px-3.5 py-2.5">
                <span className={`shrink-0 text-[14px] font-bold ${c.met ? "text-emerald-600" : "text-red-500"}`}>
                  {c.met ? "✓" : "✗"}
                </span>
                <div className="min-w-0">
                  <div className="text-[13.5px] font-medium">{c.text}</div>
                  <div className="text-[12.5px] text-ink-soft mt-0.5 leading-relaxed">{c.comment}</div>
                </div>
              </div>
            ))}
            {lastReview.strengths.length > 0 && (
              <div className="pt-1 text-[13px] text-ink-soft">
                <span className="font-medium text-ink">亮点：</span>
                {lastReview.strengths.join("；")}
              </div>
            )}
          </div>
        )}

        <div className="text-center text-[12px] text-ink-faint pb-4">
          {passed
            ? "这门课到这里就是「做出」而不是「听完」。去精品课程把这门课分享给同样需要它的人。"
            : "验收是真实世界的交付：拿证据说话，不过就改，改过为止。"}
        </div>
      </div>
    </div>
  );
}
