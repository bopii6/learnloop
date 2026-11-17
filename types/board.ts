// 白板数据模型与协议（对标 Hyperknow 实测版）
// 结构原则：页（page）→ 列（column）→ 卡片（overlay item）；版面由客户端计算并回传，
// 服务端只下发内容与结构动作（board / speak / new_page / new_column / circle …）。

// ---- 装饰：圈画（circle）与高亮（highlight）都是"文本锚点 + 归一化 snippet"，不是笔迹 ----
export interface BoardDecoration {
  id: string;
  kind: "circle" | "highlight";
  /** 归一化后的锚点文本（服务端下发，已去标点/空格/LaTeX 符号） */
  snippet: string;
  color?: string;
}

// ---- 卡片（overlay item） ----
export interface NoteCardItem {
  id: string;
  kind: "note_card";
  x: number;
  y: number;
  w: number;
  h: number;
  columnIndex: number;
  /** 圈画目标 id（服务端 circle/highlight 的 target_board_id 指向它） */
  boardUid?: number;
  /** 卡面内容：Markdown + $LaTeX$（与 Hyperknow 一致） */
  content: string;
  /** 可选标题（service 侧可复用在内容里） */
  title?: string;
  decorations?: BoardDecoration[];
  // ---- 运行时字段（不入持久化） ----
  animateReveal?: boolean;
  revealGateStep?: number;
  revealGateOpen?: boolean;
  /** 打字机是否已完成 */
  typed?: boolean;
  /** 整卡写完的期望时长（≈ 配对讲解的时长）：字跟着话写出来 */
  revealMs?: number;
  /** 配对讲解原文：板书按这句话的真实播放进度落字 */
  syncText?: string;
}

export interface BoardImageItem {
  id: string;
  kind: "board_image";
  x: number;
  y: number;
  w: number;
  h: number;
  columnIndex: number;
  /** 占位步 id：generated_image 按它精确回填（多张图时不会串位） */
  placementStepId?: number;
  boardImage: {
    imageUrl: string;
    width: number;
    height: number;
    caption?: string;
    pending?: boolean;
  };
}

export interface BoardAnimationItem {
  id: string;
  kind: "board_animation";
  x: number;
  y: number;
  w: number;
  h: number;
  columnIndex: number;
  placementStepId?: number;
  boardAnimation: {
    html?: string;
    task?: string;
    pending?: boolean;
  };
}

export interface MermaidGraphItem {
  id: string;
  kind: "mermaid_graph";
  x: number;
  y: number;
  w: number;
  h: number;
  columnIndex: number;
  mermaidGraph: { source: string };
}

export type BoardItem = NoteCardItem | BoardImageItem | BoardAnimationItem | MermaidGraphItem;

// ---- 版面 ----
export interface BoardLayoutParams {
  colCount: number;
  tileW: number;
  tileGapX: number;
  tileGapY: number;
  gridLeft: number;
  gridTop: number;
  usableW: number;
  usableH: number;
  exportPixelW: number;
}

export interface BoardColumn {
  x: number;
  w: number;
  nextY: number;
}

export interface ColumnLayout {
  lp: BoardLayoutParams;
  columns: BoardColumn[];
  activeIndex: number;
}

export interface BoardPage {
  id: string;
  title?: string;
  items: BoardItem[];
  layout: ColumnLayout | null;
}

export interface BoardState {
  version: 1;
  revision: number;
  activePageId: string;
  pages: BoardPage[];
}

// ---- 动作协议（服务端 → 客户端，字段与实测帧一致） ----
export type BoardAction =
  | { type: "new_page"; step_id: number; page_id: string; title?: string }
  | { type: "new_column"; step_id: number; page_id: string }
  /** 分段讲课：一段开始（客户端换列、更新进度点；final = 收尾段） */
  | { type: "segment_start"; step_id: number; segment: number; title: string; total: number; final?: boolean }
  /** 一段讲完且没有检查题：客户端自动请求下一段 */
  | { type: "segment_end"; step_id: number; segment: number; auto: boolean }
  | {
      type: "board";
      step_id: number;
      board_uid: number;
      page_id: string;
      board_content: string;
      title?: string;
    }
  | { type: "speak"; step_id: number; spoken_text: string }
  | {
      type: "circle";
      step_id: number;
      target_board_id: number;
      page_id: string;
      snippet: string;
      color?: string;
    }
  | {
      type: "highlight";
      step_id: number;
      target_board_id: number;
      page_id: string;
      snippet: string;
      color?: string;
    }
  | {
      type: "ask";
      step_id: number;
      mode: "choice" | "open";
      /** 段末检查的形式：选择 / 一句话作答 / 写代码（浏览器内运行判题） */
      kind?: "choice" | "open" | "code";
      /** 属于第几段（作答后据此请求下一段） */
      segment?: number;
      question: string;
      options?: string[];
      correct_index?: number;
      explanation?: string;
      code?: { setup: string; starter: string; solution: string };
    }
  | {
      type: "reward_user";
      step_id: number;
      master_concept_title: string;
      master_concept_description: string;
    }
  | {
      type: "image_gen_pending";
      step_id: number;
      placement_step_id: number;
      page_id: string;
      prompt_preview?: string;
      caption?: string;
    }
  | {
      type: "generated_image";
      step_id: number;
      page_id: string;
      image_url: string;
      width: number;
      height: number;
      caption?: string;
      /** 本地扩展：由 placement 步占用（对齐 Hyperknow 的 pending 占位替换语义） */
      placement_step_id?: number;
    }
  | {
      type: "animation_pending";
      step_id: number;
      placement_step_id: number;
      page_id: string;
      task_preview?: string;
    }
  | {
      type: "generated_animation";
      step_id: number;
      page_id: string;
      html: string;
      task?: string;
      placement_step_id?: number;
    }
  | { type: "graph"; step_id: number; page_id: string; mermaid: string }
  | { type: "done"; step_id: number };

export type BoardEvent =
  | { type: "session_ready"; session_id: string; session_title?: string; status: string }
  /** 本节课规划（分段标题）：顶栏进度点 */
  | { type: "lesson_plan"; title: string; segments: { title: string }[] }
  | { type: "group"; actions: BoardAction[] }
  | BoardAction
  | {
      type: "tts_segment";
      step_id: number;
      sequence: number;
      audio_url?: string;
      skipped?: boolean;
      tts_cjk: number;
      tts_latin: number;
      speed: number;
    }
  | { type: "response_complete"; is_complete: boolean; status: string }
  /** 需要登录（公网部署时课堂与账号绑定） */
  | { type: "auth_required"; message: string }
  /** 富媒体生成失败：客户端撤掉对应占位卡 */
  | { type: "media_failed"; step_id: number; placement_step_id: number; kind: "image" | "animation" }
  | { type: "error"; message: string };

// ---- 播放期实体（客户端队列项） ----
export interface StepItem {
  stepId: number;
  action: BoardAction;
  /** 同一 group 内与本动作配对的 speak（board 的闸门） */
  gateStep?: number;
  resolveAck?: () => void;
}

export interface AskState {
  stepId: number;
  kind: "choice" | "open" | "code";
  segment?: number;
  question: string;
  options: string[];
  correctIndex?: number;
  explanation?: string;
  code?: { setup: string; starter: string; solution: string };
  answered?: { text: string; correct?: boolean };
}
