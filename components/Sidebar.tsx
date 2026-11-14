"use client";

// 侧栏：浮动圆角白卡，导航 + 继续学习 + 历史。
// 图标统一用内联 SVG 线性图标（stroke=currentColor），选中态走品牌绿。
import { NEW_USER_GRANT } from "@/lib/pricing";
import { useState } from "react";
import type { ConversationMeta } from "@/types";
import { CreditsPopover } from "./CreditsPopover";

export interface SidebarCourse {
  id: string;
  title: string;
}

function NavIcon({ name }: { name: "home" | "library" | "market" | "chat" | "plus" }) {
  const common = {
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 2,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    className: "h-[15px] w-[15px] shrink-0",
    "aria-hidden": true,
  };
  if (name === "home")
    return (
      <svg {...common}>
        <path d="m3 9.5 9-7 9 7V20a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 20z" />
        <path d="M9.5 21.5v-7h5v7" />
      </svg>
    );
  if (name === "library")
    return (
      <svg {...common}>
        <path d="M2 4h5.5A3.5 3.5 0 0 1 11 7.5V21a3 3 0 0 0-3-3H2z" />
        <path d="M22 4h-5.5A3.5 3.5 0 0 0 13 7.5V21a3 3 0 0 1 3-3h6z" />
      </svg>
    );
  if (name === "market")
    return (
      <svg {...common}>
        <path d="M6 2 3 6v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6l-3-4z" />
        <path d="M3 6h18" />
        <path d="M16 10a4 4 0 0 1-8 0" />
      </svg>
    );
  if (name === "chat")
    return (
      <svg {...common}>
        <path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8z" />
      </svg>
    );
  return (
    <svg {...common}>
      <path d="M12 5v14M5 12h14" />
    </svg>
  );
}

