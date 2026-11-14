// 白板课动作序列的纯函数工具（服务端与客户端共用，不得引入任何 Node 依赖）。
import type { BoardAction } from "@/types/board";
import type { ReplayBeat } from "@/types";

/** 按 Hyperknow 的 group 语义打包：new_page / board 与紧随其后的 speak 同组（组内并发、组间串行） */
export function groupActions(actions: BoardAction[]): BoardAction[][] {
  const out: BoardAction[][] = [];
  for (let i = 0; i < actions.length; i++) {
    const a = actions[i];
    const b = actions[i + 1];
    if ((a.type === "board" || a.type === "new_page" || a.type === "new_column") && b?.type === "speak") {
      out.push([a, b]);
      i++;
    } else {
      out.push([a]);
    }
  }
  return out;
}

/** 旧版（v1 Excalidraw 课堂）回放剧本 → 卡片流动作：已分享出去的老链接继续能看 */
export function beatsToActions(beats: ReplayBeat[], title: string): BoardAction[] {
  const actions: BoardAction[] = [];
  let step = 0;
  let uid = 0;
  const pageId = "replay-legacy";
  actions.push({ type: "new_page", step_id: step++, page_id: pageId, title });
  let lastSection = "";
  for (const b of beats) {
    const lines: string[] = [];
    if (b.section && b.section !== lastSection) {
      lines.push(`**${b.section}**`);
      lastSection = b.section;
    }
    for (const it of b.items || []) {
      if (it.text) lines.push(it.kind === "note" ? `> ${it.text}` : `- ${it.text}`);
      else if (it.nodes?.length) lines.push(`- ${it.nodes.join(" → ")}`);
    }
    if (lines.length > 0) {
      actions.push({ type: "board", step_id: step++, board_uid: uid++, page_id: pageId, board_content: lines.join("\n") });
    }
    if (b.say) actions.push({ type: "speak", step_id: step++, spoken_text: b.say });
  }
  actions.push({ type: "done", step_id: step++ });
  return actions;
}
