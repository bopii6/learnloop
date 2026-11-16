"use client";

// 全站外壳：侧栏 + 登录态 + 课程/对话列表，挂在 (main) 路由组布局上。
// 导航全部走真 URL（router.push），地址栏与视图保持同步，刷新/后退/分享可用。
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { usePathname, useRouter } from "next/navigation";
import type { ConversationMeta } from "@/types";
import { Sidebar } from "./Sidebar";
import { AuthModal } from "./AuthModal";

type Mode = "course" | "chat" | "market" | "records" | "other";

export function AppShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();

  const [courses, setCourses] = useState<{ id: string; title: string }[]>([]);
  const [conversations, setConversations] = useState<ConversationMeta[]>([]);
  const [user, setUser] = useState<{ id: string; email: string } | null>(null);
  const [isAdmin, setIsAdmin] = useState(false);
  const [authOpen, setAuthOpen] = useState(false);

  // / 与 /course/* 的归属：课程详情页是"我的课"的深入，点亮「课程记录」更符合用户心智
  //（此前点亮「首页」，用户在课程页里找不到自己的位置）
  const mode: Mode = pathname.startsWith("/records") || pathname.startsWith("/course/")
    ? "records"
    : pathname.startsWith("/market")
      ? "market"
      : pathname.startsWith("/chat")
        ? "chat"
        : pathname === "/"
          ? "course"
          : "other"; // 定价 / 法务 / 后台等：侧栏不点亮任何主导航
  const chatId = mode === "chat" && pathname.length > "/chat/".length ? pathname.slice("/chat/".length) : null;

  const refreshList = useCallback(async () => {
    const res = await fetch("/api/conversations");
    const data = await res.json();
    setConversations(data.conversations || []);
  }, []);

  const refreshCourses = useCallback(async () => {
    try {
      const res = await fetch("/api/courses");
      if (res.ok) {
        const d = await res.json();
        setCourses(d.courses || []);
      }
    } catch {
      // 静默
    }
  }, []);

  const refreshMe = useCallback(() => {
    fetch("/api/auth/me")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        setUser(d?.user || null);
        setIsAdmin(Boolean(d?.isAdmin));
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    refreshList();
    refreshCourses();
    refreshMe();
  }, [refreshList, refreshCourses, refreshMe]);

  // 子页面/生成器通过事件通知外壳刷新列表（建课 → 课程计数；建对话 → 历史列表；需要登录 → 弹登录框）
  useEffect(() => {
    const onCourses = () => refreshCourses();
    const onConversations = () => refreshList();
    const onOpenLogin = () => setAuthOpen(true);
    window.addEventListener("ll:open-login", onOpenLogin);
    window.addEventListener("ll:courses-changed", onCourses);
    window.addEventListener("ll:conversations-changed", onConversations);
    return () => {
      window.removeEventListener("ll:open-login", onOpenLogin);
      window.removeEventListener("ll:courses-changed", onCourses);
      window.removeEventListener("ll:conversations-changed", onConversations);
    };
  }, [refreshMe, refreshCourses, refreshList]);

  const logout = useCallback(async () => {
    await fetch("/api/auth/me", { method: "POST" }).catch(() => {});
    setUser(null);
    refreshCourses();
    refreshList();
  }, [refreshCourses, refreshList]);

  const deleteConv = useCallback(
    async (id: string) => {
      await fetch(`/api/conversations/${id}`, { method: "DELETE" });
      if (id === chatId) router.push("/chat");
      refreshList();
    },
    [chatId, refreshList, router]
  );

  return (
    <div className="flex h-screen home-bg">
      <Sidebar
        mode={mode}
        onMode={(m) => router.push(m === "course" ? "/" : `/${m}`)}
        courses={courses}
        conversations={conversations}
        currentId={chatId}
        onSelect={(id) => router.push(`/chat/${id}`)}
        onDelete={(id) => void deleteConv(id)}
        user={user}
        isAdmin={isAdmin}
        onLogin={() => setAuthOpen(true)}
        onLogout={() => void logout()}
      />

      <main className="flex-1 flex flex-col min-w-0 overflow-hidden">{children}</main>

      {authOpen && (
        <AuthModal
          onClose={() => setAuthOpen(false)}
          onLoggedIn={(u) => {
            setUser(u);
            setAuthOpen(false);
            // 登录后课程列表按归属变化，刷新
            refreshMe();
            refreshCourses();
            refreshList();
            // 通知正在等登录的页面（如生成到一半被拦下的课程）继续
            window.dispatchEvent(new CustomEvent("ll:logged-in"));
          }}
        />
      )}
    </div>
  );
}
