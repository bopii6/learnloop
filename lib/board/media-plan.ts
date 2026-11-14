// 媒体导演：一次独立 LLM 调用，决定哪张卡出动画、哪张卡配图。
// 返回的索引会被贴回脚本的对应卡片上（route 里合并）。
import { generateJson } from "@/lib/agent/llm";
import { MEDIA_SYSTEM, type CardScript } from "./prompts";

export interface MediaDecision {
  animation?: { card_index: number; task: string } | null;
  image?: { card_index: number; caption: string; prompt: string } | null;
}

export async function decideMedia(cards: CardScript[]): Promise<MediaDecision | null> {
  if (!cards.length) return null;
  const list = cards
    .map((c, i) => `[${i}] 卡面：${c.content.replace(/\s+/g, " ").slice(0, 80)}｜讲解：${(c.speak || "").replace(/\s+/g, " ").slice(0, 60)}`)
    .join("\n");
  const res = await generateJson<MediaDecision>(MEDIA_SYSTEM, `卡片清单（共 ${cards.length} 张）：\n${list}\n\n请决定媒体。`, { task: "fast", maxTokens: 700 });
  if (!res) return null;
  // 边界校验
  const out: MediaDecision = {};
  if (res.animation && Number.isInteger(res.animation.card_index) && res.animation.card_index >= 0 && res.animation.card_index < cards.length && res.animation.task) {
    out.animation = { card_index: res.animation.card_index, task: String(res.animation.task).slice(0, 400) };
  }
  if (res.image && Number.isInteger(res.image.card_index) && res.image.card_index >= 0 && res.image.card_index < cards.length && res.image.prompt) {
    out.image = {
      card_index: res.image.card_index,
      caption: String(res.image.caption || "").slice(0, 16),
      prompt: String(res.image.prompt).slice(0, 600),
    };
  }
  return out;
}

/** 把媒体决策合并进卡片（就地修改 cards） */
export function applyMedia(cards: CardScript[], decision: MediaDecision | null): void {
  if (!decision) return;
  if (decision.animation) {
    const c = cards[decision.animation.card_index];
    if (c) c.animation = { task: decision.animation.task };
  }
  if (decision.image) {
    const c = cards[decision.image.card_index];
    if (c) c.image = { caption: decision.image.caption, prompt: decision.image.prompt };
  }
}