export function Sidebar({
  mode,
  onMode,
  courses,
  conversations,
  currentId,
  onSelect,
  onDelete,
  user,
  isAdmin,
  onLogin,
  onLogout,
  credits,
}: {
  mode: "course" | "chat" | "market" | "records";
  onMode: (m: "course" | "chat" | "market" | "records") => void;
  courses: SidebarCourse[];
  conversations: ConversationMeta[];
  currentId: string | null;
  onSelect: (id: string) => void;
  onDelete: (id: string) => void;
  user: { id: string; email: string } | null;
  isAdmin?: boolean;
  onLogin: () => void;
  onLogout: () => void;
  credits?: number | null;
}) {
  const [creditsOpen, setCreditsOpen] = useState(false);
  const navItems = [
    { key: "course", label: "首页", icon: "home" as const },
    { key: "records", label: "课程记录", icon: "library" as const },
    { key: "market", label: "精品课程", icon: "market" as const },
  ];

  return (
    <aside className="w-[248px] shrink-0 h-full border-r border-line bg-paper">
      <div className="h-full flex flex-col overflow-hidden">
        {/* 字标：衬线 Superlearn + 一个朱红句点——红笔的第一笔 */}
        <a href="/" className="px-5 pt-6 pb-5 block" aria-label="Superlearn 首页">
          <div className="font-display text-[27px] leading-none tracking-[-0.01em] text-ink">
            Superlearn<span className="text-accent">.</span>
          </div>
          <div className="mt-1.5 text-[12px] text-ink-faint tracking-[0.06em]">AI 私教 · 白板课 · 作品验收</div>
        </a>

        {/* 主导航 */}
        <nav className="px-3 space-y-0.5">
          {navItems.map((item) => {
            const active = mode === item.key;
            return (
              <button
                key={item.key}
                onClick={() => onMode(item.key as "course" | "records" | "market")}
                aria-current={active ? "page" : undefined}
                className={`relative w-full flex items-center gap-2.5 rounded-lg px-3 py-2 text-[14px] transition-colors ${
                  active ? "bg-sunken text-ink font-semibold" : "text-ink-soft hover:bg-sunken/70 hover:text-ink"
                }`}
              >
                {active && <span className="absolute left-0 top-2 bottom-2 w-[3px] rounded-full bg-accent" aria-hidden />}
                <span className={active ? "text-ink" : "text-ink-faint"}>
                  <NavIcon name={item.icon} />
                </span>
                {item.label}
              </button>
            );
          })}
          {isAdmin && (
            <a
              href="/admin"
              className="flex items-center gap-2.5 rounded-xl px-3 py-2 text-[14px] text-ink-soft hover:bg-sunken hover:text-ink transition-colors"
            >
              <span className="text-ink-faint">⚙</span>
              运营后台
            </a>
          )}
        </nav>

        {/* 继续学习（Hyperknow 同款）：最近一门课，点进课程页接着学 */}
        {courses.length > 0 && (
          <div className="mt-5 px-3">
            <div className="px-1 mb-2 text-[12px] text-ink-faint font-semibold tracking-[0.12em]">继续学习</div>
            <a
              href={`/course/${courses[0].id}`}
              className="block rounded-xl border border-line bg-surface px-3.5 py-3 shadow-card transition-all hover:-translate-y-px hover:border-ink"
            >
              <div className="text-[14px] font-semibold text-ink leading-snug line-clamp-2">{courses[0].title}</div>
              <div className="mt-1.5 text-[13px] font-medium text-accent">接着上课 →</div>
            </a>
          </div>
        )}

        {/* 历史对话 */}
        <div className="mt-5 px-4 mb-1.5 flex items-center justify-between">
          <div className="text-[12px] text-ink-faint font-semibold tracking-[0.12em]">历史对话</div>
          <button
            onClick={() => onMode("chat")}
            title="新对话"
            className="w-5 h-5 rounded-md flex items-center justify-center text-ink-faint hover:bg-accent-soft hover:text-accent transition-colors"
          >
            <NavIcon name="plus" />
          </button>
        </div>
        <div className="flex-1 min-h-0 overflow-y-auto px-2.5 space-y-0.5">
          {conversations.map((c) => (
            <div
              key={c.id}
              className={`group flex items-center rounded-xl px-3 py-2 cursor-pointer transition-colors ${
                c.id === currentId ? "bg-accent-soft/60" : "hover:bg-sunken"
              }`}
              onClick={() => onSelect(c.id)}
            >
              <div className="min-w-0 flex-1">
                <div
                  className={`text-[13px] truncate ${c.id === currentId ? "text-accent font-medium" : "text-ink"}`}
                >
                  {c.title}
                </div>
                <div className="text-[11px] text-ink-faint">
                  {new Date(c.updatedAt).toLocaleDateString("zh-CN", { month: "numeric", day: "numeric" })} · {c.messageCount} 条
                </div>
              </div>
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  onDelete(c.id);
                }}
                className="opacity-0 group-hover:opacity-100 text-ink-faint hover:text-red-600 text-[13px] px-1 transition-opacity"
                title="删除"
              >
                ×
              </button>
            </div>
          ))}
          {conversations.length === 0 && (
            <div className="mx-1 mt-1 rounded-xl border border-dashed border-line bg-sunken px-3 py-4 text-center">
              <div className="mx-auto mb-2 flex h-8 w-8 items-center justify-center rounded-full bg-accent-soft text-accent">
                <NavIcon name="chat" />
              </div>
              <div className="text-[12.5px] text-ink-soft leading-relaxed mb-2">
                学习卡住了？随时问助手，不用等下一节课
              </div>
              <button
                onClick={() => onMode("chat")}
                className="text-[12.5px] font-semibold text-accent hover:opacity-80 transition-opacity"
              >
                ＋ 发起新对话
              </button>
            </div>
          )}
        </div>

        {/* 登录态：课程记录/教材/上架跟着账号走 */}
        <div className="relative px-4 py-4 border-t border-line">
          {user ? (
            <div className="flex items-center gap-2.5">
              <div className="w-7 h-7 shrink-0 rounded-full bg-ink flex items-center justify-center text-[12px] text-white font-bold">
                {user.email[0]?.toUpperCase() || "?"}
              </div>
              <div className="min-w-0 flex-1">
                <div className="text-[13px] text-ink font-medium truncate" title={user.email}>
                  {user.email}
                </div>
                <div className="flex items-center gap-2">
                  {typeof credits === "number" && (
                    <button
                      onClick={() => setCreditsOpen((v) => !v)}
                      aria-expanded={creditsOpen}
                      className="inline-flex items-baseline gap-0.5 rounded-md px-1 -mx-1 text-[12px] text-ink-soft hover:bg-sunken transition-colors"
                      title="积分余额与明细：怎么扣的、花在哪，点开一目了然"
                    >
                      <span className="font-display text-[16px] leading-none text-accent">{credits}</span> 积分
                    </button>
                  )}
                  <button onClick={onLogout} className="text-[11.5px] text-ink-faint hover:text-red-500 transition-colors">
                    退出
                  </button>
                </div>
              </div>
            </div>
          ) : (
            <>
              <button
                onClick={onLogin}
                className="w-full rounded-xl bg-ink px-3 py-2.5 text-[13.5px] font-medium text-white hover:bg-ink/85 transition-colors"
              >
                登录 / 注册
              </button>
              <a href="/pricing" className="mt-2 block text-center text-[12px] text-ink-faint hover:text-accent">
                注册送 {NEW_USER_GRANT} 积分 · 查看积分与价格
              </a>
            </>
          )}
          {creditsOpen && user && (
            <CreditsPopover
              onClose={() => setCreditsOpen(false)}
              onChanged={() => window.dispatchEvent(new CustomEvent("ll:credits-changed"))}
            />
          )}
        </div>
      </div>
    </aside>
  );
}
