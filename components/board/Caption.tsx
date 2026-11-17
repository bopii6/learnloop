"use client";

// 底部字幕：随讲解逐字变实；和这一拍白板卡上相同的词，画上与白板同款的黄色记号
import { memo, useMemo } from "react";
import { captionMatchMask } from "@/lib/board/caption-match";

export const Caption = memo(function Caption({ text, reveal, board }: { text: string; reveal: number; board?: string }) {
  const mask = useMemo(() => captionMatchMask(text, board), [text, board]);
  // 按"是否已讲到 / 是否在白板上"切成连续片段，减少节点数
  const runs = useMemo(() => {
    const out: { s: string; said: boolean; hit: boolean }[] = [];
    for (let i = 0; i < text.length; i++) {
      const said = i < reveal;
      const hit = mask[i];
      const last = out[out.length - 1];
      if (last && last.said === said && last.hit === hit) last.s += text[i];
      else out.push({ s: text[i], said, hit });
    }
    return out;
  }, [text, reveal, mask]);

  return (
    <span className="inline rounded-[14px] bg-[rgba(250,250,250,0.82)] px-3.5 py-1.5 text-[16px] font-medium leading-[1.7] [box-decoration-break:clone] [-webkit-box-decoration-break:clone]">
      {runs.map((r, i) =>
        r.hit ? (
          <span key={i} className={r.said ? "caption-hit caption-hit-on text-[#1f1f1f]" : "caption-hit text-[#c4c4c4]"}>
            {r.s}
          </span>
        ) : (
          <span key={i} className={r.said ? "text-[#1f1f1f]" : "text-[#c4c4c4]"}>
            {r.s}
          </span>
        )
      )}
    </span>
  );
});
