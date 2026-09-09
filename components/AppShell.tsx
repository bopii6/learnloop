"use client";

// 全站外壳：侧栏 + 登录态 + 课程/对话列表，挂在 (main) 路由组布局上。
// 导航全部走真 URL（router.push），地址栏与视图保持同步，刷新/后退/分享可用。
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { usePathname, useRouter } from "next/navigation";
import type { ConversationMeta } from "@/types";
import { Sidebar } from "./Sidebar";
import { AuthModal } from "./AuthModal";

type Mode = "course" | "chat" | "market" | "records";

export function AppShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();

  const [courses, setCourses] = useState<{ id: string; title: string }[]>([]);
  const [conversations, setConversations] = useState<ConversationMeta[]>([]);
  const [user, setUser] = useState<{ id: string; email: string } | null>(null);
  const [credits, setCredits] = useState<number | null>(null);
  const [isAdmin, setIsAdmin] = useState(false);
  const [authOpen, setAuthOpen] = useState(false);

  // / 与 /course/* 都算「首页」态（课程详情是首页入口的延伸，侧栏点亮首页）
  const mode: Mode = pathname.startsWith("/records")
    ? "records"
    : pathname.startsWith("/market")
      ? "market"
      : pathname.startsWith("/chat")
        ? "chat"
        : "course";
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
        setCredits(typeof d?.credits === "number" ? d.credits : null);
        setIsAdmin(Boolean(d?.isAdmin));
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    refreshList();
    refreshCourses();
    refreshMe();
  }, [refreshList, refreshCourses, refreshMe]);

  // 子页面/生成器通过事件通知外壳刷新列表（积分扣减 → 余额；建课 → 课程计数；建对话 → 历史列表）
  useEffect(() => {
    const onCredits = () => refreshMe();
    const onCourses = () => refreshCourses();
    const onConversations = () => refreshList();
    window.addEventListener("ll:credits-changed", onCredits);
    window.addEventListener("ll:courses-changed", onCourses);
    window.addEventListener("ll:conversations-changed", onConversations);
    return () => {
      window.removeEventListener("ll:credits-changed", onCredits);
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
        credits={credits}
      />

      <main className="flex-1 flex flex-col min-w-0 overflow-hidden">{children}</main>

      {authOpen && (
        <AuthModal
          onClose={() => setAuthOpen(false)}
          onLoggedIn={(u) => {
            setUser(u);
            setAuthOpen(false);
            // 登录后课程列表与积分余额按归属变化，刷新
            refreshMe();
            refreshCourses();
            refreshList();
          }}
        />
      )}
    </div>
  );
}
