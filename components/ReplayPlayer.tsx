"use client";

// 只读回放：一个链接完整重演一节白板课（分享落地页）。
// 新版回放直接是卡片流动作序列；旧版（v1 课堂）的 beat 剧本转成卡片后用同一个播放器播。
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import type { ReplayReel } from "@/types";
import type { BoardAction } from "@/types/board";
import { beatsToActions } from "@/lib/board/actions";
import { WhiteboardSession } from "./WhiteboardSession";

export function ReplayPlayer({ replayId }: { replayId: string }) {
  const router = useRouter();
  const [reel, setReel] = useState<ReplayReel | null>(null);
  const [actions, setActions] = useState<BoardAction[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    fetch(`/api/replay?id=${encodeURIComponent(replayId)}`)
      .then(async (r) => {
        if (!r.ok) throw new Error(r.status === 404 ? "这条回放不存在或已被删除" : `加载失败 (${r.status})`);
        return r.json();
      })
      .then((d: { reel: ReplayReel }) => {
        if (!alive) return;
        const r = d.reel;
        setReel(r);
        setActions(r.kind === "board" && r.actions?.length ? r.actions : beatsToActions(r.beats || [], r.lectureTitle));
      })
      .catch((e) => alive && setError(e instanceof Error ? e.message : String(e)));
    return () => {
      alive = false;
    };
  }, [replayId]);

  if (error) {
    return (
      <div className="min-h-screen flex items-center justify-center px-6">
        <div className="text-center">
          <div className="text-[15px] text-ink-soft mb-4">{error}</div>
          <button onClick={() => router.push("/")} className="rounded-full bg-accent px-5 py-2 text-[13px] text-white font-medium hover:opacity-90">
            去首页生成一门课
          </button>
        </div>
      </div>
    );
  }
  if (!reel || !actions) {
    return <div className="min-h-screen flex items-center justify-center text-[13px] text-ink-soft">正在加载回放…</div>;
  }
  return (
    <WhiteboardSession
      courseId={reel.courseId}
      unitId={reel.unitId}
      lectureId={reel.lectureId}
      lectureTitle={reel.lectureTitle}
      replay={{ actions, courseTitle: reel.courseTitle }}
      onExit={() => router.push("/")}
    />
  );
}
