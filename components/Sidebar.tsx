"use client";

// 原版 Hyperknow 同款侧栏：浮动圆角白卡，导航 + 继续学习 + 历史
import type { ConversationMeta } from "@/types";

export interface SidebarCourse {
  id: string;
  title: string;
}

export function Sidebar({
  mode,
  onMode,
  courses,
  onOpenCourse,
  conversations,
  currentId,
  onSelect,
  onDelete,
  user,
  onLogin,
  onLogout,
}: {
  mode: "course" | "chat" | "market" | "records";
  onMode: (m: "course" | "chat" | "market" | "records") => void;
  courses: SidebarCourse[];
  onOpenCourse: (id: string) => void;
  conversations: ConversationMeta[];
  currentId: string | null;
  onSelect: (id: string) => void;
  onDelete: (id: string) => void;
  user: { id: string; email: string } | null;
  onLogin: () => void;
  onLogout: () => void;
}) {
  return (
    <aside className="w-64 shrink-0 h-full p-3">
      <div className="h-full rounded-2xl bg-white border border-[#e7e5dc] shadow-sm flex flex-col overflow-hidden">
        {/* Logo */}
        <div className="px-4 pt-4 pb-3 flex items-center gap-2">
          <div className="w-6 h-6 rounded-md bg-accent flex items-center justify-center text-white text-[12px] font-bold">
            L
          </div>
          <span className="font-semibold text-[15px]">LearnLoop</span>
          <span className="text-[10px] text-ink-faint border border-[#d3d1c7] rounded px-1 py-px">MVP</span>
        </div>

        {/* 主导航：只有一个输入入口，首页即课程生成 */}
        <nav className="px-2 space-y-0.5">
          <button
            onClick={() => onMode("course")}
            className={`w-full flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-[13px] transition-colors ${
              mode === "course" ? "bg-[#f1efe8] text-ink font-medium" : "text-ink-soft hover:bg-[#fafaf7]"
            }`}
          >
            <span className="text-[13px]">🏠</span> 首页
          </button>
          <button
            onClick={() => onMode("records")}
            className={`w-full flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-[13px] transition-colors ${
              mode === "records" ? "bg-[#f1efe8] text-ink font-medium" : "text-ink-soft hover:bg-[#fafaf7]"
            }`}
          >
            <span className="text-[13px]">📚</span> 课程记录
            {courses.length > 0 && (
              <span className="ml-auto text-[10px] text-ink-faint">{courses.length}</span>
            )}
          </button>
          <button
            onClick={() => onMode("market")}
            className={`w-full flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-[13px] transition-colors ${
              mode === "market" ? "bg-[#f1efe8] text-ink font-medium" : "text-ink-soft hover:bg-[#fafaf7]"
            }`}
          >
            <span className="text-[13px]">🛍</span> 课程集市
          </button>
        </nav>

        {/* 课程记录：我自己生成的课程 */}
        <div className="mt-4 px-4 mb-1.5 flex items-center justify-between">
          <div className="text-[11px] text-ink-faint font-medium tracking-wider">课程记录</div>
          {courses.length > 0 && <div className="text-[10px] text-ink-faint">共 {courses.length} 门</div>}
        </div>
        <div className="px-2 space-y-0.5 overflow-y-auto max-h-60">
          {courses.slice(0, 12).map((c) => (
            <button
              key={c.id}
              onClick={() => onOpenCourse(c.id)}
              title={c.title}
              className="w-full text-left rounded-lg px-2.5 py-2 hover:bg-[#fafaf7] transition-colors flex items-start gap-2"
            >
              <span className="shrink-0 mt-0.5 text-[10px] text-accent border border-accent/40 rounded px-1">学习</span>
              <span className="text-[12px] text-ink leading-snug line-clamp-2">{c.title}</span>
            </button>
          ))}
          {courses.length === 0 && (
            <div className="px-2.5 py-2 text-[11.5px] text-ink-faint">还没有课程，去首页创建</div>
          )}
        </div>

        {/* 历史对话 */}
        <div className="mt-4 px-4 mb-1.5">
          <div className="text-[11px] text-ink-faint font-medium tracking-wider">历史对话</div>
        </div>
        <div className="flex-1 min-h-0 overflow-y-auto px-2 space-y-0.5">
          {conversations.map((c) => (
            <div
              key={c.id}
              className={`group flex items-center rounded-lg px-2.5 py-2 cursor-pointer transition-colors ${
                c.id === currentId ? "bg-[#f1efe8]" : "hover:bg-[#fafaf7]"
              }`}
              onClick={() => onSelect(c.id)}
            >
              <div className="min-w-0 flex-1">
                <div className="text-[12px] truncate text-ink">{c.title}</div>
                <div className="text-[10px] text-ink-faint">
                  {new Date(c.updatedAt).toLocaleDateString("zh-CN", { month: "numeric", day: "numeric" })} · {c.messageCount} 条
                </div>
              </div>
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  onDelete(c.id);
                }}
                className="opacity-0 group-hover:opacity-100 text-ink-faint hover:text-red-600 text-[12px] px-1 transition-opacity"
                title="删除"
              >
                ×
              </button>
            </div>
          ))}
          {conversations.length === 0 && (
            <div className="px-2.5 py-2 text-[11.5px] text-ink-faint">还没有对话</div>
          )}
        </div>

        {/* 登录态：课程记录/教材/上架跟着账号走 */}
        <div className="px-3 py-3 border-t border-[#e7e5dc]">
          {user ? (
            <div className="flex items-center gap-2">
              <div className="w-6 h-6 shrink-0 rounded-full bg-accent-soft flex items-center justify-center text-[11px] text-accent font-bold">
                {user.email[0]?.toUpperCase() || "?"}
              </div>
              <div className="min-w-0 flex-1">
                <div className="text-[12px] text-ink truncate" title={user.email}>
                  {user.email}
                </div>
                <button onClick={onLogout} className="text-[10.5px] text-ink-faint hover:text-red-500 transition-colors">
                  退出登录
                </button>
              </div>
            </div>
          ) : (
            <button
              onClick={onLogin}
              className="w-full rounded-lg border border-[#d3d1c7] px-3 py-2 text-[12.5px] text-ink-soft hover:border-accent hover:text-accent transition-colors"
            >
              登录 / 注册
            </button>
          )}
        </div>
      </div>
    </aside>
  );
}
