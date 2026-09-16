"use client";

// 苏格拉底私教课堂（原型）：老师问 → 你答（点选项或打字）→ 老师接住并写在白板上。
// 与白板讲稿课共用同一块真白板（Whiteboard + board-writer）与云端语音（tts-client），
// 但没有预写讲稿：每一轮都是现场生成，推进权在学员手里。
import { useCallback, useEffect, useRef, useState } from "react";
import { Whiteboard } from "./Whiteboard";
import { createBoardWriter, type BoardWriter } from "./board-writer";
import { createTtsPlayer, fetchTtsSegments } from "@/lib/tts-client";
import { splitSpeechLines } from "@/lib/speech-lines";
import type { BoardItem } from "@/types";

interface SocraticStep {
  module: string;
  ask: string;
  options: string[];
  concept: string;
  good: string;
  wrong: string;
  items: BoardItem[];
}
interface SocraticPlan {
  ability: string;
  steps: SocraticStep[];
}
interface Msg {
  id: string;
  role: "teacher" | "student";
  content: string;
  verdict?: "good" | "partial" | "wrong";
}

type Phase = "boot" | "ask" | "think" | "act" | "ended";

const VERDICT_LABEL = { good: "答对了", partial: "对了一半", wrong: "走错路了" } as const;

export function SocraticClassroom({ courseId, unitId, lectureId }: { courseId: string; unitId: string; lectureId: string }) {
  const excalidrawApiRef = useRef<any>(null);
  const writerRef = useRef<BoardWriter | null>(null);
  if (!writerRef.current) writerRef.current = createBoardWriter(() => excalidrawApiRef.current);

  const [boardReady, setBoardReady] = useState(false);
  const [phase, setPhase] = useState<Phase>("boot");
  const [meta, setMeta] = useState<{ courseTitle: string; lectureTitle: string; studentName: string } | null>(null);
  const planRef = useRef<SocraticPlan | null>(null);
  const [stepIndex, setStepIndex] = useState(0);
  const [messages, setMessages] = useState<Msg[]>([]);
  const [thinking, setThinking] = useState("");
  const [input, setInput] = useState("");
  const [voiceOn, setVoiceOn] = useState(true);
  const [subtitle, setSubtitle] = useState("");
  const [ability, setAbility] = useState("");
  const [error, setError] = useState("");

  const voiceOnRef = useRef(voiceOn);
  voiceOnRef.current = voiceOn;
  const speechStopRef = useRef<(() => void) | null>(null);
  const speakSessionRef = useRef(0); // 跳过语音：整段作废的会话号
  const historyRef = useRef<{ role: "teacher" | "student"; content: string }[]>([]);
  const lastReplyRef = useRef("");
  const messagesRef = useRef<Msg[]>([]);
  messagesRef.current = messages;

  const pushMsg = useCallback((m: Omit<Msg, "id">) => {
    setMessages((prev) => [...prev, { ...m, id: `m-${Date.now()}-${Math.random().toString(36).slice(2, 6)}` }]);
  }, []);

  // ---- 语音：逐句朗读（云端 TTS 优先，失败回退浏览器音色；静音时按阅读节奏推进） ----
  const speakOne = useCallback((text: string) => {
    return new Promise<void>((resolve) => {
      if (!voiceOnRef.current) {
        const t = window.setTimeout(resolve, Math.max(900, text.length * 150));
        speechStopRef.current = () => {
          window.clearTimeout(t);
          resolve();
        };
        return;
      }
      let cancelled = false;
      speechStopRef.current = () => {
        cancelled = true;
        window.speechSynthesis?.cancel();
        resolve();
      };
      void (async () => {
        try {
          const segs = await fetchTtsSegments(text);
          if (cancelled) return;
          if (segs) {
            const player = createTtsPlayer(segs, 1);
            speechStopRef.current = () => {
              cancelled = true;
              player.stop();
              resolve();
            };
            await player.promise;
            resolve();
          } else if ("speechSynthesis" in window) {
            const u = new SpeechSynthesisUtterance(text);
            u.lang = "zh-CN";
            u.onend = () => resolve();
            u.onerror = () => resolve();
            window.speechSynthesis.speak(u);
          } else {
            globalThis.setTimeout(resolve, Math.max(900, text.length * 150));
          }
        } catch {
          resolve();
        }
      })();
    });
  }, []);

  const speakLines = useCallback(
    async (text: string) => {
      const lines = splitSpeechLines(text);
      const session = ++speakSessionRef.current;
      for (const line of lines) {
        if (session !== speakSessionRef.current) return; // 用户点了跳过语音：整段放弃，不是跳到下一句
        setSubtitle(line);
        await speakOne(line);
      }
      setSubtitle("");
    },
    [speakOne]
  );

  // ---- 探究链推进 ----
  const beginAsk = useCallback(
    async (index: number) => {
      const plan = planRef.current;
      if (!plan) return;
      const step = plan.steps[index];
      setStepIndex(index);
      setPhase("act");
      // 新一问 = 白板新模块：模块标题 + 锚点词（这一步建立的概念）
      await writerRef.current?.beginSegment(step.module, { index: index + 1, total: plan.steps.length }, step.concept.slice(0, 4));
      pushMsg({ role: "teacher", content: step.ask });
      historyRef.current.push({ role: "teacher", content: step.ask });
      await speakLines(step.ask);
      setPhase("ask");
    },
    [pushMsg, speakLines]
  );

  const start = useCallback(async () => {
    setPhase("boot");
    setError("");
    try {
      const res = await fetch("/api/socratic", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "start", courseId, unitId, lectureId }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "生成探究链失败");
      setMeta(data.meta);
      planRef.current = data.plan;
      await beginAsk(0);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setPhase("ask");
    }
  }, [courseId, unitId, lectureId, beginAsk]);

  // 白板就绪后开课（Excalidraw 动态加载可能比开课慢——就绪前不开，前几笔会画进空气）
  useEffect(() => {
    if (boardReady && phase === "boot" && !planRef.current) void start();
  }, [boardReady, phase, start]);

  const postTurn = useCallback(
    async (action: "answer" | "simpler", answer: string) => {
      const plan = planRef.current;
      if (!plan) return null;
      const step = plan.steps[stepIndex];
      setPhase("think");
      setThinking(action === "answer" ? "老师正在想怎么接你的答案…" : "老师正在换个说法…");
      try {
        const res = await fetch("/api/socratic", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            action,
            courseId,
            unitId,
            lectureId,
            step,
            nextAsk: plan.steps[stepIndex + 1]?.ask,
            question: step.ask,
            lastReply: lastReplyRef.current,
            answer,
            history: historyRef.current.slice(-4),
          }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || "老师走神了，再试一次");
        return data as { reply: string; verdict?: "good" | "partial" | "wrong"; items?: BoardItem[] };
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
        setPhase("ask");
        return null;
      } finally {
        setThinking("");
      }
    },
    [courseId, unitId, lectureId, stepIndex]
  );

  const playTurn = useCallback(
    async (reply: string, verdict: "good" | "partial" | "wrong" | undefined, items: BoardItem[]) => {
      setPhase("act");
      lastReplyRef.current = reply;
      pushMsg({ role: "teacher", content: reply, verdict });
      historyRef.current.push({ role: "teacher", content: reply });
      // 先落板书（老师把结论写下来），再开口说——写与说都有节奏
      if (items.length > 0) {
        await writerRef.current?.beginBeat(undefined, items.length);
        for (const item of items) {
          await writerRef.current?.writeItem(item);
          writerRef.current?.highlightLast();
        }
      }
      await speakLines(reply);
    },
    [pushMsg, speakLines]
  );

  const submitAnswer = useCallback(
    async (answer: string) => {
      const text = answer.trim();
      if (!text || phase !== "ask") return;
      pushMsg({ role: "student", content: text });
      historyRef.current.push({ role: "student", content: text });
      const turn = await postTurn("answer", text);
      if (!turn) return;
      const plan = planRef.current!;
      const isLast = stepIndex >= plan.steps.length - 1;
      await playTurn(turn.reply, turn.verdict, turn.items || []);
      if (isLast) {
        writerRef.current?.characterCelebrate();
        setAbility(plan.ability);
        setPhase("ended");
      } else {
        await beginAsk(stepIndex + 1);
      }
    },
    [phase, pushMsg, postTurn, playTurn, stepIndex, beginAsk]
  );

  const simpler = useCallback(async () => {
    if (phase !== "ask" && phase !== "think") return;
    const turn = await postTurn("simpler", lastReplyRef.current);
    if (!turn) return;
    await playTurn(turn.reply, undefined, []);
    setPhase("ask");
  }, [phase, postTurn, playTurn]);

  const step = planRef.current?.steps[stepIndex];
  const total = planRef.current?.steps.length ?? 0;

  return (
    <div className="flex h-screen w-full overflow-hidden bg-white text-neutral-900">
      {/* 左：白板（与讲稿课同一块真板） */}
      <div className="relative min-w-0 flex-1">
        <Whiteboard onReady={(api) => {
          excalidrawApiRef.current = api;
          setBoardReady(true);
        }} />
        {subtitle && (
          <div className="pointer-events-none absolute bottom-4 left-1/2 max-w-[80%] -translate-x-1/2 rounded-lg bg-black/75 px-4 py-2 text-center text-sm text-white">
            {subtitle}
          </div>
        )}
        {meta && (
          <div className="pointer-events-none absolute left-4 top-3 rounded-md bg-white/85 px-3 py-1.5 text-xs text-neutral-600 shadow-sm">
            苏格拉底私教 · {meta.lectureTitle} · 第 {Math.min(stepIndex + 1, total)}/{total || "?"} 问
          </div>
        )}
      </div>

      {/* 右：对话与作答 */}
      <div className="flex w-[400px] shrink-0 flex-col border-l border-neutral-200 bg-neutral-50">
        <div className="flex items-center justify-between border-b border-neutral-200 px-4 py-3">
          <div className="text-sm font-semibold">一对一探究课堂</div>
          <button
            onClick={() => setVoiceOn((v) => !v)}
            className="rounded-md border border-neutral-300 px-2 py-1 text-xs text-neutral-600 hover:bg-white"
          >
            {voiceOn ? "🔊 声音开" : "🔇 静音"}
          </button>
        </div>

        <div className="flex-1 space-y-3 overflow-y-auto px-4 py-4">
          {messages.map((m) => (
            <div key={m.id} className={m.role === "student" ? "flex justify-end" : "flex justify-start"}>
              <div
                className={`max-w-[85%] rounded-2xl px-3.5 py-2.5 text-sm leading-relaxed ${
                  m.role === "student" ? "bg-neutral-900 text-white" : "border border-neutral-200 bg-white text-neutral-800"
                }`}
              >
                {m.role === "teacher" && m.verdict && (
                  <span
                    className={`mr-2 inline-block rounded px-1.5 py-0.5 text-[11px] align-middle ${
                      m.verdict === "good"
                        ? "bg-emerald-100 text-emerald-700"
                        : m.verdict === "partial"
                          ? "bg-amber-100 text-amber-700"
                          : "bg-rose-100 text-rose-700"
                    }`}
                  >
                    {VERDICT_LABEL[m.verdict]}
                  </span>
                )}
                {m.content}
              </div>
            </div>
          ))}
          {thinking && <div className="text-xs text-neutral-400">{thinking}</div>}
          {error && <div className="rounded-md bg-rose-50 px-3 py-2 text-xs text-rose-600">{error}</div>}
        </div>

        {/* 作答区 */}
        {phase === "ask" && step && (
          <div className="border-t border-neutral-200 bg-white px-4 py-3">
            <div className="mb-2 text-sm font-medium leading-snug">{step.ask}</div>
            <div className="mb-2 flex flex-col gap-1.5">
              {step.options.map((opt) => (
                <button
                  key={opt}
                  onClick={() => void submitAnswer(opt)}
                  className="rounded-lg border border-neutral-300 px-3 py-2 text-left text-sm hover:border-neutral-900 hover:bg-neutral-900 hover:text-white"
                >
                  {opt}
                </button>
              ))}
            </div>
            <div className="flex gap-2">
              <input
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && input.trim()) void submitAnswer(input);
                }}
                placeholder="或者用你自己的话说…"
                className="min-w-0 flex-1 rounded-lg border border-neutral-300 px-3 py-2 text-sm outline-none focus:border-neutral-900"
              />
              <button
                onClick={() => {
                  if (input.trim()) {
                    void submitAnswer(input);
                    setInput("");
                  }
                }}
                className="rounded-lg bg-neutral-900 px-3.5 py-2 text-sm text-white hover:bg-neutral-700"
              >
                回答
              </button>
            </div>
            {lastReplyRef.current && (
              <button onClick={() => void simpler()} className="mt-2 text-xs text-neutral-400 hover:text-neutral-700">
                没跟上，换个说法讲
              </button>
            )}
          </div>
        )}
        {(phase === "think" || phase === "act") && (
          <div className="border-t border-neutral-200 bg-white px-4 py-3 text-xs text-neutral-400">
            {phase === "act" ? "老师在讲解…" : "想好了会叫你"}
            <button
              onClick={() => {
                speakSessionRef.current++;
                speechStopRef.current?.();
                setSubtitle("");
              }}
              className="ml-2 text-neutral-500 underline hover:text-neutral-800"
            >
              跳过语音
            </button>
          </div>
        )}
        {phase === "boot" && (
          <div className="border-t border-neutral-200 bg-white px-4 py-3 text-xs text-neutral-400">
            正在为这节课编一条探究链…
          </div>
        )}
        {phase === "ended" && (
          <div className="border-t border-neutral-200 bg-white px-4 py-4">
            <div className="mb-1 text-sm font-semibold">🎉 探究完成</div>
            <div className="mb-3 text-sm text-neutral-600">{ability}</div>
            <div className="flex gap-2">
              <button
                onClick={() => window.location.reload()}
                className="rounded-lg border border-neutral-300 px-3 py-1.5 text-xs hover:bg-neutral-100"
              >
                再探究一遍
              </button>
              <a
                href={`/learn/${courseId}`}
                className="rounded-lg bg-neutral-900 px-3 py-1.5 text-xs text-white hover:bg-neutral-700"
              >
                回到课程
              </a>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
