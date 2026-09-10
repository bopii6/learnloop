"use client";

// 侧栏：浮动圆角白卡，导航 + 继续学习 + 历史。
// 图标统一用内联 SVG 线性图标（stroke=currentColor），选中态走品牌绿。
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
    <aside className="w-64 shrink-0 h-full p-3">
      <div className="h-full rounded-3xl bg-white/92 backdrop-blur border border-[#eadfc8] shadow-[0_10px_36px_rgba(90,62,20,0.09)] flex flex-col overflow-hidden">
        {/* Logo：上升台阶 + 星芒（与 favicon 同一图形） */}
        <div className="px-4 pt-4 pb-3.5 flex items-center gap-2.5">
          <div className="w-8 h-8 rounded-xl bg-accent flex items-center justify-center text-white shadow-[0_4px_12px_rgb(var(--accent-rgb)/0.35)] rotate-[-3deg]">
            <svg viewBox="0 0 24 24" fill="currentColor" className="h-[17px] w-[17px]" aria-hidden>
              <rect x="3.6" y="13.6" width="4.4" height="7" rx="1.2" />
              <rect x="9.8" y="10.2" width="4.4" height="10.4" rx="1.2" />
              <rect x="16" y="6.8" width="4.4" height="13.8" rx="1.2" />
              <path d="M18.2 1.2l0.9 1.9 1.9 0.9-1.9 0.9-0.9 1.9-0.9-1.9-1.9-0.9 1.9-0.9z" />
            </svg>
          </div>
          <div>
            <span className="font-extrabold text-[15.5px] tracking-tight text-ink">Superlearn</span>
            <div className="text-[9.5px] text-ink-faint tracking-[0.14em] leading-none mt-0.5">AI 白板讲师</div>
          </div>
        </div>

        {/* 主导航 */}
        <nav className="px-2.5 space-y-1">
          {navItems.map((item) => {
            const active = mode === item.key;
            return (
              <button
                key={item.key}
                onClick={() => onMode(item.key as "course" | "records" | "market")}
                className={`w-full flex items-center gap-2.5 rounded-xl px-3 py-2 text-[13px] transition-colors ${
                  active
                    ? "bg-accent-soft text-accent font-semibold shadow-[inset_0_0_0_1.5px_#ecc794]"
                    : "text-ink-soft hover:bg-[#faf4e8] hover:text-ink"
                }`}
              >
                <span className={active ? "text-accent" : "text-ink-faint"}>
                  <NavIcon name={item.icon} />
                </span>
                {item.label}
              </button>
            );
          })}
          {isAdmin && (
            <a
              href="/admin"
              className="flex items-center gap-2.5 rounded-xl px-3 py-2 text-[13px] text-ink-soft hover:bg-[#faf4e8] hover:text-ink transition-colors"
            >
              <span className="text-ink-faint">⚙</span>
              运营后台
            </a>
          )}
        </nav>

        {/* 历史对话 */}
        <div className="mt-5 px-4 mb-1.5 flex items-center justify-between">
          <div className="text-[11px] text-ink-faint font-medium tracking-wider">历史对话</div>
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
                c.id === currentId ? "bg-accent-soft/70" : "hover:bg-[#faf4e8]"
              }`}
              onClick={() => onSelect(c.id)}
            >
              <div className="min-w-0 flex-1">
                <div
                  className={`text-[12px] truncate ${c.id === currentId ? "text-accent font-medium" : "text-ink"}`}
                >
                  {c.title}
                </div>
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
            <div className="mx-1 mt-1 rounded-xl border border-dashed border-[#e2d3b4] bg-[#fdf8ec] px-3 py-4 text-center">
              <div className="mx-auto mb-2 flex h-8 w-8 items-center justify-center rounded-full bg-accent-soft text-accent">
                <NavIcon name="chat" />
              </div>
              <div className="text-[11.5px] text-ink-soft leading-relaxed mb-2">
                学习卡住了？随时问助手，不用等下一节课
              </div>
              <button
                onClick={() => onMode("chat")}
                className="text-[11.5px] font-semibold text-accent hover:opacity-80 transition-opacity"
              >
                ＋ 发起新对话
              </button>
            </div>
          )}
        </div>

        {/* 登录态：课程记录/教材/上架跟着账号走 */}
        <div className="relative px-3.5 py-3.5 border-t border-dashed border-[#eadfc8]">
          {user ? (
            <div className="flex items-center gap-2.5">
              <div className="w-7 h-7 shrink-0 rounded-full bg-accent flex items-center justify-center text-[11px] text-white font-bold">
                {user.email[0]?.toUpperCase() || "?"}
              </div>
              <div className="min-w-0 flex-1">
                <div className="text-[12px] text-ink font-medium truncate" title={user.email}>
                  {user.email}
                </div>
                <div className="flex items-center gap-2">
                  {typeof credits === "number" && (
                    <button
                      onClick={() => setCreditsOpen((v) => !v)}
                      aria-expanded={creditsOpen}
                      className="rounded-full bg-accent-soft px-1.5 py-px text-[10px] font-semibold text-accent hover:opacity-80 transition-opacity"
                      title="积分余额与明细：怎么扣的、花在哪，点开一目了然"
                    >
                      ⚡ {credits} 积分
                    </button>
                  )}
                  <button onClick={onLogout} className="text-[10.5px] text-ink-faint hover:text-red-500 transition-colors">
                    退出
                  </button>
                </div>
              </div>
            </div>
          ) : (
            <button
              onClick={onLogin}
              className="w-full rounded-xl bg-accent px-3 py-2.5 text-[12.5px] font-medium text-white shadow-sm hover:bg-[#c24e08] transition-colors"
            >
              登录 / 注册
            </button>
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
